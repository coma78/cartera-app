// Calcula metricas objetivas. NO da ordenes de compra/venta:
// genera observaciones informativas para que la persona decida.
import { tickerType } from './ratios.js';
import { tickerRegion } from './universe.js';

function pct(n) {
  return Math.round(n * 100) / 100;
}

// Devuelve observaciones objetivas a partir de las metricas.
function observations({ plPct, changePct }) {
  const obs = [];
  if (changePct >= 3) obs.push({ tag: 'mov', text: `Suba fuerte hoy (+${pct(changePct)}%)` });
  else if (changePct <= -3) obs.push({ tag: 'mov', text: `Caida fuerte hoy (${pct(changePct)}%)` });

  if (plPct !== null) {
    if (plPct >= 20) obs.push({ tag: 'pl', text: `Ganancia acumulada importante (+${pct(plPct)}%)` });
    else if (plPct <= -15) obs.push({ tag: 'pl', text: `Perdida acumulada importante (${pct(plPct)}%)` });
    else if (Math.abs(plPct) <= 2) obs.push({ tag: 'pl', text: 'Cotiza cerca de tu precio de compra' });
  }

  if (obs.length === 0) obs.push({ tag: 'info', text: 'Sin movimientos relevantes' });
  return obs;
}

// Analiza una tenencia con su quote ya resuelto.
// Convencion (coincide con la planilla del usuario):
//   buy_price = precio de la ACCION subyacente al comprar (USD)
//   quantity  = nominales = cantidad de CEDEARs
//   ratio     = CEDEARs por accion
// El precio actual que se muestra es el de la accion (para comparar manzanas
// con manzanas). El valor de la posicion usa (nominales / ratio) acciones.
export function analyzeHolding(holding, quote) {
  const buy = Number(holding.buy_price);          // precio accion al comprar
  const qty = Number(holding.quantity) || 0;      // nominales (CEDEARs)
  const ratio = Number(holding.ratio) > 0 ? Number(holding.ratio) : 1;

  const price = quote.price;                       // precio actual de la accion
  const shares = qty / ratio;                      // acciones equivalentes
  const cedearPrice = pct(price / ratio);          // precio de 1 CEDEAR (info)

  const plPctRaw = buy > 0 ? ((price - buy) / buy) * 100 : null;
  const plPct = plPctRaw === null ? null : pct(plPctRaw);
  const positionValue = qty > 0 ? pct(shares * price) : null;
  const positionCost = qty > 0 ? pct(shares * buy) : null;
  const plAbs = qty > 0 ? pct(shares * (price - buy)) : (buy > 0 ? pct(price - buy) : null);

  return {
    id: holding.id,
    ticker: holding.ticker,
    type: tickerType(holding.ticker),
    region: tickerRegion(holding.ticker),
    buy_price: buy,
    quantity: qty,
    ratio,
    purchase_date: holding.purchase_date || null,
    price,                 // accion subyacente (actual)
    cedearPrice,           // precio por CEDEAR (info)
    changePct: quote.changePct,
    change: quote.change,
    plPct,
    plAbs,
    positionValue,
    positionCost,
    notes: holding.notes || '',
    observations: observations({ plPct, changePct: quote.changePct }),
  };
}

// Analiza un ticker de la watchlist (sin precio de compra).
export function analyzeWatch(watch, quote, news = []) {
  const ratio = Number(watch.ratio) > 0 ? Number(watch.ratio) : 1;
  return {
    id: watch.id,
    ticker: watch.ticker,
    type: tickerType(watch.ticker),
    ratio,
    price: quote.price,                  // accion subyacente
    cedearPrice: pct(quote.price / ratio),
    changePct: quote.changePct,
    change: quote.change,
    notes: watch.notes || '',
    news,
    observations: observations({ plPct: null, changePct: quote.changePct }),
  };
}

// Resumen agregado de la cartera.
export function portfolioSummary(rows) {
  const withValue = rows.filter((r) => r.positionValue !== null);
  const totalValue = pct(withValue.reduce((a, r) => a + r.positionValue, 0));
  const totalCost = pct(withValue.reduce((a, r) => a + (r.positionCost || 0), 0));
  const totalPl = pct(totalValue - totalCost);
  const totalPlPct = totalCost > 0 ? pct((totalPl / totalCost) * 100) : null;

  // Peso de cada posicion sobre el total.
  for (const r of rows) {
    r.weight = totalValue > 0 && r.positionValue ? pct((r.positionValue / totalValue) * 100) : null;
  }

  const movers = [...rows].sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct)).slice(0, 3);

  return {
    count: rows.length,
    totalValue,
    totalCost,
    totalPl,
    totalPlPct,
    topMovers: movers.map((m) => ({ ticker: m.ticker, changePct: m.changePct })),
  };
}
