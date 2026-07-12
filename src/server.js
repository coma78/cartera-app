import express from 'express';
import cron from 'node-cron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  migrate,
  listHoldings, addHolding, updateHolding, deleteHolding,
  deleteAllHoldings, addHoldingsBulk,
  listWatchlist, addWatch, updateWatch, deleteWatch, deleteAllWatch, applyRatioChange,
  listReports, latestReport, deleteAllReports, deleteReport,
  getSetting, setSetting,
  listSales, sellFromLot, deleteSaleRestore,
  saveSeries, deleteAllSeries,
  listRfTrades, saveRfTrades, deleteRfTrade, deleteAllRfTrades, updateRfTrade,
  listRfPrices, setRfPrice, saveRfPricesAuto, clearRfPrices, saveRfPriceSnapshot, listRfPriceHistory,
  listRfPayments, saveRfPayments,
  listRfIncome, saveRfIncome, clearRfIncome,
  listRfCatalog, addRfCatalog, updateRfCatalog, deleteRfCatalog,
} from './db.js';
import { enrichTrades, computePortfolio, monthlyRenta, upcomingPayments, classify, emisorFrom, isRF, buildMepIndex, extractIncome, precioUsdOf, netoUsdOf, fallbackMep, suggestReinforce, rentaByYear } from './rentafija.js';
import { fetchRfPrices } from './rfprices.js';
import { getGuide } from './guide.js';

// MEP implícito más reciente a partir de los boletos (respaldo si dolarapi falla).
function latestImpliedMep(trades) {
  const idx = buildMepIndex(trades.map((t) => ({
    fecha: t.fecha instanceof Date ? t.fecha.toISOString().slice(0, 10) : String(t.fecha || ''),
    ticker: t.ticker, moneda: t.moneda, precio: t.precio,
  })));
  const keys = Object.keys(idx).sort();
  return keys.length ? idx[keys[keys.length - 1]] : null;
}
import { buildReport, generateReport } from './report.js';
import { providerInfo } from './marketData.js';
import { emailConfigured, sendEmail } from './email.js';
import { CEDEAR_RATIOS } from './ratios.js';
import { computeSuggestion, templateRationale } from './advisor.js';
import { aiEnabled, aiRationale, aiScores as aiScoresFn, aiDiscover, lastAiError, aiModel, listModels } from './ai.js';
import { filterUniverse } from './universe.js';
import { signalsEnabled, getSignals, getHistory, momentumScore, lastSignalError, clearSeriesMemory, warmSeriesCache } from './signals.js';
import { computeTechnicals, techFactor, returnsFromSeries } from './technicals.js';
import { reconstruct } from './backfill.js';
import { isEnabled as ssoEnabled, installAuth, apiGuard, pageGuard, currentUser } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '15mb' }));

const APP_TOKEN = process.env.APP_TOKEN || '';

// ---- Rutas de login (Google SSO) ----
installAuth(app);

// ---- Guardia para /api ----
app.use('/api', (req, res, next) => {
  if (req.path === '/health') return next();
  if (ssoEnabled()) return apiGuard(req, res, next);       // SSO tiene prioridad
  if (!APP_TOKEN) return next();                           // modo abierto (local)
  const token = req.get('x-app-token') || req.query.token; // modo token
  if (token === APP_TOKEN) return next();
  return res.status(401).json({ error: 'No autorizado' });
});

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error(e);
  res.status(500).json({ error: e.message });
});

// ---- Salud / config ----
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/config', (req, res) => res.json({
  provider: providerInfo.PROVIDER,
  marketKey: providerInfo.hasKey,
  emailConfigured: emailConfigured(),
  aiEnabled: aiEnabled(),
  signalsEnabled: signalsEnabled(),
  sso: ssoEnabled(),
  user: currentUser(req),
  authRequired: !!APP_TOKEN,
  reportHour: Number(process.env.REPORT_HOUR ?? 8),
  reportMinute: Number(process.env.REPORT_MINUTE ?? 0),
  tz: process.env.TZ || 'UTC',
}));

// ---- Admin: reset y carga masiva desde archivos ----
app.post('/api/admin/reset', wrap(async (_req, res) => {
  await deleteAllHoldings();
  await deleteAllWatch();
  await deleteAllReports();
  res.json({ ok: true });
}));
app.post('/api/admin/seed-tickers', wrap(async (_req, res) => {
  let n = 0;
  for (const [ticker, ratio] of Object.entries(CEDEAR_RATIOS)) { await addWatch({ ticker, ratio }); n++; }
  res.json({ tickers: n });
}));
app.post('/api/admin/seed-holdings', wrap(async (_req, res) => {
  const file = path.join(__dirname, '..', 'data', 'holdings.json');
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'No existe data/holdings.json' });
  const items = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (_req.body?.reset) await deleteAllHoldings();
  const inserted = await addHoldingsBulk(items);
  const seen = new Set();
  for (const it of items) {
    const t = (it.ticker || '').toUpperCase().trim();
    if (!t || seen.has(t)) continue; seen.add(t);
    try { await addWatch({ ticker: t, ratio: it.ratio }); } catch { /* noop */ }
  }
  res.json({ inserted, tickers: seen.size });
}));

