// Señales de mercado (momentum) desde Financial Modeling Prep (FMP).
// Key aparte (FMP_API_KEY) para no tocar el proveedor de cotizaciones.
// Si no hay key, devuelve {} y todo sigue funcionando sin señales.

const FMP_KEY = process.env.FMP_API_KEY || '';
const TTL = 6 * 3600 * 1000; // 6 horas (cambia lento)
const _cache = new Map();     // ticker -> { ts, sig }
const ALIAS = { BRKB: 'BRK.B' };

export function signalsEnabled() { return !!FMP_KEY; }

// Devuelve map ticker -> { m1, m3, m6, ytd, y1 } (porcentajes)
export async function getSignals(tickers) {
  if (!FMP_KEY) return {};
  const uniq = [...new Set((tickers || []).map(t => t.toUpperCase().trim()).filter(Boolean))];
  const out = {};
  await Promise.all(uniq.map(async (t) => {
    const c = _cache.get(t);
    if (c && Date.now() - c.ts < TTL) { out[t] = c.sig; return; }
    try {
      const sym = ALIAS[t] || t;
      const url = `https://financialmodelingprep.com/api/v3/stock-price-change/${encodeURIComponent(sym)}?apikey=${FMP_KEY}`;
      const res = await fetch(url);
      if (!res.ok) return;
      const arr = await res.json();
      const d = Array.isArray(arr) ? arr[0] : null;
      if (!d) return;
      const sig = { m1: num(d['1M']), m3: num(d['3M']), m6: num(d['6M']), ytd: num(d.ytd), y1: num(d['1Y']) };
      _cache.set(t, { ts: Date.now(), sig });
      out[t] = sig;
    } catch (e) { /* noop */ }
  }));
  return out;
}

function num(x) { const n = Number(x); return Number.isFinite(n) ? Math.round(n * 100) / 100 : null; }

// Puntaje de momentum 0..~? a partir de las señales (para estrategia sin IA).
// Base 1; sube con tendencia positiva (pondera 3M y 6M), baja con la negativa.
export function momentumScore(sig) {
  if (!sig) return 1;
  const m1 = sig.m1 || 0, m3 = sig.m3 || 0, m6 = sig.m6 || 0;
  const raw = 0.5 * m3 + 0.3 * m6 + 0.2 * m1; // % combinado
  return Math.max(0.05, 1 + raw / 10);
}
