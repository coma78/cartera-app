// ---------- Estado / helpers ----------
const TOKEN_KEY = 'cartera_token';
let CONFIG = {};
let RATIOS = {};
const ETFS = new Set(['SPY', 'QQQ', 'EEM', 'EWZ', 'FXI', 'VEA', 'XLV', 'SPXL', 'TQQQ', 'DIA', 'IWM', 'EFA', 'ARKK', 'XLF', 'XLE', 'XLK', 'GLD', 'SLV']);
const tType = (t) => ETFS.has((t || '').toUpperCase()) ? 'ETF' : 'Acción';

let HOLDINGS = [];   // lotes analizados (del dashboard)
let CATALOG = [];    // tickers (watchlist) con ratio
let WATCHLIVE = [];  // watchlist con precio en vivo (del dashboard)
let PAGE = 1;

function token() { return localStorage.getItem(TOKEN_KEY) || ''; }

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (token()) headers['x-app-token'] = token();
  const res = await fetch('/api' + path, { ...opts, headers });
  if (res.status === 401) {
    const body = await res.json().catch(() => ({}));
    if (body.login) { window.location.href = body.login; return new Promise(() => {}); } // SSO: ir al login
    const t = prompt('Esta app pide un token de acceso. Ingresalo:');
    if (t) { localStorage.setItem(TOKEN_KEY, t); return api(path, opts); }
    throw new Error('No autorizado');
  }
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: 'Error ' + res.status }));
    throw new Error(e.error || ('Error ' + res.status));
  }
  return res.json();
}

const round2 = (n) => Math.round(n * 100) / 100;
const money = (n) => n === null || n === undefined ? '—'
  : (CONFIG.currency || 'USD') + ' ' + Number(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pctStr = (n) => n === null || n === undefined ? '—' : (n > 0 ? '+' : '') + round2(n) + '%';
const cls = (n) => n > 0 ? 'pos' : n < 0 ? 'neg' : '';
const fmtDate = (d) => d ? new Date(d).toLocaleDateString('es-AR') : '—';

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 2600);
}
function tagsHtml(obs) {
  return '<div class="tags">' + (obs || []).map(o => `<span class="tag">${o.text}</span>`).join('') + '</div>';
}

// ---------- Carga de datos ----------
async function refreshCatalog() {
  try { CATALOG = await api('/watchlist'); } catch (e) { CATALOG = []; }
}

async function loadDashboard() {
  let data;
  try { data = await api('/dashboard'); }
  catch (e) { toast('Error al cargar: ' + e.message); return; }
  HOLDINGS = data.holdings || [];
  WATCHLIVE = data.watch || [];
  populateFilterOptions();
  renderCartera();
  renderCatalog();
  if (data.errors && data.errors.length) toast('Sin datos para: ' + data.errors.map(e => e.ticker).join(', '));
}

async function loadAll() {
  await refreshCatalog();
  await loadDashboard();
}

// ---------- Filtros ----------
function getFilters() {
  return {
    view: document.getElementById('f-view').value,
    type: document.getElementById('f-type').value,
    ticker: document.getElementById('f-ticker').value,
    year: document.getElementById('f-year').value,
    from: document.getElementById('f-from').value,
    to: document.getElementById('f-to').value,
    pl: document.getElementById('f-pl').value,
    pageSize: parseInt(document.getElementById('f-pagesize').value, 10) || 25,
  };
}

function clearFilters() {
  ['f-type', 'f-ticker', 'f-year', 'f-pl'].forEach(id => { document.getElementById(id).value = ''; });
  document.getElementById('f-from').value = '';
  document.getElementById('f-to').value = '';
  PAGE = 1;
  renderCartera();
}

function applyFilters(lots, f) {
  return lots.filter(h => {
    if (f.type && h.type !== f.type) return false;
    if (f.ticker && h.ticker !== f.ticker) return false;
    const ymd = h.purchase_date ? String(h.purchase_date).slice(0, 10) : '';
    if (f.year && ymd.slice(0, 4) !== f.year) return false;
    if (f.from && (!ymd || ymd < f.from)) return false;
    if (f.to && (!ymd || ymd > f.to)) return false;
    if (f.pl === 'win' && !(h.plPct > 0)) return false;
    if (f.pl === 'loss' && !(h.plPct < 0)) return false;
    return true;
  });
}