// ---- Ratios CEDEAR sugeridos ----
app.get('/api/ratios', (_req, res) => res.json(CEDEAR_RATIOS));

// ---- Holdings (ABM) ----
app.get('/api/holdings', wrap(async (_req, res) => res.json(await listHoldings())));
app.post('/api/holdings', wrap(async (req, res) => {
  const { ticker, buy_price, quantity, ratio, purchase_date, notes } = req.body;
  if (!ticker || buy_price == null) return res.status(400).json({ error: 'ticker y buy_price son obligatorios' });
  res.json(await addHolding({ ticker, buy_price, quantity, ratio, purchase_date, notes }));
}));
app.put('/api/holdings/:id', wrap(async (req, res) => {
  res.json(await updateHolding(Number(req.params.id), req.body));
}));
app.delete('/api/holdings/:id', wrap(async (req, res) => {
  await deleteHolding(Number(req.params.id));
  res.json({ ok: true });
}));
// Importacion masiva. Body: { items:[...], reset:true|false }
app.post('/api/holdings/bulk', wrap(async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: 'lista vacia' });
  if (req.body?.reset) await deleteAllHoldings();
  const inserted = await addHoldingsBulk(items);
  // Registrar los tickers en el catalogo (deseables) con su ratio.
  const seen = new Set();
  for (const it of items) {
    const t = (it.ticker || '').toUpperCase().trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    try { await addWatch({ ticker: t, ratio: it.ratio }); } catch (e) { /* noop */ }
  }
  res.json({ inserted, tickers: seen.size });
}));

// ---- Watchlist (ABM) ----
app.get('/api/watchlist', wrap(async (_req, res) => res.json(await listWatchlist())));
app.post('/api/watchlist', wrap(async (req, res) => {
  const { ticker, ratio, notes, tipo, region } = req.body;
  if (!ticker) return res.status(400).json({ error: 'ticker es obligatorio' });
  res.json(await addWatch({ ticker, ratio, notes, tipo, region }));
}));
app.put('/api/watchlist/:id', wrap(async (req, res) => {
  res.json(await updateWatch(Number(req.params.id), req.body));
}));
// Cambio de ratio (split): actualiza catálogo + ajusta tenencias
app.post('/api/ratio-change', wrap(async (req, res) => {
  const { ticker, newRatio } = req.body;
  if (!ticker || !(Number(newRatio) > 0)) return res.status(400).json({ error: 'ticker y newRatio válidos son obligatorios' });
  res.json(await applyRatioChange(ticker, newRatio));
}));
app.delete('/api/watchlist/:id', wrap(async (req, res) => {
  await deleteWatch(Number(req.params.id));
  res.json({ ok: true });
}));

// ---- Sugerencias de inversión (motor de reglas + IA opcional) ----
app.post('/api/suggest', wrap(async (req, res) => {
  const { amount, risk, strategy, maxPerTicker, maxPerType, maxTickers, include, exclude, note, region, sector, type, includeNew } = req.body || {};
  const { summary } = await buildReport({ withNews: false });

  // Valor y P/G acumulado por ticker (de lo que ya tenés)
  const held = {};
  for (const h of summary.holdings) {
    const g = (held[h.ticker] ??= { value: 0, cost: 0 });
    g.value += h.positionValue || 0;
    g.cost += h.positionCost || 0;
  }
  // Items elegibles = catálogo (★ preferidas) con cotización
  let items = summary.watch.map(w => ({
    ticker: w.ticker, type: w.type, price: w.price, ratio: w.ratio, name: '',
    preferida: true,
    currentValue: held[w.ticker] ? held[w.ticker].value : 0,
    plPct: held[w.ticker] && held[w.ticker].cost > 0 ? ((held[w.ticker].value - held[w.ticker].cost) / held[w.ticker].cost * 100) : null,
  }));
  if (Array.isArray(include) && include.length) items = items.filter(i => include.includes(i.ticker));
  if (Array.isArray(exclude) && exclude.length) items = items.filter(i => !exclude.includes(i.ticker));

  // 🔎 Descubrimiento: sumar candidatos del universo según filtros (si hay región/sector/tipo o includeNew).
  if (includeNew) {
    const have = new Set(items.map(i => i.ticker));
    for (const u of filterUniverse({ region, sector, type })) {
      if (have.has(u.ticker)) continue;
      items.push({ ticker: u.ticker, type: u.type, name: u.name, ratio: u.ratio || 1, ratioKnown: u.ratio != null, price: 0, currentValue: 0, plPct: null, preferida: false });
    }
  }

  // Una sola descarga de la serie histórica (FMP) -> momentum + técnicos + precio de los nuevos.
  const history = signalsEnabled() ? await getHistory(items.map(i => i.ticker)) : {};
  const technicals = {}, momentum = {};
  for (const tk in history) {
    const tech = computeTechnicals(history[tk]);
    if (tech) technicals[tk] = { ...tech, techFactor: techFactor(tech) };
    momentum[tk] = returnsFromSeries(history[tk]);
  }
  // Precio para los candidatos nuevos (o catálogo sin cotización): último cierre de FMP.
  for (const it of items) {
    if (!(it.price > 0) && technicals[it.ticker]) it.price = technicals[it.ticker].price;
  }
  // Descarto los que no tienen precio (no se pueden repartir)
  items = items.filter(i => i.price > 0 || i.preferida);

  // Estrategias con análisis: 'ai' (Claude) o 'momentum' (datos de mercado FMP).
  let strat = strategy;
  let scores = null, aiAnalysis = null, notice = null;

  if (strategy === 'ai') {
    if (!aiEnabled()) {
      strat = 'rebalance';
      notice = 'La estrategia con IA necesita ANTHROPIC_API_KEY. Se usó rebalanceo.';
    } else {
      const sc = await aiScoresFn(items, { risk, note, signals: momentum, technicals });
      if (sc && sc.scores) { scores = sc.scores; aiAnalysis = sc.rationale; }
      else { strat = 'rebalance'; const err = lastAiError(); notice = 'No se pudo obtener el análisis de IA' + (err ? ` — ${err}` : '') + '. Se usó rebalanceo.'; }
    }
  } else if (strategy === 'momentum') {
    if (!signalsEnabled()) {
      strat = 'rebalance';
      notice = 'La estrategia de momentum necesita FMP_API_KEY. Se usó rebalanceo.';
    } else if (!Object.keys(momentum).length) {
      strat = 'rebalance';
      const err = lastSignalError();
      notice = 'No se pudieron obtener datos de mercado (FMP)' + (err ? ` — ${err}` : '') + '. Se usó rebalanceo.';
    } else {
      scores = {};
      for (const i of items) scores[i.ticker] = momentumScore(momentum[i.ticker]);
    }
  }

  const plan = computeSuggestion({ amount, items, prefs: { risk, strategy: strat, maxPerTicker, maxPerType, maxTickers, scores, technicals } });
  const rationale = templateRationale(plan);
  // En estrategia IA el "comentario" es el análisis; en las demás, una explicación del plan.
  const ai = aiAnalysis || (strat !== 'ai' ? await aiRationale(plan, note) : null);
  const techInfo = { enabled: signalsEnabled(), count: Object.keys(technicals).length, error: lastSignalError() };
  res.json({ plan, rationale, aiRationale: ai, aiEnabled: aiEnabled(), notice, techInfo });
}));

