// Lee la "Guía de Recomendaciones" (Google Sheet público, CSV) y arma un mapa
// ticker -> { senal: Comprar|Mantener|Vender, nombre, seccion: RF|RV }.
// La app cruza sus sugerencias contra esto y alerta lo que no figura.
// Se puede cambiar la fuente con GUIDE_CSV_URL (env).

const DEFAULT_URL = 'https://docs.google.com/spreadsheets/d/1ymojTXpZSFj_6F7ax81339n9RzlvBtXi/export?format=csv&gid=1513321094';
const GUIDE_URL = process.env.GUIDE_CSV_URL || DEFAULT_URL;
const TTL = 6 * 3600 * 1000;
let _cache = null, _ts = 0, _lastError = null;

export function guideConfigured() { return !!GUIDE_URL; }
export function lastGuideError() { return _lastError; }

// Parser CSV mínimo (soporta comillas, comas y saltos de línea dentro de celdas).
function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c === '\r') { /* skip */ }
    else cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function normSenal(s) {
  const t = String(s || '').trim().toLowerCase();
  if (t.startsWith('comprar')) return 'Comprar';
  if (t.startsWith('mantener')) return 'Mantener';
  if (t.startsWith('vender')) return 'Vender';
  return null;
}
// Celda con forma "TICKER - Nombre" o "TICKER/D - Nombre" o "S30S6- LECAP".
const TICKER_CELL = /^\s*([A-Z0-9]{1,7})(\/[A-Z0-9]+)?\s*-\s*\S/;

export function parseGuide(csv) {
  const rows = parseCsv(csv);
  const map = {};
  let seccion = null;
  for (const row of rows) {
    const joined = row.join(' ').toUpperCase();
    if (joined.includes('RENTA FIJA')) seccion = 'RF';
    else if (joined.includes('RENTA VARIABLE')) seccion = 'RV';
    else if (joined.includes('FCIS') || joined.includes('FONDOS COMUNES')) seccion = 'FCI';
    for (let i = 0; i < row.length; i++) {
      const cell = String(row[i] || '').trim();
      const m = cell.match(TICKER_CELL);
      if (!m) continue;
      const senal = normSenal(row[i + 1]);
      if (!senal) continue; // sin Comprar/Mantener/Vender al lado -> no es recomendación
      const tk = m[1].toUpperCase();
      if (!map[tk]) map[tk] = { ticker: tk, senal, nombre: cell.replace(/\s+/g, ' ').trim(), seccion };
    }
  }
  return map;
}

export async function getGuide() {
  if (_cache && Date.now() - _ts < TTL) return _cache;
  _lastError = null;
  try {
    const res = await fetch(GUIDE_URL, { redirect: 'follow' });
    if (!res.ok) { _lastError = `HTTP ${res.status}`; }
    else {
      const text = await res.text();
      const map = parseGuide(text);
      if (Object.keys(map).length) { _cache = { map, updated: new Date().toISOString(), count: Object.keys(map).length }; _ts = Date.now(); return _cache; }
      _lastError = 'La guía se leyó vacía (¿es pública?)';
    }
  } catch (e) { _lastError = e.message; }
  return _cache || { map: {}, updated: null, count: 0, error: _lastError };
}
