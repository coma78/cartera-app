import pg from 'pg';

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
      id          SERIAL PRIMARY KEY,
      ticker      TEXT NOT NULL,
      buy_price   NUMERIC NOT NULL,
      quantity    NUMERIC NOT NULL DEFAULT 0,
      notes       TEXT DEFAULT '',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS watchlist (
      id          SERIAL PRIMARY KEY,
      ticker      TEXT NOT NULL UNIQUE,
      notes       TEXT DEFAULT '',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

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

export async function addHolding({ ticker, buy_price, quantity, notes }) {
  const { rows } = await query(
    `INSERT INTO holdings (ticker, buy_price, quantity, notes)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [ticker.toUpperCase().trim(), buy_price, quantity || 0, notes || '']
  );
  return rows[0];
}

export async function updateHolding(id, { ticker, buy_price, quantity, notes }) {
  const { rows } = await query(
    `UPDATE holdings
       SET ticker = COALESCE($2, ticker),
           buy_price = COALESCE($3, buy_price),
           quantity = COALESCE($4, quantity),
           notes = COALESCE($5, notes)
     WHERE id = $1 RETURNING *`,
    [id, ticker ? ticker.toUpperCase().trim() : null, buy_price, quantity, notes]
  );
  return rows[0];
}

export async function deleteHolding(id) {
  await query('DELETE FROM holdings WHERE id = $1', [id]);
}

// ---------- Watchlist ----------
export async function listWatchlist() {
  const { rows } = await query('SELECT * FROM watchlist ORDER BY ticker ASC');
  return rows;
}

export async function addWatch({ ticker, notes }) {
  const { rows } = await query(
    `INSERT INTO watchlist (ticker, notes) VALUES ($1, $2)
     ON CONFLICT (ticker) DO UPDATE SET notes = EXCLUDED.notes
     RETURNING *`,
    [ticker.toUpperCase().trim(), notes || '']
  );
  return rows[0];
}

export async function deleteWatch(id) {
  await query('DELETE FROM watchlist WHERE id = $1', [id]);
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