// ---- Datos de prueba (series sintéticas) para probar sin FMP ----
function demoSeries(ticker) {
  let seed = [...ticker].reduce((a, c) => a + c.charCodeAt(0), 0) + 7;
  const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  let price = 40 + (seed % 260);
  const out = [];
  const today = new Date();
  for (let i = 260; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    const dow = d.getDay(); if (dow === 0 || dow === 6) continue;
    price = Math.max(1, price * (1 + (rnd() - 0.47) * 0.03)); // leve sesgo alcista
    out.push({ date: d.toISOString().slice(0, 10), close: Math.round(price * 100) / 100 });
  }
  return out;
}
app.post('/api/admin/seed-series-demo', wrap(async (_req, res) => {
  const cat = await listWatchlist();
  let n = 0;
  for (const w of cat) { await saveSeries(w.ticker, demoSeries(w.ticker)); n++; }
  res.json({ seeded: n });
}));

// ---- Indicadores técnicos de TODO el catálogo (para "ver todos") ----
app.get('/api/technicals', wrap(async (_req, res) => {
  const cat = await listWatchlist();
  const history = signalsEnabled() ? await getHistory(cat.map(w => w.ticker)) : {};
  const items = cat.map(w => ({
    ticker: w.ticker,
    tech: history[w.ticker] ? computeTechnicals(history[w.ticker]) : null,
  }));
  res.json({ items, techInfo: { enabled: signalsEnabled(), count: Object.keys(history).length, error: lastSignalError() } });
}));

// ---- Diagnóstico FMP ----
app.get('/api/suggest/diag', wrap(async (_req, res) => {
  if (!signalsEnabled()) return res.json({ enabled: false, msg: 'FMP_API_KEY no está cargada' });
  const sig = await getSignals(['AAPL', 'MSFT']);
  res.json({ enabled: true, count: Object.keys(sig).length, sample: sig.AAPL || null, error: lastSignalError() });
}));

// ---- Diagnóstico IA (modelos disponibles para tu key) ----
app.get('/api/suggest/diag-ai', wrap(async (_req, res) => {
  if (!aiEnabled()) return res.json({ enabled: false, msg: 'ANTHROPIC_API_KEY no está cargada' });
  res.json({ enabled: true, modeloActual: aiModel(), disponibles: await listModels() });
}));

// ---- Ventas ----
app.get('/api/sales', wrap(async (_req, res) => res.json(await listSales())));
app.post('/api/sales', wrap(async (req, res) => {
  const { holding_id, quantity, sell_price, sell_date } = req.body || {};
  if (!holding_id) return res.status(400).json({ error: 'Elegí de qué tenencia vender' });
  res.json(await sellFromLot({ holding_id, quantity, sell_price, sell_date }));
}));
app.delete('/api/sales/:id', wrap(async (req, res) => {
  await deleteSaleRestore(Number(req.params.id));
  res.json({ ok: true });
}));

