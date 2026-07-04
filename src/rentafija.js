// Lógica de Renta Fija (Obligaciones Negociables + Bonos).
// Es pura y explicable: clasifica especies, convierte pesos->USD par con el
// MEP implícito de los boletos, netea posiciones (compras - ventas), calcula
// costo promedio en USD, valor actual, ganancia de capital, renta cobrada y
// el rendimiento total. NO es asesoramiento: son datos para decidir.

const r2 = (n) => Math.round(n * 100) / 100;
const r4 = (n) => Math.round(n * 10000) / 10000;
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

// ---------- Monedas ----------
export function isUsd(moneda) {
  return /d[oó]lar|dollar|cable|u\$s|usd/i.test(String(moneda || ''));
}
export function isPeso(moneda) {
  return /peso/i.test(String(moneda || '')) || (!isUsd(moneda) && String(moneda || '').trim() !== '');
}

// ---------- Clasificación de especie ----------
// Devuelve la clase del instrumento a partir del texto de "Especie" y el ticker.
//   'ON'     -> obligación negociable (renta fija)
//   'Bono'   -> bono soberano / BOPREAL (renta fija)
//   'CEDEAR' -> renta variable (no se toca acá)
//   'Accion' -> acción local (renta variable)
//   null     -> caución / apertura colocadora / sin ticker (se ignora)
export function classify(especie, ticker) {
  const e = String(especie || '').toUpperCase().trim();
  const t = String(ticker || '').toUpperCase().trim();
  if (!t || e.startsWith('APERTURA') || e.startsWith('LICITAC')) return null;
  if (e.startsWith('CEDEAR')) return 'CEDEAR';
  if (e.startsWith('BOPREAL') || e.startsWith('BONO')) return 'Bono';
  if (e.startsWith('ON')) return 'ON';
  // ONs con prefijo del emisor (YPF…O, MSU→RUCDO, etc.): ticker termina en "O".
  if (/O$/.test(t) && t.length >= 4) return 'ON';
  return 'Accion';
}
export const isRF = (clase) => clase === 'ON' || clase === 'Bono';

// Nombre del emisor a partir de la especie (limpia el prefijo del tipo).
export function emisorFrom(especie) {
  let e = String(especie || '').trim();
  e = e.replace(/^(ON|BONOS?|BOPREAL)\s+/i, '');
  return e || '—';
}

// ---------- MEP implícito ----------
// Cuando el mismo instrumento se operó el mismo día en pesos y en dólares,
// el cociente (precio pesos / precio USD) es el tipo de cambio implícito.
export function buildMepIndex(trades) {
  const byKey = {};
  for (const tr of trades) {
    if (!(Number(tr.precio) > 0)) continue;
    const k = `${tr.fecha}|${tr.ticker}`;
    (byKey[k] ??= []).push(tr);
  }
  const perDate = {};
  for (const k of Object.keys(byKey)) {
    const arr = byKey[k];
    const pesos = arr.filter((x) => isPeso(x.moneda)).map((x) => Number(x.precio));
    const usd = arr.filter((x) => isUsd(x.moneda)).map((x) => Number(x.precio));
    if (pesos.length && usd.length) {
      const pu = avg(usd);
      if (pu > 0) {
        const date = k.split('|')[0];
        (perDate[date] ??= []).push(avg(pesos) / pu);
      }
    }
  }
  const index = {};
  for (const d of Object.keys(perDate)) index[d] = avg(perDate[d]);
  return index;
}

// MEP para una fecha: exacto, o el de la fecha más cercana; si no hay, fallback.
export function mepFor(index, date, fallback) {
  if (index[date]) return index[date];
  const keys = Object.keys(index);
  if (!keys.length) return fallback;
  const td = Date.parse(date);
  let best = keys[0], bestD = Infinity;
  for (const k of keys) {
    const dd = Math.abs(Date.parse(k) - td);
    if (dd < bestD) { bestD = dd; best = k; }
  }
  return index[best];
}