// Consolida lotes por ticker (precio de compra promedio ponderado).
function consolidate(lots) {
  const by = {};
  for (const h of lots) {
    const g = (by[h.ticker] ??= {
      ticker: h.ticker, type: h.type, ratio: h.ratio, price: h.price, changePct: h.changePct,
      quantity: 0, shares: 0, cost: 0, value: 0, dates: [], lots: 0,
    });
    const shares = h.ratio > 0 ? h.quantity / h.ratio : 0;
    g.quantity += h.quantity;
    g.shares += shares;
    g.cost += h.positionCost || 0;
    g.value += h.positionValue || 0;
    if (h.purchase_date) g.dates.push(String(h.purchase_date).slice(0, 10));
    g.lots += 1;
  }
  return Object.values(by).map(g => {
    const plAbs = round2(g.value - g.cost);
    const plPct = g.cost > 0 ? round2((plAbs / g.cost) * 100) : null;
    const buyAvg = g.shares > 0 ? round2(g.cost / g.shares) : null;
    g.dates.sort();
    return {
      ticker: g.ticker, type: g.type, ratio: g.ratio, price: g.price, changePct: g.changePct,
      quantity: g.quantity, buy_price: buyAvg, positionValue: round2(g.value),
      positionCost: round2(g.cost), plAbs, plPct, lots: g.lots,
      dateFrom: g.dates[0], dateTo: g.dates[g.dates.length - 1],
    };
  }).sort((a, b) => (b.positionValue || 0) - (a.positionValue || 0));
}

function totalsOf(lots) {
  let value = 0, cost = 0;
  for (const h of lots) { value += h.positionValue || 0; cost += h.positionCost || 0; }
  value = round2(value); cost = round2(cost);
  const pl = round2(value - cost);
  const plPct = cost > 0 ? round2((pl / cost) * 100) : null;
  return { value, cost, pl, plPct };
}

function populateFilterOptions() {
  // Tickers presentes en la cartera
  const tickers = [...new Set(HOLDINGS.map(h => h.ticker))].sort();
  const years = [...new Set(HOLDINGS.map(h => h.purchase_date ? String(h.purchase_date).slice(0, 4) : '').filter(Boolean))].sort();
  const tSel = document.getElementById('f-ticker');
  const ySel = document.getElementById('f-year');
  const keepT = tSel.value, keepY = ySel.value;
  tSel.innerHTML = '<option value="">Todos</option>' + tickers.map(t => `<option>${t}</option>`).join('');
  ySel.innerHTML = '<option value="">Todos</option>' + years.map(y => `<option>${y}</option>`).join('');
  if (tickers.includes(keepT)) tSel.value = keepT;
  if (years.includes(keepY)) ySel.value = keepY;
}