// ---- Descubrir tickers (universo curado + IA) ----
// Adjunta indicadores técnicos a los candidatos (cap 30 por búsqueda para no
// saturar FMP; usa la cache de series).
async function attachTech(items) {
  if (!signalsEnabled() || !items.length) return items;
  const subset = items.slice(0, 30).map(i => i.ticker);
  const history = await getHistory(subset);
  const tech = {};
  for (const t in history) { const x = computeTechnicals(history[t]); if (x) tech[t] = x; }
  return items.map(u => ({ ...u, tech: tech[u.ticker] || null }));
}
app.get('/api/universe', wrap(async (req, res) => {
  const { region, sector, type } = req.query;
  const cat = new Set((await listWatchlist()).map(w => w.ticker));
  let items = filterUniverse({ region, sector, type }).filter(u => !cat.has(u.ticker));
  items = await attachTech(items);
  res.json({ items, techInfo: { enabled: signalsEnabled(), error: lastSignalError() } });
}));
app.post('/api/discover', wrap(async (req, res) => {
  const { region, sector, type, note } = req.body || {};
  const cat = new Set((await listWatchlist()).map(w => w.ticker));
  let items = filterUniverse({ region, sector, type }).filter(u => !cat.has(u.ticker));
  const ai = await aiDiscover(items, { region, sector, note });
  items = await attachTech(items);
  res.json({ items, aiRationale: ai, aiEnabled: aiEnabled(), techInfo: { enabled: signalsEnabled(), error: lastSignalError() } });
}));

// ---- Dashboard en vivo (precios + analisis, sin enviar mail) ----
app.get('/api/dashboard', wrap(async (req, res) => {
  const fresh = req.query.fresh === '1' || req.query.fresh === 'true';
  const { summary } = await buildReport({ withNews: false, maxAgeMs: fresh ? 0 : 60000 });
  res.json(summary);
}));

// ---- Reportes ----
app.post('/api/report/run', wrap(async (req, res) => {
  const send = req.body?.send !== false; // por defecto envia
  res.json(await generateReport({ send }));
}));
// ---- Settings (toggle de envío de mail diario) ----
async function readSettings() {
  let suggestTickers = null;
  try { suggestTickers = JSON.parse(await getSetting('suggest_tickers', 'null')); } catch { suggestTickers = null; }
  return {
    dailyEmail: (await getSetting('daily_email', 'true')) !== 'false',
    rentaReminder: (await getSetting('renta_reminder', 'true')) !== 'false',
    suggestTickers,
  };
}
app.get('/api/settings', wrap(async (_req, res) => res.json(await readSettings())));
app.post('/api/settings', wrap(async (req, res) => {
  if (typeof req.body?.dailyEmail === 'boolean') await setSetting('daily_email', req.body.dailyEmail ? 'true' : 'false');
  if (typeof req.body?.rentaReminder === 'boolean') await setSetting('renta_reminder', req.body.rentaReminder ? 'true' : 'false');
  if (Array.isArray(req.body?.suggestTickers)) await setSetting('suggest_tickers', JSON.stringify(req.body.suggestTickers));
  res.json(await readSettings());
}));

app.get('/api/reports', wrap(async (_req, res) => res.json(await listReports())));
app.delete('/api/reports/:id', wrap(async (req, res) => {
  await deleteReport(Number(req.params.id));
  res.json({ ok: true });
}));
// Limpiar caché de series de precios (para volver a datos reales)
app.post('/api/admin/clear-series', wrap(async (_req, res) => {
  await deleteAllSeries();
  clearSeriesMemory();
  res.json({ ok: true });
}));

// Reconstrucción histórica de snapshots
app.post('/api/admin/backfill', wrap(async (req, res) => {
  const { from, granularity } = req.body || {};
  if (!from) return res.status(400).json({ error: 'falta la fecha "desde"' });
  res.json(await reconstruct({ from, granularity: granularity || 'daily' }));
}));
app.get('/api/reports/latest', wrap(async (_req, res) => {
  const r = await latestReport();
  if (!r) return res.status(404).send('Sin reportes todavia');
  res.set('Content-Type', 'text/html').send(r.html);
}));

// ==================== RENTA FIJA (ONs + bonos) ====================
// Cómputo central reutilizable: boletos + precios + cronograma -> cartera.
async function computeRf() {
  const [trades, prices, payments, income] = await Promise.all([listRfTrades(), listRfPrices(), listRfPayments(), listRfIncome()]);
  const today = new Date().toISOString().slice(0, 10);
  // El cronograma define la tenencia vigente: si hay pagos cargados, sólo se
  // consideran esas especies (las que ya no tenés no figuran).
  const restrictTo = payments.length ? new Set(payments.map((p) => String(p.ticker).toUpperCase().trim())) : null;
  const { rows, totals } = computePortfolio({ trades, prices, payments, income, today, restrictTo });
  return { rows, totals, prices, payments, income, today, restrictTo };
}

