import pg from 'pg';
import { suggestRatio } from './ratios.js';

const { Pool } = pg;

// Railway / la mayoria de los hosts inyectan DATABASE_URL.
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.warn('[db] DATABASE_URL no esta definida. La app no podra guardar datos.');
}

// SSL solo cuando hace falta (hosts en la nube). En local lo apagamos.
const useSsl = /sslmode=require/.test(connectionString || '') ||
  (process.env.PGSSL === 'true');

export const pool = new Pool({
  connectionString,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
});

export function query(text, params) {
  return pool.query(text, params);
}

// Crea las tablas si no existen. Se ejecuta al arrancar el server.
export async function migrate() {
  await query(`
    CREATE TABLE IF NOT EXISTS holdings (
      id            SERIAL PRIMARY KEY,
      ticker        TEXT NOT NULL,
      buy_price     NUMERIC NOT NULL,
      quantity      NUMERIC NOT NULL DEFAULT 0,
      ratio         NUMERIC NOT NULL DEFAULT 1,
      purchase_date DATE,
      notes         TEXT DEFAULT '',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS watchlist (
      id          SERIAL PRIMARY KEY,
      ticker      TEXT NOT NULL UNIQUE,
      ratio       NUMERIC NOT NULL DEFAULT 1,
      notes       TEXT DEFAULT '',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Migraciones idempotentes para bases ya creadas (deploys existentes).
  await query(`ALTER TABLE holdings ADD COLUMN IF NOT EXISTS ratio NUMERIC NOT NULL DEFAULT 1;`);
  await query(`ALTER TABLE holdings ADD COLUMN IF NOT EXISTS purchase_date DATE;`);
  await query(`ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS ratio NUMERIC NOT NULL DEFAULT 1;`);

  await query(`
    CREATE TABLE IF NOT EXISTS reports (
      id          SERIAL PRIMARY KEY,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      summary     JSONB NOT NULL,
      html        TEXT NOT NULL,
      emailed     BOOLEAN NOT NULL DEFAULT false
    );
  `);

  console.log('[db] migracion ok');
}

// ---------- Holdings ----------
export async function listHoldings() {
  const { rows } = await query('SELECT * FROM holdings ORDER BY ticker ASC');
  return rows;
}

export async function addHolding({ ticker, buy_price, quantity, ratio, purchase_date, notes }) {
  const sym = ticker.toUpperCase().trim();
  const r = ratio && Number(ratio) > 0 ? Number(ratio) : suggestRatio(sym);
  const { rows } = await query(
    `INSERT INTO holdings (ticker, buy_price, quantity, ratio, purchase_date, notes)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [sym, buy_price, quantity || 0, r, purchase_date || null, notes || '']
  );
  return rows[0];
}

export async function updateHolding(id, { ticker, buy_price, quantity, ratio, purchase_date, notes }) {
  const { rows } = await query(
    `UPDATE holdings
       SET ticker = COALESCE($2, ticker),
           buy_price = COALESCE($3, buy_price),
           quantity = COALESCE($4, quantity),
           ratio = COALESCE($5, ratio),
           purchase_date = COALESCE($6, purchase_date),
           notes = COALESCE($7, notes)
     WHERE id = $1 RETURNING *`,
    [id, ticker ? ticker.toUpperCase().trim() : null, buy_price, quantity, ratio, purchase_date || null, notes]
  );
  return rows[0];
}

export async function deleteHolding(id) {
  await query('DELETE FROM holdings WHERE id = $1', [id]);
}

export async function deleteAllHoldings() {
  await query('DELETE FROM holdings');
}

// Inserta varias tenencias de una. Devuelve cuantas se insertaron.
export async function addHoldingsBulk(items = []) {
  let n = 0;
  for (const it of items) {
    if (!it || !it.ticker || it.buy_price == null) continue;
    await addHolding(it);
    n++;
  }
  return n;
}

// ---------- Watchlist ----------
export async function listWatchlist() {
  const { rows } = await query('SELECT * FROM watchlist ORDER BY ticker ASC');
  return rows;
}

export async function addWatch({ ticker, ratio, notes }) {
  const sym = ticker.toUpperCase().trim();
  const r = ratio && Number(ratio) > 0 ? Number(ratio) : suggestRatio(sym);
  const { rows } = await query(
    `INSERT INTO watchlist (ticker, ratio, notes) VALUES ($1, $2, $3)
     ON CONFLICT (ticker) DO UPDATE SET notes = EXCLUDED.notes, ratio = EXCLUDED.ratio
     RETURNING *`,
    [sym, r, notes || '']
  );
  return rows[0];
}

export async function updateWatch(id, { ratio, notes }) {
  const { rows } = await query(
    `UPDATE watchlist
       SET ratio = COALESCE($2, ratio),
           notes = COALESCE($3, notes)
     WHERE id = $1 RETURNING *`,
    [id, ratio != null ? Number(ratio) : null, notes ?? null]
  );
  return rows[0];
}

export async function deleteWatch(id) {
  await query('DELETE FROM watchlist WHERE id = $1', [id]);
}

export async function deleteAllWatch() {
  await query('DELETE FROM watchlist');
}

export async function deleteAllReports() {
  await query('DELETE FROM reports');
}

// ---------- Reports ----------
export async function saveReport({ summary, html, emailed }) {
  const { rows } = await query(
    `INSERT INTO reports (summary, html, emailed) VALUES ($1, $2, $3) RETURNING id, created_at`,
    [summary, html, !!emailed]
  );
  return rows[0];
}

export async function latestReport() {
  const { rows } = await query('SELECT * FROM reports ORDER BY created_at DESC LIMIT 1');
  return rows[0] || null;
}

export async function listReports(limit = 30) {
  const { rows } = await query(
    'SELECT id, created_at, summary, emailed FROM reports ORDER BY created_at DESC LIMIT $1',
    [limit]
  );
  return rows;
}
