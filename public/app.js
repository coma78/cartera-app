// ---------- Estado / helpers ----------
const TOKEN_KEY = 'cartera_token';
let CONFIG = {};
let RATIOS = {};

function token() { return localStorage.getItem(TOKEN_KEY) || ''; }

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (token()) headers['x-app-token'] = token();
  const res = await fetch('/api' + path, { ...opts, headers });
  if (res.status === 401) {
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

const money = (n) => n === null || n === undefined ? '—'
  : (CONFIG.currency || 'USD') + ' ' + Number(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pctStr = (n) => n === null || n === undefined ? '—' : (n > 0 ? '+' : '') + n + '%';
const cls = (n) => n > 0 ? 'pos' : n < 0 ? 'neg' : '';

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 2600);
}

// ---------- Render dashboard ----------
async function loadDashboard() {
  let data;
  try { data = await api('/dashboard'); }
  catch (e) { toast('Error al cargar: ' + e.message); return; }

  document.getElementById('s-value').textContent = money(data.totalValue);
  const pl = document.getElementById('s-pl');
  pl.textContent = money(data.totalPl); pl.className = 'card-value ' + cls(data.totalPl);
  const plp = document.getElementById('s-plpct');
  plp.textContent = pctStr(data.totalPlPct); plp.className = 'card-value ' + cls(data.totalPlPct);
  document.getElementById('s-count').textContent = data.count;

  renderHoldings(data.holdings || []);
  renderWatch(data.watch || []);
  if (data.errors && data.errors.length) toast('Sin datos para: ' + data.errors.map(e => e.ticker).join(', '));
}

function tagsHtml(obs) {
  return '<div class="tags">' + (obs || []).map(o => `<span class="tag">${o.text}</span>`).join('') + '</div>';
}

function fmtDate(d) { return d ? new Date(d).toLocaleDateString('es-AR') : '—'; }