// Importar boletos del broker (una vez / re-sincronización total).
// Body: { rows: [{ especie, ticker, side, cantidad, precio, neto, moneda, fecha }] }
app.post('/api/rf/import-boletos', wrap(async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: 'No se recibieron filas del archivo' });
  const norm = rows.map((r) => ({
    especie: r.especie || '', ticker: String(r.ticker || '').toUpperCase().trim(),
    side: String(r.side || r.tipo || 'COMPRA').toUpperCase(),
    cantidad: Number(r.cantidad) || 0, precio: r.precio != null ? Number(r.precio) : null,
    neto: r.neto != null ? Number(r.neto) : null, moneda: r.moneda || '',
    fecha: r.fecha ? String(r.fecha).slice(0, 10) : null,
  }));
  const enriched = enrichTrades(norm); // sólo ON+Bono, con precio_usd/neto_usd
  const saved = await saveRfTrades(enriched, { source: 'import' });
  // refresco de precios automático best-effort (no bloquea si falla)
  let priced = 0, mep = null;
  try {
    const held = [...new Set(enriched.map((t) => t.ticker))];
    const r = await fetchRfPrices(held, { mepFallback: latestImpliedMep(enriched) });
    priced = await saveRfPricesAuto(r.prices, r.volumenes);
    mep = r.mep;
  } catch { /* noop */ }
  const rf = await computeRf();
  res.json({ imported: saved, clasificados: enriched.length, priced, mep, totals: rf.totals, posiciones: rf.rows.length });
}));

// Importar cronograma de pagos (recurrente). Body: { rows:[{ ticker,fecha,renta,amortizacion,total }] }
app.post('/api/rf/import-cronograma', wrap(async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: 'No se recibieron filas del cronograma' });
  const n = await saveRfPayments(rows);
  res.json({ imported: n });
}));

// Cartera de renta fija (tenencias + totales + renta por mes + próximos cupones).
app.get('/api/rf/holdings', wrap(async (_req, res) => {
  const rf = await computeRf();
  res.json({
    rows: rf.rows,
    totals: rf.totals,
    monthly: monthlyRenta(rf.payments, { today: rf.today }),
    upcoming: upcomingPayments(rf.payments, { today: rf.today }),
    byYear: rentaByYear(rf.income),
    hasData: rf.rows.length > 0 || rf.payments.length > 0,
  });
}));

// Alta manual de una compra/venta de ON/Bono (sin re-importar boletos).
app.post('/api/rf/trade', wrap(async (req, res) => {
  const b = req.body || {};
  const ticker = String(b.ticker || '').toUpperCase().trim();
  if (!ticker) return res.status(400).json({ error: 'El ticker es obligatorio' });
  if (!(Number(b.cantidad) > 0)) return res.status(400).json({ error: 'La cantidad (nominales) debe ser mayor a 0' });
  const clase = b.clase || classify(b.especie, ticker) || 'ON';
  if (!isRF(clase)) return res.status(400).json({ error: 'Sólo ONs o bonos van en renta fija' });
  const raw = {
    especie: b.especie || ticker, ticker, emisor: b.emisor || emisorFrom(b.especie || ticker), clase,
    side: String(b.side || 'COMPRA').toUpperCase(),
    cantidad: Number(b.cantidad) || 0, precio: b.precio != null ? Number(b.precio) : null,
    neto: b.neto != null ? Number(b.neto) : (Number(b.cantidad) * Number(b.precio) || null),
    moneda: b.moneda || 'Dólares', fecha: b.fecha ? String(b.fecha).slice(0, 10) : null,
  };
  // Convertir a USD usando el MEP implícito de TODO el histórico (import + manual).
  const existing = await listRfTrades();
  const all = enrichTrades([...existing.map((t) => ({ especie: t.especie, ticker: t.ticker, emisor: t.emisor, clase: t.clase, side: t.side, cantidad: t.cantidad, precio: t.precio, neto: t.neto, moneda: t.moneda, fecha: t.fecha instanceof Date ? t.fecha.toISOString().slice(0, 10) : t.fecha })), raw]);
  const mine = all[all.length - 1];
  await saveRfTrades([mine], { source: 'manual' });
  const rf = await computeRf();
  res.json({ ok: true, totals: rf.totals });
}));
app.put('/api/rf/trade/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  const ticker = String(b.ticker || '').toUpperCase().trim();
  if (!ticker || !(Number(b.cantidad) > 0)) return res.status(400).json({ error: 'Ticker y nominales son obligatorios' });
  const clase = b.clase || classify(b.especie, ticker) || 'ON';
  if (!isRF(clase)) return res.status(400).json({ error: 'Sólo ONs o bonos van en renta fija' });
  const trades = await listRfTrades();
  const idx = buildMepIndex(trades.map((t) => ({ fecha: t.fecha instanceof Date ? t.fecha.toISOString().slice(0, 10) : t.fecha, ticker: t.ticker, moneda: t.moneda, precio: t.precio })));
  const fb = fallbackMep(idx);
  const raw = {
    ticker, moneda: b.moneda || 'Dólares', precio: b.precio != null ? Number(b.precio) : null,
    neto: b.neto != null ? Number(b.neto) : (Number(b.cantidad) * Number(b.precio) || null),
    fecha: b.fecha ? String(b.fecha).slice(0, 10) : null,
  };
  await updateRfTrade(id, {
    ticker, especie: b.especie || ticker, emisor: b.emisor || emisorFrom(b.especie || ticker), clase,
    side: b.side, cantidad: b.cantidad, precio: raw.precio, moneda: raw.moneda, neto: raw.neto,
    precio_usd: Math.round(precioUsdOf(raw, idx, fb) * 10000) / 10000,
    neto_usd: Math.round(netoUsdOf(raw, idx, fb) * 100) / 100, fecha: raw.fecha,
  });
  const rf = await computeRf();
  res.json({ ok: true, totals: rf.totals });
}));
app.delete('/api/rf/trade/:id', wrap(async (req, res) => {
  await deleteRfTrade(Number(req.params.id));
  res.json({ ok: true });
}));
app.get('/api/rf/trades', wrap(async (_req, res) => res.json(await listRfTrades())));

