// Calcula metricas objetivas. NO da ordenes de compra/venta:
// genera observaciones informativas para que la persona decida.

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

// Analiza una tenencia (holding) con su quote ya resuelto.
export function analyzeHolding(holding, quote) {
  const buy = Number(holding.buy_price);
  const qty = Number(holding.quantity) || 0;
  const price = quote.price;

  const plPctRaw = buy > 0 ? ((price - buy) / buy) * 100 : null;
  const plPct = plPctRaw === null ? null : pct(plPctRaw);
  const positionValue = qty > 0 ? pct(qty * price) : null;
  const positionCost = qty > 0 ? pct(qty * buy) : null;
  const plAbs = qty > 0 ? pct(qty * (price - buy)) : (buy > 0 ? pct(price - buy) : null);

  return {
    id: holding.id,
    ticker: holding.ticker,
    buy_price: buy,
    quantity: qty,
    price,
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
  return {
    id: watch.id,
    ticker: watch.ticker,
    price: quote.price,
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
