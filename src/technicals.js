// Indicadores técnicos calculados a partir de la serie de cierres (FMP).
// Todo local, sin costo extra de API. Son indicadores conocidos: información,
// no recomendación; pueden dar señales falsas.

const r2 = (n) => Math.round(n * 100) / 100;

function sma(arr, n) {
  if (arr.length < n) return null;
  const s = arr.slice(-n);
  return s.reduce((a, b) => a + b, 0) / n;
}

function emaSeries(arr, n) {
  if (arr.length < n) return [];
  const k = 2 / (n + 1);
  const out = new Array(arr.length).fill(null);
  let e = arr.slice(0, n).reduce((a, b) => a + b, 0) / n;
  out[n - 1] = e;
  for (let i = n; i < arr.length; i++) { e = arr[i] * k + e * (1 - k); out[i] = e; }
  return out;
}

function ema(arr, n) {
  const s = emaSeries(arr, n);
  return s.length ? s[s.length - 1] : null;
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  const ag = gains / period, al = losses / period;
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}

function macd(closes) {
  if (closes.length < 35) return null;
  const e12 = emaSeries(closes, 12), e26 = emaSeries(closes, 26);
  const macdLine = [];
  for (let i = 0; i < closes.length; i++) if (e12[i] != null && e26[i] != null) macdLine.push(e12[i] - e26[i]);
  if (macdLine.length < 9) return null;
  const line = macdLine[macdLine.length - 1];
  const signal = ema(macdLine, 9);
  return { line, signal, hist: signal == null ? null : line - signal };
}

function bollinger(closes, n = 20, k = 2) {
  if (closes.length < n) return null;
  const s = closes.slice(-n);
  const mid = s.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(s.reduce((a, b) => a + (b - mid) ** 2, 0) / n);
  const upper = mid + k * sd, lower = mid - k * sd;
  const price = closes[closes.length - 1];
  return { pctB: upper > lower ? r2(((price - lower) / (upper - lower)) * 100) : 50, width: r2(((upper - lower) / mid) * 100) };
}

function volatility(closes) {
  if (closes.length < 22) return null;
  const rets = [];
  for (let i = closes.length - 21; i < closes.length; i++) rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const v = rets.reduce((a, b) => a + (b - m) ** 2, 0) / rets.length;
  return r2(Math.sqrt(v) * Math.sqrt(252) * 100);
}

// series: [{date, close}] ascendente
export function computeTechnicals(series) {
  const closes = series.map(s => s.close).filter(Number.isFinite);
  if (closes.length < 30) return null;
  const price = closes[closes.length - 1];
  const s50 = sma(closes, 50), s200 = sma(closes, 200);
  const mac = macd(closes);
  const bb = bollinger(closes);
  const look = closes.slice(-252);
  const high = Math.max(...look);
  let trend = 'lateral';
  if (s50 != null && s200 != null) trend = s50 > s200 ? 'alcista' : 'bajista';
  else if (s50 != null) trend = price > s50 ? 'alcista' : 'bajista';
  return {
    price: r2(price),
    rsi: (() => { const v = rsi(closes, 14); return v == null ? null : r2(v); })(),
    sma50: s50 == null ? null : r2(s50),
    sma200: s200 == null ? null : r2(s200),
    aboveSMA200: s200 == null ? null : price > s200,
    trend,
    macdHist: mac == null ? null : r2(mac.hist),
    bbPctB: bb == null ? null : bb.pctB,
    vol: volatility(closes),
    distHigh: r2((price / high - 1) * 100),
  };
}

// Factor para el puntaje (gentil): favorece tendencia sana, penaliza
// sobrecompra/quiebre. Clamp 0.6–1.4.
export function techFactor(t) {
  if (!t) return 1;
  let f = 1;
  if (t.aboveSMA200 === true) f *= 1.12; else if (t.aboveSMA200 === false) f *= 0.88;
  if (t.rsi != null) { if (t.rsi > 70) f *= 0.82; else if (t.rsi < 30) f *= 1.06; }
  if (t.macdHist != null) f *= (t.macdHist > 0 ? 1.08 : 0.93);
  return Math.max(0.6, Math.min(1.4, r2(f)));
}

// Retornos para el momentum, desde la misma serie (evita doble fetch).
export function returnsFromSeries(series) {
  const c = series.map(s => s.close).filter(Number.isFinite);
  const ret = (n) => (c.length > n && c[c.length - 1 - n]) ? r2(((c[c.length - 1] - c[c.length - 1 - n]) / c[c.length - 1 - n]) * 100) : null;
  return { m1: ret(21), m3: ret(63), m6: ret(126), y1: ret(252) };
}