// Fallback global de MEP: promedio del índice, o 1000 si no hay nada.
export function fallbackMep(index) {
  const vals = Object.values(index);
  return vals.length ? avg(vals) : 1000;
}

// Precio por nominal en USD par de un boleto.
export function precioUsdOf(trade, index, fb) {
  const p = Number(trade.precio) || 0;
  if (isUsd(trade.moneda)) return p;
  const mep = mepFor(index, trade.fecha, fb);
  return mep > 0 ? p / mep : 0;
}
// Neto (monto) en USD de un boleto.
export function netoUsdOf(trade, index, fb) {
  const n = Number(trade.neto) || 0;
  if (isUsd(trade.moneda)) return n;
  const mep = mepFor(index, trade.fecha, fb);
  return mep > 0 ? n / mep : 0;
}

// Agrega precio_usd y neto_usd a cada boleto de renta fija (para guardar).
export function enrichTrades(rawTrades) {
  const rf = rawTrades
    .map((t) => ({ ...t, clase: t.clase || classify(t.especie, t.ticker) }))
    .filter((t) => isRF(t.clase));
  const index = buildMepIndex(rf);
  const fb = fallbackMep(index);
  return rf.map((t) => ({
    ...t,
    emisor: t.emisor || emisorFrom(t.especie),
    precio_usd: r4(precioUsdOf(t, index, fb)),
    neto_usd: r2(netoUsdOf(t, index, fb)),
  }));
}

// ---------- Cómputo de la cartera de renta fija ----------
// trades: [{ ticker, clase, emisor, side('COMPRA'|'VENTA'), cantidad, precio_usd, neto_usd, fecha }]
// prices: { TICKER: { price, source, updated_at } }  (precio actual en USD par)
// payments: [{ ticker, fecha(YYYY-MM-DD), renta, amortizacion, total }]
export function computePortfolio({ trades = [], prices = {}, payments = [], today } = {}) {
  const hoy = today || new Date().toISOString().slice(0, 10);

  // Agrupar boletos por ticker.
  const byTicker = {};
  for (const t of trades) {
    if (!isRF(t.clase)) continue;
    (byTicker[t.ticker] ??= []).push(t);
  }

  // Renta cobrada / próximos pagos por ticker.
  const paidByTicker = {}, nextByTicker = {};
  for (const p of payments) {
    const tk = String(p.ticker || '').toUpperCase().trim();
    const renta = Number(p.renta) || 0, amort = Number(p.amortizacion) || 0;
    if (String(p.fecha) <= hoy) {
      const g = (paidByTicker[tk] ??= { renta: 0, amort: 0 });
      g.renta += renta; g.amort += amort;
    } else if (!nextByTicker[tk] || String(p.fecha) < nextByTicker[tk].fecha) {
      nextByTicker[tk] = { fecha: String(p.fecha), renta, amort, total: Number(p.total) || renta + amort };
    }
  }

  let comprasUsd = 0, ventasUsd = 0, valorActual = 0, costoTenencia = 0, rentaCobrada = 0, sinPrecio = 0;
  const rows = [];

  for (const tk of Object.keys(byTicker)) {
    const arr = byTicker[tk];
    const buys = arr.filter((x) => x.side === 'COMPRA');
    const sells = arr.filter((x) => x.side === 'VENTA');
    const nomBuy = buys.reduce((a, x) => a + (Number(x.cantidad) || 0), 0);
    const nomSell = sells.reduce((a, x) => a + (Number(x.cantidad) || 0), 0);
    const vn = nomBuy - nomSell;

    const buyCostUsd = buys.reduce((a, x) => a + (Number(x.cantidad) || 0) * (Number(x.precio_usd) || 0), 0);
    const avgCostUsd = nomBuy > 0 ? buyCostUsd / nomBuy : 0;

    comprasUsd += buys.reduce((a, x) => a + (Number(x.neto_usd) || 0), 0);
    ventasUsd += sells.reduce((a, x) => a + (Number(x.neto_usd) || 0), 0);

    const paid = paidByTicker[tk] || { renta: 0, amort: 0 };
    rentaCobrada += paid.renta;

    if (vn <= 0) continue; // posición cerrada: no aparece en tenencias

    const pr = prices[tk] || null;
    const price = pr && Number(pr.price) > 0 ? Number(pr.price) : null;
    const invertido = r2(avgCostUsd * vn);
    // Sin precio de mercado: se valúa al costo (ganancia 0) para no distorsionar
    // el total; el UI marca la posición como "sin precio" para que la cargues.
    const valor = price != null ? r2(vn * price) : invertido;
    const ganCap = price != null ? r2(vn * (price - avgCostUsd)) : 0;

    costoTenencia += invertido;
    valorActual += valor;
    if (price == null) sinPrecio++;

    rows.push({
      ticker: tk,
      clase: arr[0].clase,
      emisor: arr[0].emisor || '',
      vn: r2(vn),
      precioCompra: r4(avgCostUsd),
      precioActual: price != null ? r4(price) : null,
      precioSource: pr ? pr.source : null,
      valorActual: valor,
      ganCapital: ganCap,
      ganCapitalPct: price != null && avgCostUsd > 0 ? r2((price - avgCostUsd) / avgCostUsd * 100) : null,
      rentaCobrada: r2(paid.renta),
      amortCobrada: r2(paid.amort),
      proximoPago: nextByTicker[tk] || null,
    });
  }

  rows.sort((a, b) => (b.valorActual || 0) - (a.valorActual || 0));

  const capitalAportado = r2(comprasUsd - ventasUsd - rentaCobrada);
  const gananciaCapital = r2(valorActual - costoTenencia);
  const gananciaTotal = r2(valorActual - capitalAportado);
  const rendimientoPct = capitalAportado > 0 ? r2(gananciaTotal / capitalAportado * 100) : null;

  return {
    rows,
    totals: {
      capitalAportado,
      valorActual: r2(valorActual),
      costoTenencia: r2(costoTenencia),
      gananciaCapital,
      rentaCobrada: r2(rentaCobrada),
      gananciaTotal,
      rendimientoPct,
      posiciones: rows.length,
      sinPrecio,
      comprasUsd: r2(comprasUsd),
      ventasUsd: r2(ventasUsd),
    },
  };
}

