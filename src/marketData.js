// Capa de datos de mercado, agnostica del proveedor.
// Soporta: finnhub (default), fmp, y mock (para pruebas sin API key).

const PROVIDER = (process.env.MARKET_PROVIDER || 'finnhub').toLowerCase();
const KEY = process.env.MARKET_API_KEY || '';

// Algunos tickers de CEDEAR difieren del simbolo en el mercado de EEUU.
const SYMBOL_ALIASES = {
  BRKB: 'BRK.B',
};

function marketSymbol(symbol) {
  return SYMBOL_ALIASES[symbol] || symbol;
}

function ymd(d) {
  return d.toISOString().slice(0, 10);
}

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'cartera-app' } });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} en ${url.replace(KEY, '***')}`);
  }
  return res.json();
}

// ---------- MOCK (pruebas) ----------
function mockQuote(symbol) {
  // Precio pseudo-determinista a partir del ticker, para que sea estable en tests.
  const seed = [...symbol].reduce((a, c) => a + c.charCodeAt(0), 0);
  const price = 50 + (seed % 200) + (seed % 7) * 0.13;
  const prevClose = price * (1 - ((seed % 11) - 5) / 100);
  const change = price - prevClose;
  return {
    symbol,
    price: round(price),
    prevClose: round(prevClose),
    change: round(change),
    changePct: round((change / prevClose) * 100),
    high: round(price * 1.02),
    low: round(price * 0.98),
    open: round(prevClose * 1.001),
  };
}

function round(n) {
  return Math.round(n * 100) / 100;
}

// ---------- FINNHUB ----------
async function finnhubQuote(symbol) {
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${KEY}`;
  const d = await getJson(url);
  if (d.c === 0 && d.pc === 0) throw new Error(`Sin datos para ${symbol}`);
  return {
    symbol,
    price: d.c,
    prevClose: d.pc,
    change: round(d.d),
    changePct: round(d.dp),
    high: d.h,
    low: d.l,
    open: d.o,
  };
}

async function finnhubNews(symbol) {
  const to = new Date();
  const from = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);
  const url = `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(symbol)}&from=${ymd(from)}&to=${ymd(to)}&token=${KEY}`;
  const arr = await getJson(url);
  return (Array.isArray(arr) ? arr : []).slice(0, 3).map((n) => ({
    headline: n.headline,
    url: n.url,
    source: n.source,
    datetime: n.datetime ? new Date(n.datetime * 1000).toISOString() : null,
  }));
}

// ---------- FMP ----------
async function fmpQuote(symbol) {
  const url = `https://financialmodelingprep.com/api/v3/quote/${encodeURIComponent(symbol)}?apikey=${KEY}`;
  const arr = await getJson(url);
  const d = Array.isArray(arr) ? arr[0] : null;
  if (!d) throw new Error(`Sin datos para ${symbol}`);
  return {
    symbol,
    price: d.price,
    prevClose: d.previousClose,
    change: round(d.change),
    changePct: round(d.changesPercentage),
    high: d.dayHigh,
    low: d.dayLow,
    open: d.open,
  };
}

async function fmpNews(symbol) {
  const url = `https://financialmodelingprep.com/api/v3/stock_news?tickers=${encodeURIComponent(symbol)}&limit=3&apikey=${KEY}`;
  const arr = await getJson(url);
  return (Array.isArray(arr) ? arr : []).slice(0, 3).map((n) => ({
    headline: n.title,
    url: n.url,
    source: n.site,
    datetime: n.publishedDate || null,
  }));
}

// ---------- API publica ----------
export async function getQuote(symbol) {
  symbol = symbol.toUpperCase().trim();
  const mkt = marketSymbol(symbol);
  let q;
  if (PROVIDER === 'mock' || !KEY) q = mockQuote(mkt);
  else if (PROVIDER === 'fmp') q = await fmpQuote(mkt);
  else q = await finnhubQuote(mkt);
  q.symbol = symbol; // devolvemos el ticker tal como lo cargo el usuario
  return q;
}

export async function getNews(symbol) {
  symbol = marketSymbol(symbol.toUpperCase().trim());
  try {
    if (PROVIDER === 'mock' || !KEY) return [];
    if (PROVIDER === 'fmp') return fmpNews(symbol);
    return finnhubNews(symbol);
  } catch (e) {
    console.warn(`[market] noticias ${symbol}:`, e.message);
    return [];
  }
}

// Trae quote (y opcionalmente noticias) tolerando fallas individuales.
export async function getQuoteSafe(symbol, withNews = false) {
  try {
    const quote = await getQuote(symbol);
    const news = withNews ? await getNews(symbol) : [];
    return { ok: true, quote, news };
  } catch (e) {
    return { ok: false, symbol: symbol.toUpperCase().trim(), error: e.message };
  }
}

// ---- Caché de cotizaciones (TTL) + batch en paralelo ----
const _cache = new Map(); // ticker -> { ts, result }

export async function getQuoteSafeCached(symbol, maxAgeMs = 60000) {
  const sym = symbol.toUpperCase().trim();
  const c = _cache.get(sym);
  if (c && maxAgeMs > 0 && (Date.now() - c.ts) < maxAgeMs) return c.result;
  const result = await getQuoteSafe(sym, false);
  // Sólo cacheamos resultados OK (no queremos pegarnos un error por 60s).
  if (result.ok) _cache.set(sym, { ts: Date.now(), result });
  return result;
}

// Devuelve un Map ticker -> resultado, cotizando los únicos EN PARALELO.
export async function getQuotesBatch(tickers, maxAgeMs = 60000) {
  const uniq = [...new Set((tickers || []).map(t => t.toUpperCase().trim()).filter(Boolean))];
  const results = await Promise.all(uniq.map(t => getQuoteSafeCached(t, maxAgeMs)));
  const map = new Map();
  uniq.forEach((t, i) => map.set(t, results[i]));
  return map;
}

export const providerInfo = { PROVIDER, hasKey: !!KEY };