// Precio manual (override) de un ON/Bono.
app.post('/api/rf/price', wrap(async (req, res) => {
  const ticker = String(req.body?.ticker || '').toUpperCase().trim();
  const price = Number(req.body?.price);
  if (!ticker || !(price > 0)) return res.status(400).json({ error: 'ticker y precio (>0) son obligatorios' });
  await setRfPrice(ticker, price, 'manual');
  res.json({ ok: true });
}));

// Baja data912 (tenencias + catálogo), actualiza rf_prices y guarda snapshot
// diario. Reutilizable por el botón manual y por el cron.
async function updateRfPrices() {
  const [trades, cat] = await Promise.all([listRfTrades(), listRfCatalog()]);
  const held = [...new Set([...trades.map((t) => t.ticker), ...cat.map((c) => c.ticker)])];
  if (!held.length) return { updated: 0, snapped: 0, msg: 'No hay tenencias ni catálogo de renta fija' };
  const r = await fetchRfPrices(held, { mepFallback: latestImpliedMep(trades) });
  const updated = await saveRfPricesAuto(r.prices, r.volumenes);
  const eff = await listRfPrices();
  const map = {};
  for (const tk of Object.keys(eff)) if (eff[tk].price > 0) map[tk] = eff[tk].price;
  const snapped = await saveRfPriceSnapshot(map);
  return { updated, snapped, mep: r.mep, mepSource: r.mepSource, matched: r.matched, error: r.mep ? null : 'No se pudo obtener el MEP (probá de nuevo o cargá precios a mano)' };
}
// Refrescar precios automáticos desde data912.
app.post('/api/rf/refresh-prices', wrap(async (_req, res) => {
  try { res.json(await updateRfPrices()); }
  catch (e) { res.json({ updated: 0, error: e.message }); }
}));

// Precarga de series (technicals) de renta variable: tenencias + catálogo
// (watchlist). Reutilizable por el cron nocturno y por el botón manual.
async function warmCatalogSeries() {
  if (!signalsEnabled()) return { enabled: false };
  const [holds, watch] = await Promise.all([listHoldings(), listWatchlist()]);
  const tickers = [...new Set([...holds.map((h) => h.ticker), ...watch.map((w) => w.ticker)])];
  const max = Number(process.env.SERIES_WARM_MAX) > 0 ? Number(process.env.SERIES_WARM_MAX) : 40;
  return warmSeriesCache(tickers, { max });
}
// Disparo manual (por si querés forzar la precarga sin esperar la noche).
app.post('/api/series/warm', wrap(async (_req, res) => {
  try { res.json(await warmCatalogSeries()); }
  catch (e) { res.json({ enabled: signalsEnabled(), error: e.message }); }
}));
// Histórico de precios (snapshot) para la evolución.
app.get('/api/rf/price-history', wrap(async (req, res) => res.json(await listRfPriceHistory(req.query.ticker || null))));

app.get('/api/rf/payments', wrap(async (_req, res) => res.json(await listRfPayments())));

// Recordatorio por mail el día que se paga renta (sin montos, sólo la especie),
// para acordarte de reinvertir.
async function sendRentaReminder(dateStr) {
  const hoy = dateStr || new Date().toISOString().slice(0, 10);
  const payments = await listRfPayments();
  const todays = payments.filter((p) => String(p.fecha) === hoy);
  if (!todays.length) return { sent: false, reason: 'Sin pagos ese día', tickers: [] };
  const [cat, trades] = await Promise.all([listRfCatalog(), listRfTrades()]);
  const emisorOf = {};
  for (const c of cat) if (c.emisor) emisorOf[c.ticker] = c.emisor;
  for (const t of trades) if (!emisorOf[t.ticker] && t.emisor) emisorOf[t.ticker] = t.emisor;
  const tickers = [...new Set(todays.map((p) => String(p.ticker).toUpperCase().trim()))];
  const fechaLinda = new Date(hoy + 'T12:00:00').toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
  const rows = tickers.map((tk) => `<li style="margin:4px 0"><b>${tk}</b>${emisorOf[tk] ? ` <span style="color:#777">— ${emisorOf[tk]}</span>` : ''}</li>`).join('');
  const html = `<!doctype html><html lang="es"><body style="margin:0;background:#f4f6f9;font-family:Arial,Helvetica,sans-serif;color:#1c1c1c">
    <div style="max-width:520px;margin:0 auto;padding:24px">
      <div style="background:#fff;border-radius:12px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.06)">
        <h1 style="font-size:18px;margin:0 0 6px">💧 Hoy cobrás renta</h1>
        <p style="color:#555;margin:0 0 14px;font-size:14px">${fechaLinda}. Acordate de <b>reinvertirla</b>.</p>
        <ul style="margin:0;padding-left:18px;font-size:15px">${rows}</ul>
        <p style="color:#999;font-size:12px;margin-top:18px;border-top:1px solid #e3e6ea;padding-top:12px">Recordatorio automático de Car te re ar. No incluye montos a propósito.</p>
      </div>
    </div></body></html>`;
  const subject = `Renta hoy — acordate de reinvertir (${tickers.join(', ')})`;
  const r = await sendEmail({ subject, html });
  return { ...r, tickers };
}
// Probar el aviso manualmente (para el día de hoy o una fecha dada).
app.post('/api/rf/renta-reminder/test', wrap(async (req, res) => {
  res.json(await sendRentaReminder(req.body?.date || null));
}));

