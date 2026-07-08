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

// ---------- Renta cobrada histórica (de "movimientos") ----------
// Cada cupón viene en dos patas el mismo día: una positiva en dólares (lo
// cobrado) y una negativa en pesos (la conversión). Tomamos la pata positiva
// en dólares de las filas "Renta" / "Renta y Amortización".
export function extractIncome(rawRows = []) {
  const out = [];
  for (const r of rawRows) {
    const desc = String(r.descripcion || r.Descripcion || '');
    const ticker = String(r.ticker || r.Ticker || '').toUpperCase().trim();
    const moneda = r.moneda || r.Moneda || '';
    const importe = Number(r.importe ?? r.Importe) || 0;
    const fecha = r.fecha || r.Concertacion || null;
    if (!ticker || !(importe > 0) || !isUsd(moneda)) continue;
    if (/^Renta y Amortizaci/i.test(desc)) out.push({ ticker, fecha: ymd(fecha), importe, tipo: 'ramort' });
    else if (/^Renta\b/i.test(desc)) out.push({ ticker, fecha: ymd(fecha), importe, tipo: 'renta' });
  }
  return out;
}
function ymd(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

// TIR (tasa interna de retorno anual) por bisección: resuelve la tasa que hace
// que el valor presente de los flujos futuros iguale el precio de hoy.
// cashflows: [{ fecha, monto }] futuros (renta + amortización).
export function tirOf({ price, vn, cashflows = [], today }) {
  if (!(price > 0) || !(vn > 0) || !cashflows.length) return null;
  const t0 = Date.parse(today);
  const npv = (r) => {
    let s = -price * vn;
    for (const c of cashflows) {
      const yrs = (Date.parse(c.fecha) - t0) / (365.25 * 86400000);
      if (yrs <= 0) continue;
      s += c.monto / Math.pow(1 + r, yrs);
    }
    return s;
  };
  let lo = -0.9, hi = 3, flo = npv(lo), fhi = npv(hi);
  if (!(flo * fhi < 0)) return null; // sin raíz en el rango
  for (let i = 0; i < 90; i++) {
    const mid = (lo + hi) / 2, fm = npv(mid);
    if (Math.abs(fm) < 1e-7) return Math.round(mid * 10000) / 100;
    if (flo * fm < 0) { hi = mid; } else { lo = mid; flo = fm; }
  }
  return Math.round(((lo + hi) / 2) * 10000) / 100;
}

// ---------- Cómputo de la cartera de renta fija ----------
// trades: [{ ticker, clase, emisor, side('COMPRA'|'VENTA'), cantidad, precio_usd, neto_usd, fecha }]
// prices: { TICKER: { price, source, updated_at } }  (precio actual en USD par)
// payments: [{ ticker, fecha(YYYY-MM-DD), renta, amortizacion, total }]
// restrictTo (opcional): Set de tickers vigentes (los del cronograma). Si se
// pasa, sólo se consideran esas especies (más las cargadas a mano), así las
// ONs/bonos que ya no tenés desaparecen al subir un cronograma nuevo.
export function computePortfolio({ trades = [], prices = {}, payments = [], income = [], today, restrictTo = null } = {}) {
  const hoy = today || new Date().toISOString().slice(0, 10);

  // Tickers agregados a mano: siempre se muestran aunque no estén en el cronograma.
  const manualTickers = new Set(trades.filter((t) => t.source === 'manual').map((t) => t.ticker));
  const allowed = restrictTo && restrictTo.size
    ? (tk) => restrictTo.has(tk) || manualTickers.has(tk)
    : () => true;

  // Agrupar boletos por ticker.
  const byTicker = {};
  for (const t of trades) {
    if (!isRF(t.clase)) continue;
    if (!allowed(t.ticker)) continue;
    (byTicker[t.ticker] ??= []).push(t);
  }

  // Próximos pagos por ticker (del cronograma, a futuro).
  const nextByTicker = {};
  for (const p of payments) {
    const tk = String(p.ticker || '').toUpperCase().trim();
    const renta = Number(p.renta) || 0, amort = Number(p.amortizacion) || 0;
    if (String(p.fecha) > hoy && (!nextByTicker[tk] || String(p.fecha) < nextByTicker[tk].fecha)) {
      nextByTicker[tk] = { fecha: String(p.fecha), renta, amort, total: Number(p.total) || renta + amort };
    }
  }
  // Vencimiento + flujos futuros por ticker (para TIR).
  const vtoByTicker = {}, cashflowsByTicker = {};
  for (const p of payments) {
    const tk = String(p.ticker || '').toUpperCase().trim();
    const f = String(p.fecha);
    if (!vtoByTicker[tk] || f > vtoByTicker[tk]) vtoByTicker[tk] = f;
    if (f > hoy) (cashflowsByTicker[tk] ??= []).push({ fecha: f, monto: Number(p.total) || (Number(p.renta) || 0) + (Number(p.amortizacion) || 0) });
  }

  // Renta cobrada por ticker: de "movimientos" (income) si hay; si no, del
  // cronograma con fecha pasada (fallback).
  const paidByTicker = {};
  if (income.length) {
    for (const inc of income) {
      const tk = String(inc.ticker || '').toUpperCase().trim();
      const g = (paidByTicker[tk] ??= { renta: 0, amort: 0 });
      if (inc.tipo === 'ramort') g.amort += Number(inc.importe) || 0;
      else g.renta += Number(inc.importe) || 0;
    }
  } else {
    for (const p of payments) {
      if (String(p.fecha) > hoy) continue;
      const tk = String(p.ticker || '').toUpperCase().trim();
      const g = (paidByTicker[tk] ??= { renta: 0, amort: 0 });
      g.renta += Number(p.renta) || 0; g.amort += Number(p.amortizacion) || 0;
    }
  }

  let comprasUsd = 0, ventasUsd = 0, valorActual = 0, costoTenencia = 0, rentaCobrada = 0, sinPrecio = 0, escalaRara = 0, amortReturned = 0;
  const rows = [];

  // Amortización de capital ya pagada por ticker (del cronograma, fecha pasada).
  // En par ≈ 1 USD/nominal, así que el importe ≈ nominales devueltos.
  const amortPastByTicker = {};
  for (const p of payments) {
    if (String(p.fecha) <= hoy) {
      const tk = String(p.ticker || '').toUpperCase().trim();
      amortPastByTicker[tk] = (amortPastByTicker[tk] || 0) + (Number(p.amortizacion) || 0);
    }
  }

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
    const amortPast = amortPastByTicker[tk] || 0;
    amortReturned += amortPast;
    const vnVigente = Math.max(0, vn - amortPast); // capital devuelto baja el VN

    if (vnVigente <= 0) continue; // sin nominales vigentes (vendido/amortizado)

    // Antigüedad de la posición (desde la primera compra) para anualizar.
    const buyDates = buys.map((x) => x.fecha).filter(Boolean)
      .map((f) => f instanceof Date ? f.toISOString().slice(0, 10) : String(f).slice(0, 10)).sort();
    const primeraCompra = buyDates[0] || null;
    const aniosTenido = primeraCompra
      ? Math.max(0.08, (Date.parse(hoy) - Date.parse(primeraCompra)) / (365.25 * 24 * 3600 * 1000))
      : null;

    const pr = prices[tk] || null;
    // Red de seguridad: un ON/bono cotiza en USD par (~0,2 a ~1,5 por nominal).
    // Un precio > 5 es casi seguro un error de escala (quedó en pesos / sin
    // dividir por el MEP): lo ignoramos y valuamos al costo en vez de mostrar
    // un número absurdo.
    const raw = pr && Number(pr.price) > 0 ? Number(pr.price) : null;
    const price = raw != null && raw < 5 ? raw : null;
    const priceOffScale = raw != null && raw >= 5;
    const invertido = r2(avgCostUsd * vnVigente);
    // Sin precio de mercado: se valúa al costo (ganancia 0) para no distorsionar
    // el total; el UI marca la posición como "sin precio" para que la cargues.
    const valor = price != null ? r2(vnVigente * price) : invertido;
    const ganCap = price != null ? r2(vnVigente * (price - avgCostUsd)) : 0;

    costoTenencia += invertido;
    valorActual += valor;
    if (price == null) sinPrecio++;
    if (priceOffScale) escalaRara++;

    // TIR (con salvaguarda): si los flujos futuros no alcanzan a recuperar lo
    // invertido (precio × VN), el cronograma está incompleto —típico cuando
    // falta la amortización del capital, o el VN no bajó por amortizaciones ya
    // pagadas—. En ese caso la TIR sería engañosamente baja, así que la anulamos
    // y avisamos.
    const cf = cashflowsByTicker[tk] || [];
    const sumCf = cf.reduce((a, c) => a + (Number(c.monto) || 0), 0);
    let tir = price != null ? tirOf({ price, vn: vnVigente, cashflows: cf, today: hoy }) : null;
    let tirNota = null;
    if (price != null && cf.length && sumCf < price * vnVigente * 0.98) { tirNota = 'cronograma incompleto (¿falta amortización?)'; tir = null; }

    rows.push({
      ticker: tk,
      clase: arr[0].clase,
      emisor: arr[0].emisor || '',
      vn: r2(vnVigente),
      vnOriginal: r2(vn),
      amortizado: r2(amortPast),
      precioCompra: r4(avgCostUsd),
      precioActual: price != null ? r4(price) : null,
      precioSource: pr ? pr.source : null,
      valorActual: valor,
      ganCapital: ganCap,
      ganCapitalPct: price != null && avgCostUsd > 0 ? r2((price - avgCostUsd) / avgCostUsd * 100) : null,
      rentaCobrada: r2(paid.renta),
      amortCobrada: r2(paid.amort),
      proximoPago: nextByTicker[tk] || null,
      primeraCompra,
      aniosTenido: aniosTenido != null ? r2(aniosTenido) : null,
      diasTenido: primeraCompra ? Math.max(0, Math.round((Date.parse(hoy) - Date.parse(primeraCompra)) / 86400000)) : null,
      vencimiento: vtoByTicker[tk] || null,
      diasVto: vtoByTicker[tk] ? Math.round((Date.parse(vtoByTicker[tk]) - Date.parse(hoy)) / 86400000) : null,
      aniosVto: vtoByTicker[tk] ? r2(Math.round((Date.parse(vtoByTicker[tk]) - Date.parse(hoy)) / 86400000) / 365.25) : null,
      tir, tirNota,
      liquidez: pr && pr.liquidez ? pr.liquidez : null,
      volumen: pr && pr.volumen != null ? pr.volumen : null,
    });
  }

  rows.sort((a, b) => (b.valorActual || 0) - (a.valorActual || 0));

  const capitalAportado = r2(comprasUsd - ventasUsd - rentaCobrada - amortReturned);
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
      amortCobrada: r2(amortReturned),
      gananciaTotal,
      rendimientoPct,
      posiciones: rows.length,
      sinPrecio,
      escalaRara,
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

// Renta (y amortización) YA COBRADA, agrupada por año calendario. Sale de los
// "movimientos" (income) que tienen fecha. Sirve para ver cuánto rindió cada año.
export function rentaByYear(income = []) {
  const buckets = {};
  for (const inc of income) {
    const y = String(inc.fecha || '').slice(0, 4);
    if (!/^\d{4}$/.test(y)) continue;
    const g = (buckets[y] ??= { year: y, renta: 0, amort: 0 });
    if (inc.tipo === 'ramort') g.amort += Number(inc.importe) || 0;
    else g.renta += Number(inc.importe) || 0;
  }
  return Object.values(buckets)
    .sort((a, b) => a.year.localeCompare(b.year))
    .map((b) => ({ year: b.year, renta: r2(b.renta), amort: r2(b.amort), total: r2(b.renta + b.amort) }));
}

// Sugerencia: reforzar los meses con renta más baja. Mira la renta por mes y,
// para los meses "valle", propone las especies (tuyas o del catálogo) que pagan
// en ese mes, con su rating y mínimo de nominales.
export function suggestReinforce({ payments = [], rows = [], catalog = [], prices = {}, guide = {}, monto = 0, today, months = 12 } = {}) {
  const hoy = today || new Date().toISOString().slice(0, 10);
  const monthly = monthlyRenta(payments, { today: hoy, months });
  const heldSet = new Set(rows.map((r) => r.ticker));
  const catByTk = {};
  for (const c of catalog) catByTk[String(c.ticker).toUpperCase().trim()] = c;
  const curMonth = hoy.slice(0, 7);
  const payMonths = {};       // ym futuros (para detectar valles)
  const payMonthNums = {};    // meses del año en que paga (patrón recurrente)
  for (const p of payments) {
    const tk = String(p.ticker).toUpperCase().trim();
    const ym = String(p.fecha).slice(0, 7);
    if (Number(p.renta) > 0) (payMonthNums[tk] ??= new Set()).add(String(p.fecha).slice(5, 7));
    if (ym < curMonth) continue;
    (payMonths[tk] ??= new Set()).add(ym);
  }
  const g = (tk) => guide[String(tk).toUpperCase().trim()] || null;
  const rank = { Comprar: 0, Mantener: 1, Vender: 3 };
  const rowByTk = {};
  for (const r of rows) rowByTk[r.ticker] = r;
  const enrich = (tk) => {
    const c = catByTk[tk], gg = g(tk), row = rowByTk[tk];
    const precio = prices[tk] && Number(prices[tk].price) > 0 ? Number(prices[tk].price) : null;
    const minN = c ? Number(c.min_nominales) || 0 : 0;
    const nominales = (monto > 0 && precio) ? Math.floor(monto / precio) : null;
    return {
      ticker: tk, held: heldSet.has(tk), rating: c?.rating || '', minNominales: minN,
      emisor: c?.emisor || row?.emisor || '',
      clase: c?.clase || row?.clase || '',
      senal: gg ? gg.senal : null, perfil: gg ? gg.perfil : null, enGuia: !!gg,
      precio, nominales, alcanzaMinimo: nominales == null ? null : (nominales >= minN),
      mesesPago: payMonthNums[tk] ? [...payMonthNums[tk]].sort() : [],
      tir: row ? row.tir ?? null : null,
      tirNota: row ? row.tirNota || null : null,
      liquidez: prices[tk] ? prices[tk].liquidez || null : null,
    };
  };
  const avg = monthly.length ? monthly.reduce((a, m) => a + m.total, 0) / monthly.length : 0;
  const umbral = avg * 0.75;
  const low = monthly.filter((m) => m.total < umbral).sort((a, b) => a.total - b.total);
  const suggestions = low.map((m) => {
    const candidatos = Object.keys(payMonths).filter((tk) => payMonths[tk].has(m.ym)).map(enrich);
    candidatos.sort((a, b) => (rank[a.senal] ?? 2) - (rank[b.senal] ?? 2) || (a.held === b.held ? 0 : a.held ? -1 : 1) || String(a.rating).localeCompare(String(b.rating)));
    return { ym: m.ym, total: m.total, candidatos };
  });
  // Lista principal: las "Comprar" de renta fija según tu guía (tengas o no).
  const lowSet = new Set(low.map((m) => m.ym));
  const comprar = Object.keys(guide)
    .filter((tk) => guide[tk].seccion === 'RF' && guide[tk].senal === 'Comprar')
    .map((tk) => {
      const e = enrich(tk);
      const meses = payMonths[tk] ? [...payMonths[tk]].filter((ym) => lowSet.has(ym)) : [];
      return { ...e, nombre: guide[tk].nombre || '', emisor: e.emisor || guide[tk].nombre || '', llenaMesFlojo: meses };
    })
    .sort((a, b) => (b.llenaMesFlojo.length - a.llenaMesFlojo.length) || (a.held === b.held ? 0 : a.held ? -1 : 1) || String(a.rating).localeCompare(String(b.rating)));

  // Alertas cruzando con la guía.
  const alertasVender = rows.filter((r) => g(r.ticker) && g(r.ticker).senal === 'Vender').map((r) => ({ ticker: r.ticker, emisor: r.emisor || '' }));
  const fueraGuia = Object.keys(guide).length ? rows.filter((r) => !g(r.ticker)).map((r) => r.ticker) : [];
  return {
    monthly, avg: Math.round(avg * 100) / 100, umbral: Math.round(umbral * 100) / 100,
    comprar, suggestions, alertasVender, fueraGuia, guideCount: Object.keys(guide).length,
  };
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