function renderHoldings(rows) {
  const el = document.getElementById('holdings-table');
  if (!rows.length) { el.innerHTML = '<div class="empty">Todavía no cargaste tenencias. Usá “+ Agregar tenencia”.</div>'; return; }
  el.innerHTML = `<table><thead><tr>
      <th>Ticker</th>
      <th class="num">Compra</th>
      <th class="num">Actual</th>
      <th class="num hide-sm">Fecha</th>
      <th class="num">Hoy</th>
      <th class="num">P/G</th>
      <th class="num hide-sm">Valor</th>
      <th class="num"></th>
    </tr></thead><tbody>${rows.map(h => `
      <tr>
        <td><b>${h.ticker}</b> <span class="muted-sm">${h.quantity} CEDEARs · ratio ${h.ratio}</span>${tagsHtml(h.observations)}</td>
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

function renderWatch(rows) {
  const el = document.getElementById('watch-table');
  if (!rows.length) { el.innerHTML = '<div class="empty">Sin tickers de seguimiento. Usá “+ Agregar a seguimiento”.</div>'; return; }
  el.innerHTML = `<table><thead><tr>
      <th>Ticker</th><th class="num">Precio</th><th class="num">Hoy</th><th class="num"></th>
    </tr></thead><tbody>${rows.map(w => `
      <tr>
        <td><b>${w.ticker}</b> <span class="muted-sm">ratio ${w.ratio}</span>${tagsHtml(w.observations)}</td>
        <td class="num">${money(w.price)}</td>
        <td class="num ${cls(w.changePct)}">${pctStr(w.changePct)}</td>
        <td class="num row-actions"><button onclick="delWatch(${w.id})">🗑️</button></td>
      </tr>`).join('')}</tbody></table>`;
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

// ---------- Modal ABM ----------
const modal = document.getElementById('modal');
function closeModal() { modal.classList.add('hidden'); }
function field(label, id, value = '', type = 'text', ph = '') {
  return `<label>${label}</label><input id="f-${id}" type="${type}" value="${value ?? ''}" placeholder="${ph}">`;
}

function openHoldingForm(h = null) {
  document.getElementById('modal-title').textContent = h ? 'Editar tenencia' : 'Nueva tenencia (CEDEAR)';
  const dateVal = h?.purchase_date ? String(h.purchase_date).slice(0, 10) : '';
  document.getElementById('modal-body').innerHTML =
    field('Ticker (ej. AVGO)', 'ticker', h?.ticker || '', 'text', 'AVGO') +
    field('Precio de compra — de la acción US (USD)', 'buy', h?.buy_price ?? '', 'number', '334.25') +
    field('Nominales (cantidad de CEDEARs)', 'qty', h?.quantity ?? '', 'number', '90') +
    field('Ratio (CEDEARs por acción)', 'ratio', h?.ratio ?? '', 'number', '39') +
    field('Fecha de compra', 'pdate', dateVal, 'date') +
    field('Notas (opcional)', 'notes', h?.notes || '');
  // Autocompletar el ratio segun el ticker (solo si el campo esta vacio).
  const tEl = document.getElementById('f-ticker');
  const rEl = document.getElementById('f-ratio');
  const fill = () => { const s = RATIOS[tEl.value.toUpperCase().trim()]; if (s && !rEl.value) rEl.value = s; };
  tEl.addEventListener('input', fill); tEl.addEventListener('blur', fill);
  document.getElementById('modal-save').onclick = async () => {
    const body = {
      ticker: tEl.value.trim(),
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

function openWatchForm() {
  document.getElementById('modal-title').textContent = 'Agregar a seguimiento';
  document.getElementById('modal-body').innerHTML =
    field('Ticker (ej. NVDA)', 'wticker', '', 'text', 'NVDA') +
    field('Ratio CEDEAR (opcional)', 'wratio', '', 'number', '1') +
    field('Notas (opcional)', 'wnotes', '');
  const tEl = document.getElementById('f-wticker');
  const rEl = document.getElementById('f-wratio');
  const fill = () => { const s = RATIOS[tEl.value.toUpperCase().trim()]; if (s && !rEl.value) rEl.value = s; };
  tEl.addEventListener('input', fill); tEl.addEventListener('blur', fill);
  document.getElementById('modal-save').onclick = async () => {
    const body = {
      ticker: tEl.value.trim(),
      ratio: parseFloat(rEl.value) || null,
      notes: document.getElementById('f-wnotes').value,
    };
    if (!body.ticker) return toast('El ticker es obligatorio');
    try { await api('/watchlist', { method: 'POST', body: JSON.stringify(body) }); closeModal(); toast('Agregado'); loadDashboard(); }
    catch (e) { toast(e.message); }
  };
  modal.classList.remove('hidden');
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
    items.push({
      purchase_date: normDate(date),
      ticker,
      buy_price: normNum(val),
      quantity: parseInt(qty, 10),
      ratio: RATIOS[ticker] || null,
    });
  }
  return { items, errors };
}

function openImportForm() {
  document.getElementById('modal-title').textContent = 'Importar lista de compras';
  document.getElementById('modal-body').innerHTML = `
    <p style="font-size:12px;color:#7a8190;margin:0 0 8px">
      Pegá tus filas con columnas: <b>fecha · ticker · precio acción · nominales</b>
      (ej. <code>13/8/24 MSFT $ 410,75 10</code>). El ratio se completa solo.
    </p>
    <textarea id="f-import" rows="9" placeholder="13/8/24\tMSFT\t$ 410,75\t10"></textarea>
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
      closeModal(); toast(`Importadas ${r.inserted} tenencias`); loadDashboard();
    } catch (e) { toast(e.message); }
  };
  modal.classList.remove('hidden');
}

async function delHolding(id) {
  if (!confirm('¿Eliminar esta tenencia?')) return;
  await api('/holdings/' + id, { method: 'DELETE' }); toast('Eliminada'); loadDashboard();
}
async function delWatch(id) {
  if (!confirm('¿Quitar de seguimiento?')) return;
  await api('/watchlist/' + id, { method: 'DELETE' }); toast('Quitado'); loadDashboard();
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

// ---------- Init ----------
(async function init() {
  await loadConfig();
  try { RATIOS = await api('/ratios'); } catch (e) { RATIOS = {}; }
  await loadDashboard();
  await loadReports();
})();