// ---- Catálogo de renta fija (ONs/bonos candidatos) ----
app.get('/api/rf/catalog', wrap(async (_req, res) => {
  const [cat, prices] = await Promise.all([listRfCatalog(), listRfPrices()]);
  res.json(cat.map((c) => ({ ...c, price: prices[c.ticker] ? prices[c.ticker].price : null, priceSource: prices[c.ticker] ? prices[c.ticker].source : null })));
}));
app.post('/api/rf/catalog', wrap(async (req, res) => {
  const ticker = String(req.body?.ticker || '').toUpperCase().trim();
  if (!ticker) return res.status(400).json({ error: 'El ticker es obligatorio' });
  res.json(await addRfCatalog(req.body));
}));
app.put('/api/rf/catalog/:id', wrap(async (req, res) => res.json(await updateRfCatalog(Number(req.params.id), req.body))));
app.delete('/api/rf/catalog/:id', wrap(async (req, res) => { await deleteRfCatalog(Number(req.params.id)); res.json({ ok: true }); }));

// Agregar mis tenencias actuales al catálogo (sin pisar las que ya están).
app.post('/api/rf/catalog/seed-held', wrap(async (_req, res) => {
  const rf = await computeRf();
  const existing = new Set((await listRfCatalog()).map((c) => c.ticker));
  let added = 0;
  for (const r of rf.rows) {
    if (existing.has(r.ticker)) continue;
    await addRfCatalog({ ticker: r.ticker, emisor: r.emisor, clase: r.clase, moneda: 'USD' });
    added++;
  }
  res.json({ added });
}));

// Guía de recomendaciones (Google Sheet público, cacheada).
app.get('/api/guide', wrap(async (_req, res) => res.json(await getGuide())));

// Cargar mínimos en lote (pegado "ticker mínimo"). Crea la especie si no está.
app.post('/api/rf/catalog/min-bulk', wrap(async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const cat = await listRfCatalog();
  const byTk = {};
  for (const c of cat) byTk[c.ticker] = c;
  let n = 0;
  for (const r of rows) {
    const tk = String(r.ticker || '').toUpperCase().trim();
    const min = Number(r.min) || 0;
    if (!tk || !(min > 0)) continue;
    if (byTk[tk]) await updateRfCatalog(byTk[tk].id, { min_nominales: min });
    else await addRfCatalog({ ticker: tk, min_nominales: min });
    n++;
  }
  res.json({ updated: n });
}));

// Estimar el mínimo de nominales desde los boletos (menor cantidad comprada).
// Sólo completa los que están en blanco (no pisa los que cargaste a mano).
app.post('/api/rf/catalog/estimate-min', wrap(async (_req, res) => {
  const [cat, trades] = await Promise.all([listRfCatalog(), listRfTrades()]);
  const minBuy = {};
  for (const t of trades) {
    if (String(t.side).toUpperCase() !== 'COMPRA') continue;
    const q = Number(t.cantidad) || 0;
    if (q <= 0) continue;
    minBuy[t.ticker] = minBuy[t.ticker] == null ? q : Math.min(minBuy[t.ticker], q);
  }
  let updated = 0;
  for (const c of cat) {
    if (Number(c.min_nominales) > 0) continue;
    const mb = minBuy[c.ticker];
    if (mb > 0) { await updateRfCatalog(c.id, { min_nominales: mb }); updated++; }
  }
  res.json({ updated });
}));

// Sugerencias RF: reforzar meses de renta baja + cruce con la guía + monto.
app.get('/api/rf/suggest', wrap(async (req, res) => {
  const [rf, catalog, prices, guide] = await Promise.all([computeRf(), listRfCatalog(), listRfPrices(), getGuide()]);
  const monto = Number(req.query.monto) || 0;
  const s = suggestReinforce({ payments: rf.payments, rows: rf.rows, catalog, prices, guide: guide.map || {}, monto, today: rf.today });
  res.json({ ...s, guideUpdated: guide.updated, guideError: guide.error || null });
}));