// ---------- Render cartera ----------
function renderCartera() {
  const f = getFilters();
  const filtered = applyFilters(HOLDINGS, f);

  // Totales SIEMPRE sobre el conjunto filtrado completo (no la página)
  const t = totalsOf(filtered);
  const anyFilter = f.type || f.ticker || f.year || f.from || f.to || f.pl;
  document.getElementById('s-scope').textContent = anyFilter ? 'Valor (filtrado)' : 'Valor total';
  document.getElementById('s-value').textContent = money(t.value);
  const pl = document.getElementById('s-pl'); pl.textContent = money(t.pl); pl.className = 'card-value ' + cls(t.pl);
  const plp = document.getElementById('s-plpct'); plp.textContent = pctStr(t.plPct); plp.className = 'card-value ' + cls(t.plPct);

  // Filas a mostrar segun vista
  const rows = f.view === 'consolidated' ? consolidate(filtered) : filtered.slice().sort((a, b) =>
    (b.purchase_date || '').localeCompare(a.purchase_date || ''));

  document.getElementById('s-count-label').textContent = f.view === 'consolidated' ? 'Tickers' : 'Lotes';
  document.getElementById('s-count').textContent = rows.length;

  // Paginado
  const size = f.pageSize;
  const pages = Math.max(1, Math.ceil(rows.length / size));
  if (PAGE > pages) PAGE = pages;
  const start = (PAGE - 1) * size;
  const pageRows = rows.slice(start, start + size);

  const el = document.getElementById('holdings-table');
  if (!rows.length) {
    el.innerHTML = '<div class="empty">' + (HOLDINGS.length ? 'Ningún resultado con esos filtros.' : 'Todavía no cargaste tenencias. Usá “+ Agregar tenencia”.') + '</div>';
  } else if (f.view === 'consolidated') {
    el.innerHTML = `<table><thead><tr>
        <th>Ticker</th><th class="num">Compra prom.</th><th class="num">Actual</th>
        <th class="num">Hoy</th><th class="num">P/G</th><th class="num hide-sm">Valor</th>
      </tr></thead><tbody>${pageRows.map(r => `
        <tr>
          <td><b>${r.ticker}</b> <span class="muted-sm">${r.type} · ${r.quantity} CEDEARs · ${r.lots} lote${r.lots > 1 ? 's' : ''}</span></td>
          <td class="num">${money(r.buy_price)}</td>
          <td class="num">${money(r.price)}</td>
          <td class="num ${cls(r.changePct)}">${pctStr(r.changePct)}</td>
          <td class="num ${cls(r.plPct)}"><b>${pctStr(r.plPct)}</b></td>
          <td class="num hide-sm">${money(r.positionValue)}</td>
        </tr>`).join('')}</tbody></table>`;
  } else {
    el.innerHTML = `<table><thead><tr>
        <th>Ticker</th><th class="num">Compra</th><th class="num">Actual</th>
        <th class="num hide-sm">Fecha</th><th class="num">Hoy</th><th class="num">P/G</th>
        <th class="num hide-sm">Valor</th><th class="num"></th>
      </tr></thead><tbody>${pageRows.map(h => `
        <tr>
          <td><b>${h.ticker}</b> <span class="muted-sm">${h.type} · ${h.quantity} CEDEARs · ratio ${h.ratio}</span>${tagsHtml(h.observations)}</td>
          <td class="num">${money(h.buy_price)}</td>
          <td class="num">${money(h.price)}</td>
          <td class="num hide-sm">${fmtDate(h.purchase_date)}</td>
          <td class="num ${cls(h.changePct)}">${pctStr(h.changePct)}</td>
          <td class="num ${cls(h.plPct)}"><b>${pctStr(h.plPct)}</b></td>
          <td class="num hide-sm">${h.positionValue !== null ? money(h.positionValue) : '—'}</td>
          <td class="num row-actions">
            <button onclick='openHoldingForm(${JSON.stringify(h).replace(/'/g, "&#39;")})'>✏️</button>
            <button onclick="delHolding(${h.id})">🗑️</button>
          </td>
        </tr>`).join('')}</tbody></table>`;
  }

  // Controles de paginado
  const from = rows.length ? start + 1 : 0;
  const to = Math.min(start + size, rows.length);
  document.getElementById('pager-info').textContent = `Mostrando ${from}–${to} de ${rows.length}`;
  document.getElementById('page-label').textContent = `Página ${PAGE} / ${pages}`;
  document.getElementById('prev-page').disabled = PAGE <= 1;
  document.getElementById('next-page').disabled = PAGE >= pages;
}

// ---------- Render catálogo de tickers ----------
function renderCatalog() {
  const live = {};
  for (const w of WATCHLIVE) live[w.ticker] = w;
  const el = document.getElementById('watch-table');
  if (!CATALOG.length) {
    el.innerHTML = '<div class="empty">No hay tickers todavía. Usá “Cargar sugeridos” o “+ Agregar ticker”.</div>';
    return;
  }
  el.innerHTML = `<table><thead><tr>
      <th>Ticker</th><th>Tipo</th><th class="num">Ratio</th>
      <th class="num hide-sm">Precio</th><th class="num hide-sm">Hoy</th><th class="num"></th>
    </tr></thead><tbody>${CATALOG.map(w => {
        const l = live[w.ticker];
        return `<tr>
          <td><b>${w.ticker}</b></td>
          <td>${tType(w.ticker)}</td>
          <td class="num">${w.ratio}</td>
          <td class="num hide-sm">${l ? money(l.price) : '—'}</td>
          <td class="num hide-sm ${l ? cls(l.changePct) : ''}">${l ? pctStr(l.changePct) : '—'}</td>
          <td class="num row-actions">
            <button onclick='openWatchForm(${JSON.stringify(w).replace(/'/g, "&#39;")})'>✏️</button>
            <button onclick="delWatch(${w.id})">🗑️</button>
          </td>
        </tr>`;
      }).join('')}</tbody></table>`;
}

