// Cotizaciones de renta fija (ONs + bonos) desde data912.com — API pública
// argentina, sin API key. IMPORTANTE: data912 devuelve el precio en PESOS y
// POR 100 NOMINALES (ej. DNCAO ≈ 161.340). Para valuar en USD par por 1 nominal
// hacemos:  precio_usd_par = precio_pesos / 100 / MEP.
// El MEP se toma en vivo (dolarapi) con respaldo del MEP implícito de tus boletos.

const ENDPOINTS = [
  'https://data912.com/live/arg_corp',   // obligaciones negociables
  'https://data912.com/live/arg_bonds',  // bonos soberanos
  'https://data912.com/live/arg_notes',  // letras / notas
];

function pickSymbol(o) {
  return String(o.symbol || o.ticker || o.simbolo || '').toUpperCase().trim();
}
function pickPrice(o) {
  for (const k of ['c', 'close', 'last', 'ultimo', 'px', 'price', 'p']) {
    const v = Number(o[k]);
    if (v > 0) return v;
  }
  const bid = Number(o.px_bid || o.bid), ask = Number(o.px_ask || o.ask);
  if (bid > 0 && ask > 0) return (bid + ask) / 2;
  if (ask > 0) return ask;
  if (bid > 0) return bid;
  return 0;
}

async function fetchOne(url) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'cartera-app' }, signal: ctrl.signal });
    if (!res.ok) return [];
    const j = await res.json();
    return Array.isArray(j) ? j : (Array.isArray(j.data) ? j.data : []);
  } catch { return []; }
  finally { clearTimeout(to); }
}

// Tipo de cambio MEP (pesos por dólar). Prioridad: env RF_MEP > dolarapi >
// fallback provisto (MEP implícito de los boletos) > null.
export async function getMep(fallback = null) {
  const env = Number(process.env.RF_MEP);
  if (env > 0) return { mep: env, source: 'manual' };
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 7000);
  try {
    const res = await fetch('https://dolarapi.com/v1/dolares/mep', { signal: ctrl.signal });
    if (res.ok) {
      const j = await res.json();
      const v = Number(j.venta ?? j.promedio ?? j.compra);
      if (v > 0) return { mep: v, source: 'dolarapi' };
    }
  } catch { /* noop */ }
  finally { clearTimeout(to); }
  if (Number(fallback) > 0) return { mep: Number(fallback), source: 'boletos' };
  return { mep: null, source: null };
}

// Trae precios para los tickers pedidos, ya convertidos a USD par por 1 nominal.
// Devuelve { prices: { TICKER: usdPar }, mep, mepSource, divisor, matched }.
export async function fetchRfPrices(tickers = [], { mepFallback = null } = {}) {
  const want = new Set(tickers.map((t) => String(t || '').toUpperCase().trim()));
  const divisor = Number(process.env.RF_PRICE_DIVISOR) > 0 ? Number(process.env.RF_PRICE_DIVISOR) : 100;

  const [{ mep, source: mepSource }, ...lists] = await Promise.all([getMep(mepFallback), ...ENDPOINTS.map(fetchOne)]);
  const prices = {}, volumenes = {};
  let matched = 0;
  for (const list of lists) {
    for (const o of list) {
      const sym = pickSymbol(o);
      if (!sym) continue;
      const hit = want.has(sym) ? sym : [...want].find((w) => sym === w || sym.startsWith(w));
      if (!hit) continue;
      // liquidez: cantidad de operaciones del día (o volumen si no hay).
      if (volumenes[hit] == null) {
        const ops = Number(o.q_op ?? o.q_operaciones ?? o.trades);
        volumenes[hit] = ops >= 0 ? ops : (Number(o.v || o.volume) || 0);
      }
      if (mep > 0 && !prices[hit]) {
        const rawPesos = pickPrice(o);
        if (rawPesos > 0) { prices[hit] = Math.round((rawPesos / divisor / mep) * 10000) / 10000; matched++; }
      }
    }
  }
  return { prices, volumenes, mep, mepSource, divisor, matched };
}

export function rfPricesEnabled() { return true; }
