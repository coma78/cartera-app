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
        <td><b>${h.ticker}</b> <span class="muted-sm">CEDEAR · ratio ${h.ratio}</span>${tagsHtml(h.observations)}</td>
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
    field('Precio de compra (por CEDEAR)', 'buy', h?.buy_price ?? '', 'number', '12.50') +
    field('Cantidad de CEDEARs', 'qty', h?.quantity ?? '', 'number', '39') +
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
