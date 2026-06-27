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
} from './db.js';
import { buildReport, generateReport } from './report.js';
import { providerInfo } from './marketData.js';
import { emailConfigured } from './email.js';
import { CEDEAR_RATIOS } from './ratios.js';
import { computeSuggestion, templateRationale } from './advisor.js';
import { aiEnabled, aiRationale, aiScores as aiScoresFn, lastAiError, aiModel, listModels } from './ai.js';
import { signalsEnabled, getSignals, momentumScore, lastSignalError } from './signals.js';
import { reconstruct } from './backfill.js';
import { isEnabled as ssoEnabled, installAuth, apiGuard, pageGuard, currentUser } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', true);
app.use(express.json());

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
  const { amount, risk, strategy, maxPerTicker, maxPerType, maxTickers, include, exclude, note } = req.body || {};
  const { summary } = await buildReport({ withNews: false });

  // Valor y P/G acumulado por ticker (de lo que ya tenés)
  const held = {};
  for (const h of summary.holdings) {
    const g = (held[h.ticker] ??= { value: 0, cost: 0 });
    g.value += h.positionValue || 0;
    g.cost += h.positionCost || 0;
  }
  // Items elegibles = catálogo con cotización
  let items = summary.watch.map(w => ({
    ticker: w.ticker, type: w.type, price: w.price, ratio: w.ratio,
    currentValue: held[w.ticker] ? held[w.ticker].value : 0,
    plPct: held[w.ticker] && held[w.ticker].cost > 0 ? ((held[w.ticker].value - held[w.ticker].cost) / held[w.ticker].cost * 100) : null,
  }));
  if (Array.isArray(include) && include.length) items = items.filter(i => include.includes(i.ticker));
  if (Array.isArray(exclude) && exclude.length) items = items.filter(i => !exclude.includes(i.ticker));

  // Estrategias con análisis: 'ai' (Claude) o 'momentum' (datos de mercado FMP).
  let strat = strategy;
  let scores = null, aiAnalysis = null, notice = null;

  if (strategy === 'ai') {
    if (!aiEnabled()) {
      strat = 'rebalance';
      notice = 'La estrategia con IA necesita ANTHROPIC_API_KEY. Se usó rebalanceo.';
    } else {
      const sig = await getSignals(items.map(i => i.ticker)); // {} si no hay FMP
      const sc = await aiScoresFn(items, { risk, note, signals: sig });
      if (sc && sc.scores) { scores = sc.scores; aiAnalysis = sc.rationale; }
      else { strat = 'rebalance'; const err = lastAiError(); notice = 'No se pudo obtener el análisis de IA' + (err ? ` — ${err}` : '') + '. Se usó rebalanceo.'; }
    }
  } else if (strategy === 'momentum') {
    if (!signalsEnabled()) {
      strat = 'rebalance';
      notice = 'La estrategia de momentum necesita FMP_API_KEY. Se usó rebalanceo.';
    } else {
      const sig = await getSignals(items.map(i => i.ticker));
      if (!Object.keys(sig).length) {
        strat = 'rebalance';
        const err = lastSignalError();
        notice = 'No se pudieron obtener datos de mercado (FMP)' + (err ? ` — ${err}` : '') + '. Se usó rebalanceo.';
      } else {
        scores = {};
        for (const i of items) scores[i.ticker] = momentumScore(sig[i.ticker]);
      }
    }
  }

  const plan = computeSuggestion({ amount, items, prefs: { risk, strategy: strat, maxPerTicker, maxPerType, maxTickers, scores } });
  const rationale = templateRationale(plan);
  // En estrategia IA el "comentario" es el análisis; en las demás, una explicación del plan.
  const ai = aiAnalysis || (strat !== 'ai' ? await aiRationale(plan, note) : null);
  res.json({ plan, rationale, aiRationale: ai, aiEnabled: aiEnabled(), notice });
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
