import express from 'express';
import cron from 'node-cron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  migrate,
  listHoldings, addHolding, updateHolding, deleteHolding,
  listWatchlist, addWatch, deleteWatch,
  listReports, latestReport,
} from './db.js';
import { buildReport, generateReport } from './report.js';
import { providerInfo } from './marketData.js';
import { emailConfigured } from './email.js';
import { CEDEAR_RATIOS } from './ratios.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

const APP_TOKEN = process.env.APP_TOKEN || '';

// ---- Auth opcional para /api ----
app.use('/api', (req, res, next) => {
  if (req.path === '/health') return next();
  if (!APP_TOKEN) return next();
  const token = req.get('x-app-token') || req.query.token;
  if (token === APP_TOKEN) return next();
  return res.status(401).json({ error: 'No autorizado' });
});

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error(e);
  res.status(500).json({ error: e.message });
});

// ---- Salud / config ----
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/config', (_req, res) => res.json({
  provider: providerInfo.PROVIDER,
  marketKey: providerInfo.hasKey,
  emailConfigured: emailConfigured(),
  authRequired: !!APP_TOKEN,
  reportHour: Number(process.env.REPORT_HOUR ?? 8),
  reportMinute: Number(process.env.REPORT_MINUTE ?? 0),
  tz: process.env.TZ || 'UTC',
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

// ---- Watchlist (ABM) ----
app.get('/api/watchlist', wrap(async (_req, res) => res.json(await listWatchlist())));
app.post('/api/watchlist', wrap(async (req, res) => {
  const { ticker, ratio, notes } = req.body;
  if (!ticker) return res.status(400).json({ error: 'ticker es obligatorio' });
  res.json(await addWatch({ ticker, ratio, notes }));
}));
app.delete('/api/watchlist/:id', wrap(async (req, res) => {
  await deleteWatch(Number(req.params.id));
  res.json({ ok: true });
}));

// ---- Dashboard en vivo (precios + analisis, sin enviar mail) ----
app.get('/api/dashboard', wrap(async (_req, res) => {
  const { summary } = await buildReport();
  res.json(summary);
}));

// ---- Reportes ----
app.post('/api/report/run', wrap(async (req, res) => {
  const send = req.body?.send !== false; // por defecto envia
  res.json(await generateReport({ send }));
}));
app.get('/api/reports', wrap(async (_req, res) => res.json(await listReports())));
app.get('/api/reports/latest', wrap(async (_req, res) => {
  const r = await latestReport();
  if (!r) return res.status(404).send('Sin reportes todavia');
  res.set('Content-Type', 'text/html').send(r.html);
}));

// ---- Static UI ----
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
        const r = await generateReport({ send: true });
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