// ---------- Reportes ----------
async function loadReports() {
  const rows = await api('/reports').catch(() => []);
  const el = document.getElementById('reports-list');
  if (!rows.length) { el.innerHTML = '<div class="empty">Todavía no se generó ningún reporte.</div>'; return; }
  el.innerHTML = `<table><tbody>${rows.map(r => `
    <tr>
      <td>${new Date(r.created_at).toLocaleString('es-AR')}</td>
      <td class="num ${cls(r.summary.totalPlPct)}">${pctStr(r.summary.totalPlPct)}</td>
      <td class="num">${r.emailed ? '✉️ enviado' : '—'}</td>
    </tr>`).join('')}</tbody></table>`;
}

// ---------- Modal ----------
const modal = document.getElementById('modal');
function closeModal() { modal.classList.add('hidden'); }
function field(label, id, value = '', type = 'text', ph = '') {
  return `<label>${label}</label><input id="f-${id}" type="${type}" value="${value ?? ''}" placeholder="${ph}">`;
}

// Tenencia: ticker desplegable desde el catálogo, ratio heredado
function openHoldingForm(h = null) {
  if (!CATALOG.length) { toast('Primero agregá tickers en la lista de deseables'); return; }
  document.getElementById('modal-title').textContent = h ? 'Editar tenencia' : 'Nueva tenencia';
  const dateVal = h?.purchase_date ? String(h.purchase_date).slice(0, 10) : '';
  const opts = CATALOG.map(c => `<option value="${c.ticker}" data-ratio="${c.ratio}" ${h && h.ticker === c.ticker ? 'selected' : ''}>${c.ticker} (ratio ${c.ratio})</option>`).join('');
  document.getElementById('modal-body').innerHTML = `
    <label>Ticker (del catálogo)</label>
    <select id="f-ticker-sel">${opts}</select>
    <label>Ratio (heredado del ticker)</label>
    <input id="f-ratio" type="number" value="${h?.ratio ?? ''}" readonly style="background:#f4f6f9">
    ${field('Precio de compra — de la acción US (USD)', 'buy', h?.buy_price ?? '', 'number', '334.25')}
    ${field('Nominales (cantidad de CEDEARs)', 'qty', h?.quantity ?? '', 'number', '90')}
    ${field('Fecha de compra', 'pdate', dateVal, 'date')}
    ${field('Notas (opcional)', 'notes', h?.notes || '')}`;
  const sel = document.getElementById('f-ticker-sel');
  const rEl = document.getElementById('f-ratio');
  const syncRatio = () => { rEl.value = sel.selectedOptions[0]?.dataset.ratio || ''; };
  if (!h) syncRatio();
  sel.addEventListener('change', syncRatio);
  document.getElementById('modal-save').onclick = async () => {
    const body = {
      ticker: sel.value,
      buy_price: parseFloat(document.getElementById('f-buy').value),
      quantity: parseFloat(document.getElementById('f-qty').value) || 0,
      ratio: parseFloat(rEl.value) || null,
      purchase_date: document.getElementById('f-pdate').value || null,
      notes: document.getElementById('f-notes').value,
    };
    if (!body.ticker || isNaN(body.buy_price)) return toast('Ticker y precio son obligatorios');
    try {
      if (h) await api('/holdings/' + h.id, { method: 'PUT', body: JSON.stringify(body) });
      else await api('/holdings', { method: 'POST', body: JSON.stringify(body) });
      closeModal(); toast('Guardado'); loadDashboard();
    } catch (e) { toast(e.message); }
  };
  modal.classList.remove('hidden');
}

