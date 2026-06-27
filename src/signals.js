// Señales de mercado (momentum) desde Financial Modeling Prep (FMP).
// Key aparte (FMP_API_KEY). Si no hay key, devuelve {} y todo sigue andando.
// Intenta dos endpoints (por compatibilidad con el plan gratuito) y guarda
// un diagnóstico del último error para mostrarlo si falla.

const FMP_KEY = process.env.FMP_API_KEY || '';
const TTL = 6 * 3600 * 1000; // 6 horas
const _cache = new Map();     // ticker -> { ts, sig }
const ALIAS = { BRKB: 'BRK.B' };
let _lastError = null;

export function signalsEnabled() { return !!FMP_KEY; }
export function lastSignalError() { return _lastError; }

function num(x) { const n = Number(x); return Number.isFinite(n) ? Math.round(n * 100) / 100 : null; }

async function fetchJson(url) {
  const res = await fetch(url);
  let body = null;
  try { body = await res.json(); } catch { /* no json */ }
  if (!res.ok) {
    const msg = body && (body['Error Message'] || body.message) ? (body['Error Message'] || body.message) : `HTTP ${res.status}`;
    return { ok: false, error: msg, status: res.status };
  }
  if (body && body['Error Message']) return { ok: false, error: body['Error Message'], status: res.status };
  return { ok: true, body };
}

// API nueva "stable": histórico EOD (light) -> calculo los retornos.
async function viaHistorical(sym) {
  const r = await fetchJson(`https://financialmodelingprep.com/stable/historical-price-eod/light?symbol=${encodeURIComponent(sym)}&apikey=${FMP_KEY}`);
  if (!r.ok) { _lastError = r.error; return null; }
  let arr = Array.isArray(r.body) ? r.body : (r.body && Array.isArray(r.body.historical) ? r.body.historical : null);
  if (!arr || !arr.length) return null;
  arr = arr.slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))); // más reciente primero
  const closes = arr.map(h => Number(h.price ?? h.close ?? h.adjClose)).filter(Number.isFinite);
  if (closes.length < 2) return null;
  const ret = (n) => closes.length > n && closes[n] ? num(((closes[0] - closes[n]) / closes[n]) * 100) : null;
  return { m1: ret(21), m3: ret(63), m6: ret(126), ytd: null, y1: ret(252) };
}

export async function getSignals(tickers) {
  if (!FMP_KEY) return {};
  _lastError = null;
  const uniq = [...new Set((tickers || []).map(t => t.toUpperCase().trim()).filter(Boolean))];
  const out = {};
  await Promise.all(uniq.map(async (t) => {
    const c = _cache.get(t);
    if (c && Date.now() - c.ts < TTL) { out[t] = c.sig; return; }
    const sym = ALIAS[t] || t;
    try {
      const sig = await viaHistorical(sym);
      if (sig) { _cache.set(t, { ts: Date.now(), sig }); out[t] = sig; }
    } catch (e) { _lastError = e.message; }
  }));
  return out;
}

// Serie histórica de cierres por ticker. Cacheada (12 h) y con las llamadas
// espaciadas, para no saturar el límite de FMP al reconstruir varias veces.
const _hist = new Map();            // ticker -> { ts, series }
const HIST_TTL = 12 * 3600 * 1000;
const FROM_FLOOR = '2024-01-01';    // bajamos histórico amplio una sola vez
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function getHistory(tickers) {
  if (!FMP_KEY) return {};
  const to = new Date().toISOString().slice(0, 10);
  const out = {};
  const uniq = [...new Set((tickers || []).map(x => x.toUpperCase().trim()).filter(Boolean))];
  for (const t of uniq) {
    const c = _hist.get(t);
    if (c && Date.now() - c.ts < HIST_TTL) { out[t] = c.series; continue; }
    const sym = ALIAS[t] || t;
    try {
      const r = await fetchJson(`https://financialmodelingprep.com/stable/historical-price-eod/light?symbol=${encodeURIComponent(sym)}&from=${FROM_FLOOR}&to=${to}&apikey=${FMP_KEY}`);
      if (r.ok) {
        let arr = Array.isArray(r.body) ? r.body : (r.body && Array.isArray(r.body.historical) ? r.body.historical : null);
        const ser = (arr || [])
          .map(h => ({ date: String(h.date).slice(0, 10), close: Number(h.price ?? h.close ?? h.adjClose) }))
          .filter(x => Number.isFinite(x.close))
          .sort((a, b) => a.date.localeCompare(b.date));
        if (ser.length) { _hist.set(t, { ts: Date.now(), series: ser }); out[t] = ser; }
      } else { _lastError = r.error; }
    } catch (e) { _lastError = e.message; }
    await sleep(300); // espaciar para no pegarle al límite
  }
  return out;
}

// Puntaje de momentum a partir de las señales (estrategia sin IA).
export function momentumScore(sig) {
  if (!sig) return 1;
  const m1 = sig.m1 || 0, m3 = sig.m3 || 0, m6 = sig.m6 || 0;
  const raw = 0.5 * m3 + 0.3 * m6 + 0.2 * m1;
  return Math.max(0.05, 1 + raw / 10);
}