// Renta futura agrupada por mes (para el gráfico), desde hoy hacia adelante.
export function monthlyRenta(payments = [], { today, months = 12 } = {}) {
  const hoy = today || new Date().toISOString().slice(0, 10);
  const buckets = {};
  for (const p of payments) {
    const f = String(p.fecha || '');
    if (f <= hoy) continue;
    const ym = f.slice(0, 7);
    const g = (buckets[ym] ??= { ym, renta: 0, amort: 0, total: 0 });
    g.renta += Number(p.renta) || 0;
    g.amort += Number(p.amortizacion) || 0;
    g.total += Number(p.total) || (Number(p.renta) || 0) + (Number(p.amortizacion) || 0);
  }
  return Object.values(buckets)
    .sort((a, b) => a.ym.localeCompare(b.ym))
    .slice(0, months)
    .map((b) => ({ ym: b.ym, renta: r2(b.renta), amort: r2(b.amort), total: r2(b.total) }));
}

// Próximos cupones (lista), desde hoy.
export function upcomingPayments(payments = [], { today, limit = 12 } = {}) {
  const hoy = today || new Date().toISOString().slice(0, 10);
  return payments
    .filter((p) => String(p.fecha) >= hoy)
    .sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)))
    .slice(0, limit)
    .map((p) => {
      const renta = Number(p.renta) || 0, amort = Number(p.amortizacion) || 0;
      const tipo = renta > 0 && amort > 0 ? 'renta + amort.' : amort > 0 ? 'amortización' : 'renta';
      return { ticker: p.ticker, fecha: String(p.fecha), total: r2(Number(p.total) || renta + amort), tipo };
    });
}
