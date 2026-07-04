// Cotizaciones de renta fija (ONs + bonos) desde data912.com — API pública
// argentina, sin API key. Best-effort: si falla, la app usa el precio manual o
// el último conocido. Los ONs argentinos suelen cotizar "por 100 nominales"
// (~100-120 en dólares), así que normalizamos a "por 1 nominal" (~1,0-1,2).

const ENDPOINTS = [
  'https://data912.com/live/arg_corp',   // obligaciones negociables
  'https://data912.com/live/arg_bonds',  // bonos soberanos
  'https://data912.com/live/arg_notes',  // letras / notas
];

// data912 devuelve arrays de objetos con nombres de campos variables.
function pickSymbol(o) {
  return String(o.symbol || o.ticker || o.simbolo || o.especie || '').toUpperCase().trim();
}
function pickPrice(o) {
  for (const k of ['c', 'close', 'last', 'ultimo', 'ultimoPrecio', 'px', 'price', 'p']) {
    const v = Number(o[k]);
    if (v > 0) return v;
  }
  // último recurso: promedio de punta compradora/vendedora
  const bid = Number(o.px_bid || o.bid), ask = Number(o.px_ask || o.ask);
  if (bid > 0 && ask > 0) return (bid + ask) / 2;
  return 0;
}

// Normaliza a "por 1 nominal". Se puede ajustar el divisor por env sin tocar
// código (RF_PRICE_DIVISOR): 100 si data912 cotiza por 100 VN, 1 si ya es por 1.
function normalize(raw) {
  const div = Number(process.env.RF_PRICE_DIVISOR);
  if (div > 0) return raw / div;
  // auto: si el precio parece "por 100" (mayor a ~10) lo pasamos a por-1.
  return raw > 10 ? raw / 100 : raw;
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

// Trae precios para los tickers pedidos. Devuelve { TICKER: price(por 1 nominal) }.
export async function fetchRfPrices(tickers = []) {
  const want = new Set(tickers.map((t) => String(t || '').toUpperCase().trim()));
  const out = {};
  const lists = await Promise.all(ENDPOINTS.map(fetchOne));
  for (const list of lists) {
    for (const o of list) {
      const sym = pickSymbol(o);
      if (!sym) continue;
      // data912 a veces trae el símbolo con sufijo (ej. TICKERD/C). Match exacto o por prefijo.
      const hit = want.has(sym) ? sym : [...want].find((w) => sym === w || sym.startsWith(w));
      if (!hit) continue;
      const raw = pickPrice(o);
      if (raw > 0 && !out[hit]) out[hit] = Math.round(normalize(raw) * 10000) / 10000;
    }
  }
  return out;
}

export function rfPricesEnabled() { return true; }