// Ticker del catálogo: alta o edición de ratio
function openWatchForm(w = null) {
  document.getElementById('modal-title').textContent = w ? `Editar ${w.ticker}` : 'Agregar ticker';
  document.getElementById('modal-body').innerHTML =
    field('Ticker (ej. NVDA)', 'wticker', w?.ticker || '', 'text', 'NVDA') +
    field('Ratio (CEDEARs por acción)', 'wratio', w?.ratio ?? '', 'number', '1') +
    field('Notas (opcional)', 'wnotes', w?.notes || '');
  const tEl = document.getElementById('f-wticker');
  const rEl = document.getElementById('f-wratio');
  if (w) tEl.setAttribute('readonly', 'true');
  const fill = () => { const s = RATIOS[tEl.value.toUpperCase().trim()]; if (s && !rEl.value) rEl.value = s; };
  tEl.addEventListener('input', fill); tEl.addEventListener('blur', fill);
  document.getElementById('modal-save').onclick = async () => {
    const body = { ticker: tEl.value.trim(), ratio: parseFloat(rEl.value) || null, notes: document.getElementById('f-wnotes').value };
    if (!body.ticker) return toast('El ticker es obligatorio');
    try {
      if (w) await api('/watchlist/' + w.id, { method: 'PUT', body: JSON.stringify({ ratio: body.ratio, notes: body.notes }) });
      else await api('/watchlist', { method: 'POST', body: JSON.stringify(body) });
      closeModal(); toast('Guardado'); loadAll();
    } catch (e) { toast(e.message); }
  };
  modal.classList.remove('hidden');
}

async function loadSuggestedTickers() {
  if (!confirm('¿Cargar los tickers sugeridos con sus ratios (AVGO, MSFT, GOOGL, etc.)?')) return;
  try {
    const r = await api('/admin/seed-tickers', { method: 'POST', body: '{}' });
    toast(`Cargados ${r.tickers} tickers`); loadAll();
  } catch (e) { toast(e.message); }
}

async function loadMyHoldings() {
  if (!confirm('¿Cargar tus compras desde el archivo incluido (data/holdings.json)?')) return;
  try {
    const r = await api('/admin/seed-holdings', { method: 'POST', body: JSON.stringify({ reset: false }) });
    toast(`Cargadas ${r.inserted} compras · ${r.tickers} tickers`); loadAll();
  } catch (e) { toast(e.message); }
}

async function resetDb() {
  if (!confirm('Esto borra TODO: tenencias, tickers y reportes. ¿Empezar de 0?')) return;
  if (!confirm('Confirmá una vez más: se borra todo y no se puede deshacer.')) return;
  try {
    await api('/admin/reset', { method: 'POST', body: '{}' });
    toast('Base limpia. Cargá tickers y compras.'); loadAll(); loadReports();
  } catch (e) { toast(e.message); }
}

