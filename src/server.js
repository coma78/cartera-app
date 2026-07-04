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
  listRfTrades, saveRfTrades, deleteRfTrade, deleteAllRfTrades,
  listRfPrices, setRfPrice, saveRfPricesAuto,
  listRfPayments, saveRfPayments,
} from './db.js';
import { enrichTrades, computePortfolio, monthlyRenta, upcomingPayments, classify, emisorFrom, isRF } from './rentafija.js';
import { fetchRfPrices } from './rfprices.js';
import { buildReport, generateReport } from './report.js';
import { providerInfo } from './marketData.js';
import { emailConfigured } from './email.js';
import { CEDEAR_RATIOS } from './ratios.js';
import { computeSuggestion, templateRationale } from './advisor.js';
import { aiEnabled, aiRationale, aiScores as aiScoresFn, aiDiscover, lastAiError, aiModel, listModels } from './ai.js';
import { filterUniverse } from './universe.js';
import { signalsEnabled, getSignals, getHistory, momentumScore, lastSignalError, clearSeriesMemory } from './signals.js';
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
  const { ticker, ratio, notes } = req.body;
  if (!ticker) return res.status(400).json({ error: 'ticker es obligatorio' });
  res.json(await addWatch({ ticker, ratio, notes }));
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
    suggestTickers,
  };
}
app.get('/api/settings', wrap(async (_req, res) => res.json(await readSettings())));
app.post('/api/settings', wrap(async (req, res) => {
  if (typeof req.body?.dailyEmail === 'boolean') await setSetting('daily_email', req.body.dailyEmail ? 'true' : 'false');
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
  const [trades, prices, payments] = await Promise.all([listRfTrades(), listRfPrices(), listRfPayments()]);
  const today = new Date().toISOString().slice(0, 10);
  const { rows, totals } = computePortfolio({ trades, prices, payments, today });
  return { rows, totals, prices, payments, today };
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
  let priced = 0;
  try {
    const held = [...new Set(enriched.map((t) => t.ticker))];
    const auto = await fetchRfPrices(held);
    priced = await saveRfPricesAuto(auto);
  } catch { /* noop */ }
  const rf = await computeRf();
  res.json({ imported: saved, clasificados: enriched.length, priced, totals: rf.totals, posiciones: rf.rows.length });
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

// Refrescar precios automáticos desde data912.
app.post('/api/rf/refresh-prices', wrap(async (_req, res) => {
  const trades = await listRfTrades();
  const held = [...new Set(trades.map((t) => t.ticker))];
  if (!held.length) return res.json({ updated: 0, msg: 'No hay tenencias de renta fija' });
  let updated = 0, error = null;
  try {
    const auto = await fetchRfPrices(held);
    updated = await saveRfPricesAuto(auto);
  } catch (e) { error = e.message; }
  res.json({ updated, error });
}));

app.get('/api/rf/payments', wrap(async (_req, res) => res.json(await listRfPayments())));

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