// Importar movimientos → renta cobrada histórica por ON (patas USD de "Renta").
// Body: { rows:[{ descripcion, ticker, moneda, importe, fecha }] }
app.post('/api/rf/import-movimientos', wrap(async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: 'No se recibieron filas del archivo' });
  const income = extractIncome(rows);
  const nuevos = await saveRfIncome(income, { replace: req.body?.replace === true });
  const rf = await computeRf();
  res.json({ eventos: income.length, nuevos, rentaCobrada: rf.totals.rentaCobrada, totals: rf.totals });
}));

// Limpiar precios cacheados (por defecto sólo los automáticos).
app.post('/api/rf/prices/clear', wrap(async (req, res) => {
  await clearRfPrices({ includeManual: req.body?.includeManual === true });
  res.json({ ok: true });
}));

// Vista consolidada: renta variable (CEDEARs) + renta fija.
app.get('/api/rf/consolidated', wrap(async (_req, res) => {
  const rf = await computeRf();
  const { summary } = await buildReport({ withNews: false, maxAgeMs: 60000 });
  const variable = {
    valorActual: summary.totalValue || 0,
    capitalAportado: summary.totalCost || 0,
    ganancia: summary.totalPl || 0,
    rendimientoPct: summary.totalPlPct,
  };
  const fija = {
    valorActual: rf.totals.valorActual,
    capitalAportado: rf.totals.capitalAportado,
    ganancia: rf.totals.gananciaTotal,
    rentaCobrada: rf.totals.rentaCobrada,
    rendimientoPct: rf.totals.rendimientoPct,
  };
  const valorTotal = round2(variable.valorActual + fija.valorActual);
  const aportadoTotal = round2(variable.capitalAportado + fija.capitalAportado);
  const gananciaTotal = round2(variable.ganancia + fija.ganancia);
  const rendimientoPct = aportadoTotal > 0 ? round2(gananciaTotal / aportadoTotal * 100) : null;
  res.json({
    variable, fija,
    total: { valorActual: valorTotal, capitalAportado: aportadoTotal, gananciaTotal, rendimientoPct },
    pesos: {
      variable: valorTotal > 0 ? round2(variable.valorActual / valorTotal * 100) : 0,
      fija: valorTotal > 0 ? round2(fija.valorActual / valorTotal * 100) : 0,
    },
    monthly: monthlyRenta(rf.payments, { today: rf.today }),
  });
}));

// Reset sólo de renta fija (no toca CEDEARs).
app.post('/api/rf/reset', wrap(async (_req, res) => {
  await deleteAllRfTrades();
  await saveRfPayments([]);
  await clearRfIncome();
  res.json({ ok: true });
}));

function round2(n) { return Math.round(n * 100) / 100; }

// ---- Static UI (la portada pide login si el SSO está activo) ----
app.get('/', pageGuard, (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---- Arranque ----
const PORT = process.env.PORT || 3000;

async function start() {
  await migrate();

  // Cron diario en zona horaria local.
  const hour = Number(process.env.REPORT_HOUR ?? 8);
  const minute = Number(process.env.REPORT_MINUTE ?? 0);
  const tz = process.env.TZ || 'UTC';
  const expr = `${minute} ${hour} * * *`;
  if (cron.validate(expr)) {
    cron.schedule(expr, async () => {
      console.log(`[cron] generando reporte diario ${new Date().toISOString()}`);
      try {
        // El snapshot se guarda siempre; el mail sólo si está activado.
        const sendMail = (await getSetting('daily_email', 'true')) !== 'false';
        const r = await generateReport({ send: sendMail });
        console.log(`[cron] reporte #${r.reportId} — mail: ${r.emailResult.sent ? 'enviado' : r.emailResult.reason}`);
      } catch (e) {
        console.error('[cron] error:', e.message);
      }
      // Precios de renta fija (data912) + snapshot diario para la evolución.
      try {
        const rf = await updateRfPrices();
        console.log(`[cron] renta fija — precios ${rf.updated}, snapshot ${rf.snapped}${rf.error ? ' — ' + rf.error : ''}`);
      } catch (e) {
        console.error('[cron] rf precios error:', e.message);
      }
      // Recordatorio de renta a reinvertir (el día que se paga).
      try {
        if ((await getSetting('renta_reminder', 'true')) !== 'false') {
          const rr = await sendRentaReminder();
          if (rr.sent) console.log(`[cron] recordatorio renta enviado: ${rr.tickers.join(', ')}`);
        }
      } catch (e) {
        console.error('[cron] renta reminder error:', e.message);
      }
      // Precarga de series (technicals) del catálogo, de a pocos por noche.
      try {
        const w = await warmCatalogSeries();
        if (w.enabled) console.log(`[cron] warm series — cacheados ${w.cacheados}/${w.intentados} (faltaban ${w.candidatos})${w.error ? ' — ' + w.error : ''}`);
      } catch (e) {
        console.error('[cron] warm series error:', e.message);
      }
    }, { timezone: tz });
    console.log(`[cron] programado ${expr} (${tz})`);
  } else {
    console.warn('[cron] expresion invalida, no se programo el reporte');
  }

  app.listen(PORT, () => console.log(`[server] escuchando en :${PORT}`));
}

start().catch((e) => {
  console.error('[server] fallo al arrancar:', e);
  process.exit(1);
});