// ---------- Importación masiva ----------
function normNum(s) { return parseFloat(String(s).replace(/\./g, '').replace(',', '.')); }
function normDate(d) {
  const m = d.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/); if (!m) return null;
  let [, dd, mm, yy] = m; if (yy.length === 2) yy = String(2000 + parseInt(yy, 10));
  return `${yy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}
function parseHoldingsText(text) {
  const items = [], errors = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line) continue;
    const m = line.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})\s+([A-Za-z.]{1,6})\s+\$?\s*([\d.,]+)\s+(\d+)/);
    if (!m) { errors.push(line); continue; }
    const [, date, tk, val, qty] = m;
    const ticker = tk.toUpperCase();
    items.push({ purchase_date: normDate(date), ticker, buy_price: normNum(val), quantity: parseInt(qty, 10), ratio: RATIOS[ticker] || null });
  }
  return { items, errors };
}

function openImportForm() {
  document.getElementById('modal-title').textContent = 'Importar lista de compras';
  document.getElementById('modal-body').innerHTML = `
    <p style="font-size:12px;color:#7a8190;margin:0 0 8px">
      Pegá tus filas con columnas: <b>fecha · ticker · precio acción · nominales</b>
      (ej. <code>13/8/24 MSFT $ 410,75 10</code>). Los tickers se agregan al catálogo solos.
    </p>
    <textarea id="f-import" rows="9" placeholder="13/8/24  MSFT  $ 410,75  10"></textarea>
    <label style="display:flex;align-items:center;gap:8px;margin-top:10px;font-size:13px;color:#1c1c1c">
      <input type="checkbox" id="f-reset" style="width:auto"> Reemplazar lo que ya tengo cargado (borrar antes)
    </label>
    <div id="import-preview" style="font-size:12px;color:#7a8190;margin-top:8px"></div>`;
  const ta = document.getElementById('f-import');
  const prev = document.getElementById('import-preview');
  ta.addEventListener('input', () => {
    const { items, errors } = parseHoldingsText(ta.value);
    prev.textContent = ta.value.trim() ? `Detectadas ${items.length} filas` + (errors.length ? ` · ${errors.length} no reconocidas` : '') : '';
  });
  document.getElementById('modal-save').onclick = async () => {
    const { items, errors } = parseHoldingsText(ta.value);
    if (!items.length) return toast('No se detectaron filas válidas');
    if (errors.length && !confirm(`${errors.length} líneas no se reconocieron y se omitirán. ¿Importar las ${items.length} válidas?`)) return;
    const reset = document.getElementById('f-reset').checked;
    try {
      const r = await api('/holdings/bulk', { method: 'POST', body: JSON.stringify({ items, reset }) });
      closeModal(); toast(`Importadas ${r.inserted} tenencias`); loadAll();
    } catch (e) { toast(e.message); }
  };
  modal.classList.remove('hidden');
}

async function delHolding(id) {
  if (!confirm('¿Eliminar esta tenencia?')) return;
  await api('/holdings/' + id, { method: 'DELETE' }); toast('Eliminada'); loadDashboard();
}
async function delWatch(id) {
  if (!confirm('¿Quitar este ticker del catálogo?')) return;
  await api('/watchlist/' + id, { method: 'DELETE' }); toast('Quitado'); loadAll();
}

// ---------- Status + run ----------
async function loadConfig() {
  try {
    CONFIG = await api('/config');
    CONFIG.currency = CONFIG.currency || 'USD';
    const pill = document.getElementById('status-pill');
    const parts = [];
    parts.push(CONFIG.marketKey ? 'datos ✓' : 'datos: modo demo');
    parts.push(CONFIG.emailConfigured ? 'mail ✓' : 'mail sin configurar');
    parts.push(`reporte ${String(CONFIG.reportHour).padStart(2, '0')}:${String(CONFIG.reportMinute).padStart(2, '0')}`);
    pill.textContent = parts.join(' · ');
    pill.className = 'pill ' + (CONFIG.marketKey && CONFIG.emailConfigured ? 'ok' : 'warn');
    if (CONFIG.sso && CONFIG.user) {
      const up = document.getElementById('user-pill');
      up.textContent = CONFIG.user; up.className = 'pill ok';
      document.getElementById('logout-link').style.display = '';
    }
  } catch (e) { /* noop */ }
}

document.getElementById('btn-run').onclick = async function () {
  this.disabled = true; this.textContent = 'Generando…';
  try {
    const r = await api('/report/run', { method: 'POST', body: JSON.stringify({ send: true }) });
    toast(r.emailResult.sent ? 'Reporte generado y enviado por mail ✉️' : 'Reporte generado (mail: ' + r.emailResult.reason + ')');
    loadReports();
  } catch (e) { toast(e.message); }
  this.disabled = false; this.textContent = 'Generar reporte ahora';
};

// ---------- Eventos de filtros / paginado ----------
function bindFilters() {
  ['f-view', 'f-type', 'f-ticker', 'f-year', 'f-from', 'f-to', 'f-pl', 'f-pagesize'].forEach(id => {
    document.getElementById(id).addEventListener('change', () => { PAGE = 1; renderCartera(); });
  });
  document.getElementById('prev-page').onclick = () => { if (PAGE > 1) { PAGE--; renderCartera(); } };
  document.getElementById('next-page').onclick = () => { PAGE++; renderCartera(); };
}

// ---------- Init ----------
(async function init() {
  bindFilters();
  await loadConfig();
  try { RATIOS = await api('/ratios'); } catch (e) { RATIOS = {}; }
  await loadAll();
  await loadReports();
})();
