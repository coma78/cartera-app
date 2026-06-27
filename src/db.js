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

  await query(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS sales (
      id            SERIAL PRIMARY KEY,
      holding_id    INTEGER,
      ticker        TEXT NOT NULL,
      quantity      NUMERIC NOT NULL,
      sell_price    NUMERIC NOT NULL,
      sell_date     DATE,
      buy_price     NUMERIC,
      purchase_date DATE,
      ratio         NUMERIC NOT NULL DEFAULT 1,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
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

// Cambio de ratio (split de CEDEAR): actualiza el ratio del ticker en el
// catálogo Y ajusta las tenencias multiplicando los nominales por el factor
// (newRatio/oldRatio). El precio de compra (de la acción) NO cambia, así que
// el valor y el P&L quedan iguales: solo cambia la cantidad de CEDEARs.
export async function applyRatioChange(ticker, newRatio) {
  const sym = ticker.toUpperCase().trim();
  newRatio = Number(newRatio);
  if (!(newRatio > 0)) throw new Error('Ratio inválido');

  const { rows: wl } = await query('SELECT ratio FROM watchlist WHERE ticker = $1', [sym]);
  if (!wl[0]) throw new Error('El ticker no está en el catálogo de tickers');
  const oldRatio = Number(wl[0].ratio);
  if (!(oldRatio > 0)) throw new Error('Ratio actual inválido');
  if (oldRatio === newRatio) return { ticker: sym, oldRatio, newRatio, factor: 1, holdingsUpdated: 0 };

  const factor = newRatio / oldRatio;
  const { rows: hs } = await query('SELECT id, quantity FROM holdings WHERE ticker = $1', [sym]);
  for (const h of hs) {
    const q = Math.round(Number(h.quantity) * factor);
    await query('UPDATE holdings SET quantity = $2, ratio = $3 WHERE id = $1', [h.id, q, newRatio]);
  }
  await query('UPDATE watchlist SET ratio = $2 WHERE ticker = $1', [sym, newRatio]);
  return { ticker: sym, oldRatio, newRatio, factor, holdingsUpdated: hs.length };
}

export async function deleteAllReports() {
  await query('DELETE FROM reports');
}

export async function deleteReport(id) {
  await query('DELETE FROM reports WHERE id = $1', [id]);
}

// Inserta un reporte con fecha explícita (para reconstrucción histórica).
export async function insertReportAt(createdAt, summary) {
  await query(
    'INSERT INTO reports (created_at, summary, html, emailed) VALUES ($1, $2, $3, $4)',
    [createdAt, summary, '', false]
  );
}

// Borra los snapshots reconstruidos (marcados) para poder rehacerlos sin duplicar.
export async function deleteReconstructedReports() {
  await query(`DELETE FROM reports WHERE (summary->>'reconstructed') = 'true'`);
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

// ---------- Sales (ventas) ----------
export async function listSales() {
  const { rows } = await query('SELECT * FROM sales ORDER BY sell_date DESC NULLS LAST, id DESC');
  return rows;
}

// Vende una cantidad de un lote (holding) específico: descuenta del lote y
// guarda la venta con snapshots del precio/fecha de compra para el historial.
export async function sellFromLot({ holding_id, quantity, sell_price, sell_date }) {
  const id = Number(holding_id);
  const q = Number(quantity);
  const sp = Number(sell_price);
  if (!(q > 0)) throw new Error('La cantidad a vender debe ser mayor a 0');
  if (isNaN(sp)) throw new Error('El precio de venta es obligatorio');
  const { rows } = await query('SELECT * FROM holdings WHERE id = $1', [id]);
  const lot = rows[0];
  if (!lot) throw new Error('La tenencia elegida no existe');
  const remaining = Number(lot.quantity);
  if (q > remaining) throw new Error(`No podés vender ${q}; en ese lote te quedan ${remaining} CEDEARs`);

  await query('UPDATE holdings SET quantity = quantity - $2 WHERE id = $1', [id, q]);
  const ins = await query(
    `INSERT INTO sales (holding_id, ticker, quantity, sell_price, sell_date, buy_price, purchase_date, ratio)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [id, lot.ticker, q, sp, sell_date || null, lot.buy_price, lot.purchase_date, lot.ratio]
  );
  return ins.rows[0];
}

// Borra una venta y, si el lote sigue existiendo, le devuelve la cantidad.
export async function deleteSaleRestore(saleId) {
  const { rows } = await query('SELECT * FROM sales WHERE id = $1', [saleId]);
  const s = rows[0];
  if (!s) return;
  if (s.holding_id) {
    await query('UPDATE holdings SET quantity = quantity + $2 WHERE id = $1', [s.holding_id, Number(s.quantity)]);
  }
  await query('DELETE FROM sales WHERE id = $1', [saleId]);
}

// ---------- Settings ----------
export async function getSetting(key, def = null) {
  const { rows } = await query('SELECT value FROM settings WHERE key = $1', [key]);
  return rows[0] ? rows[0].value : def;
}
export async function setSetting(key, value) {
  await query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, String(value)]
  );
}

export async function listReports(limit = 500) {
  const { rows } = await query(
    'SELECT id, created_at, summary, emailed FROM reports ORDER BY created_at DESC LIMIT $1',
    [limit]
  );
  return rows;
}
