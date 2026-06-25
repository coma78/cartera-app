// ---------- Estado / helpers ----------
const TOKEN_KEY = 'cartera_token';
const SEC_KEY = 'cartera_sec';
let CONFIG = {};
let RATIOS = {};
const ETFS = new Set(['SPY', 'QQQ', 'EEM', 'EWZ', 'FXI', 'VEA', 'XLV', 'SPXL', 'TQQQ', 'DIA', 'IWM', 'EFA', 'ARKK', 'XLF', 'XLE', 'XLK', 'GLD', 'SLV']);
const tType = (t) => ETFS.has((t || '').toUpperCase()) ? 'ETF' : 'Acción';

let HOLDINGS = [];
let CATALOG = [];
let WATCHLIVE = [];
let REPORTS = [];
let SETTINGS = { dailyEmail: true };
let PAGE = 1;
let CURRENT_SEC = 'resumen';
let DIST_MODE = 'ticker';
let EVO_MODE = 'mercado';
let LAST_CARTERA = { rows: [], view: 'lots' };
let LAST_SUGGEST = null;
const CHARTS = {};
let HIDE_MONEY = true;          // por defecto los montos están ocultos
const IDLE_MS = 5 * 60 * 1000;  // cierre de sesión por inactividad
let idleTimer = null;

function token() { return localStorage.getItem(TOKEN_KEY) || ''; }

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (token()) headers['x-app-token'] = token();
  const res = await fetch('/api' + path, { ...opts, headers });
  if (res.status === 401) {
    const body = await res.json().catch(() => ({}));
    if (body.login) { window.location.href = body.login; return new Promise(() => {}); }
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
const money = (n) => {
  if (n === null || n === undefined) return '—';
  if (HIDE_MONEY) return '••••';
  return (CONFIG.currency || 'USD') + ' ' + Number(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
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

// ---------- Privacidad de montos (ojito) ----------
function setEye() {
  const b = document.getElementById('btn-eye');
  if (!b) return;
  b.textContent = HIDE_MONEY ? '👁️ Montos' : '🙈 Montos';
  b.title = HIDE_MONEY ? 'Mostrar montos' : 'Ocultar montos';
}
function toggleMoney() { HIDE_MONEY = !HIDE_MONEY; setEye(); renderSection(CURRENT_SEC); }

// ---------- Cierre por inactividad ----------
function resetIdle() {
  if (!CONFIG.sso) return;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { window.location.href = '/auth/logout'; }, IDLE_MS);
}
function startIdle() {
  if (!CONFIG.sso) return;
  ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'].forEach(ev => document.addEventListener(ev, resetIdle, { passive: true }));
  resetIdle();
}

// ---------- Navegación ----------
const SEC_TITLES = { resumen: 'Resumen', cartera: 'Cartera', sugerencias: 'Sugerencias', tickers: 'Tickers', tenencias: 'Tenencias', reportes: 'Reportes diarios' };
function showSection(sec) {
  CURRENT_SEC = sec;
  localStorage.setItem(SEC_KEY, sec);
  document.querySelectorAll('.section').forEach(s => s.classList.add('hidden'));
  document.getElementById('sec-' + sec).classList.remove('hidden');
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.sec === sec));
  document.getElementById('sec-title').textContent = SEC_TITLES[sec] || sec;
  document.querySelector('.sidebar').classList.remove('open');
  renderSection(sec);
}
function renderSection(sec) {
  if (sec === 'resumen') renderResumen();
  else if (sec === 'cartera') renderCartera();
  else if (sec === 'sugerencias') renderSugerencias();
  else if (sec === 'tickers') renderCatalog();
  else if (sec === 'tenencias') renderManage();
  else if (sec === 'reportes') renderReportsList();
}

// ---------- Carga de datos ----------
async function refreshCatalog() {
  try { CATALOG = await api('/watchlist'); } catch (e) { CATALOG = []; }
}
async function loadDashboard(fresh = false) {
  let data;
  try { data = await api('/dashboard' + (fresh ? '?fresh=1' : '')); }
  catch (e) { toast('Error al cargar: ' + e.message); return; }
  HOLDINGS = data.holdings || [];
  WATCHLIVE = data.watch || [];
  populateFilterOptions();
  const u = document.getElementById('quotes-updated');
  if (u) u.textContent = 'Actualizado ' + new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  if (data.errors && data.errors.length) toast('Sin datos para: ' + data.errors.map(e => e.ticker).join(', '));
}

// Refresca cotizaciones del día (ignora el caché) y vuelve a dibujar
async function refreshQuotes() {
  const b = document.getElementById('btn-refresh');
  const orig = b.textContent; b.disabled = true; b.textContent = 'Actualizando…';
  try {
    await loadDashboard(true);
    renderSection(CURRENT_SEC);
    toast('Cotizaciones actualizadas');
  } catch (e) { toast(e.message); }
  b.disabled = false; b.textContent = orig;
}
async function loadReports() {
  REPORTS = await api('/reports').catch(() => []);
}
async function loadSettings() {
  try { SETTINGS = await api('/settings'); } catch (e) { SETTINGS = { dailyEmail: true }; }
  const chk = document.getElementById('chk-daily-email');
  if (chk) chk.checked = !!SETTINGS.dailyEmail;
}
async function loadAll() {
  await refreshCatalog();
  await loadDashboard();
  await loadReports();
  await loadSettings();
  renderSection(CURRENT_SEC);
}

// ---------- Filtros / cálculos ----------
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
  document.getElementById('f-from').value = ''; document.getElementById('f-to').value = '';
  PAGE = 1; renderCartera();
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
function consolidate(lots) {
  const by = {};
  for (const h of lots) {
    const g = (by[h.ticker] ??= { ticker: h.ticker, type: h.type, ratio: h.ratio, price: h.price, changePct: h.changePct, quantity: 0, shares: 0, cost: 0, value: 0, lots: 0 });
    const shares = h.ratio > 0 ? h.quantity / h.ratio : 0;
    g.quantity += h.quantity; g.shares += shares; g.cost += h.positionCost || 0; g.value += h.positionValue || 0; g.lots += 1;
  }
  return Object.values(by).map(g => {
    const plAbs = round2(g.value - g.cost);
    const plPct = g.cost > 0 ? round2((plAbs / g.cost) * 100) : null;
    return {
      ticker: g.ticker, type: g.type, ratio: g.ratio, price: g.price, changePct: g.changePct,
      quantity: g.quantity, buy_price: g.shares > 0 ? round2(g.cost / g.shares) : null,
      positionValue: round2(g.value), positionCost: round2(g.cost), plAbs, plPct, lots: g.lots,
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
  const tickers = [...new Set(HOLDINGS.map(h => h.ticker))].sort();
  const years = [...new Set(HOLDINGS.map(h => h.purchase_date ? String(h.purchase_date).slice(0, 4) : '').filter(Boolean))].sort();
  const tSel = document.getElementById('f-ticker'), ySel = document.getElementById('f-year');
  const kt = tSel.value, ky = ySel.value;
  tSel.innerHTML = '<option value="">Todos</option>' + tickers.map(t => `<option>${t}</option>`).join('');
  ySel.innerHTML = '<option value="">Todos</option>' + years.map(y => `<option>${y}</option>`).join('');
  if (tickers.includes(kt)) tSel.value = kt;
  if (years.includes(ky)) ySel.value = ky;
}

// ---------- RESUMEN ----------
function renderResumen() {
  const t = totalsOf(HOLDINGS);
  document.getElementById('s-value').textContent = money(t.value);
  const pl = document.getElementById('s-pl'); pl.textContent = money(t.pl); pl.className = 'card-value ' + cls(t.pl);
  const plp = document.getElementById('s-plpct'); plp.textContent = pctStr(t.plPct); plp.className = 'card-value ' + cls(t.plPct);
  document.getElementById('s-count').textContent = HOLDINGS.length;
  if (typeof Chart === 'undefined') return;
  renderDist(); renderWinLoss(); renderEvolution(); renderYearTable();
}

function renderDist() {
  const rows = consolidate(HOLDINGS).filter(r => r.positionValue > 0);
  let labels, data;
  if (DIST_MODE === 'type') {
    const by = {}; rows.forEach(r => by[r.type] = (by[r.type] || 0) + r.positionValue);
    labels = Object.keys(by); data = Object.values(by);
  } else {
    labels = rows.map(r => r.ticker); data = rows.map(r => r.positionValue);
  }
  const total = data.reduce((a, b) => a + b, 0);
  drawChart('dist', 'chart-dist', {
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: palette(labels.length) }] },
    options: {
      plugins: {
        legend: { position: 'right', labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: { callbacks: { label: (ctx) => {
          const v = ctx.parsed; const p = total ? Math.round((v / total) * 1000) / 10 : 0;
          return HIDE_MONEY ? `${ctx.label}: ${p}%` : `${ctx.label}: ${money(v)} (${p}%)`;
        } } },
      },
      maintainAspectRatio: false,
    },
  });
}

function renderWinLoss() {
  const rows = consolidate(HOLDINGS).filter(r => r.plPct !== null);
  const sorted = [...rows].sort((a, b) => b.plPct - a.plPct);
  const top = sorted.slice(0, 5), bottom = sorted.slice(-5).filter(x => !top.includes(x));
  const sel = [...top, ...bottom];
  drawChart('wl', 'chart-wl', {
    type: 'bar',
    data: {
      labels: sel.map(r => r.ticker),
      datasets: [{ data: sel.map(r => r.plPct), backgroundColor: sel.map(r => r.plPct >= 0 ? '#0a7d33' : '#c0271a') }],
    },
    options: {
      indexAxis: 'y', plugins: { legend: { display: false } }, maintainAspectRatio: false,
      scales: { x: { ticks: { callback: v => v + '%' } } },
    },
  });
}

function renderEvolution() {
  const r = [...REPORTS].reverse(); // cronologico
  const labels = r.map(x => new Date(x.created_at).toLocaleDateString('es-AR'));
  const pct = r.map(x => x.summary?.totalPlPct ?? null);
  if (r.length < 1) { destroyChart('evo'); return; }
  let datasets, scales;
  if (EVO_MODE === 'capital') {
    // Aportes/retiros: valor de mercado vs. capital invertido
    const value = r.map(x => x.summary?.totalValue ?? null);
    const cost = r.map(x => x.summary?.totalCost ?? null);
    datasets = [
      { label: 'Valor de mercado', data: value, borderColor: '#1a5fb4', backgroundColor: 'rgba(26,95,180,.1)', tension: .25, fill: true },
      { label: 'Capital invertido', data: cost, borderColor: '#7a8190', borderDash: [5, 4], tension: .25 },
    ];
    scales = { y: { position: 'left', ticks: { display: !HIDE_MONEY } } };
  } else {
    // Mercado: rendimiento % (performance pura, no afectada por aportes)
    datasets = [{ label: 'Rendimiento %', data: pct, borderColor: '#0a7d33', backgroundColor: 'rgba(10,125,51,.1)', tension: .25, fill: true }];
    scales = { y: { position: 'left', ticks: { callback: v => v + '%' } } };
  }
  drawChart('evo', 'chart-evo', {
    type: 'line',
    data: { labels, datasets },
    options: {
      maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      plugins: { tooltip: { callbacks: { label: (ctx) =>
        EVO_MODE === 'capital' ? `${ctx.dataset.label}: ${money(ctx.parsed.y)}` : `${ctx.dataset.label}: ${ctx.parsed.y}%`
      } } },
      scales,
    },
  });
}

// Rendimiento por año de cada ticker (matriz ticker x año)
function renderYearTable() {
  const el = document.getElementById('year-table');
  if (!HOLDINGS.length) { el.innerHTML = '<div class="empty">Sin datos.</div>'; return; }
  const years = [...new Set(HOLDINGS.map(h => yearOf(h)).filter(Boolean))].sort();
  const tickers = [...new Set(HOLDINGS.map(h => h.ticker))].sort();
  const acc = {}; // ticker -> year -> {cost,value}
  for (const h of HOLDINGS) {
    const y = yearOf(h); if (!y) continue;
    ((acc[h.ticker] ??= {})[y] ??= { cost: 0, value: 0 });
    acc[h.ticker][y].cost += h.positionCost || 0;
    acc[h.ticker][y].value += h.positionValue || 0;
  }
  const cell = (c) => {
    if (!c || !c.cost) return '<td class="muted-sm">—</td>';
    const p = round2(((c.value - c.cost) / c.cost) * 100);
    return `<td class="${cls(p)}">${pctStr(p)}</td>`;
  };
  const colTotals = {};
  let head = '<table class="heat"><thead><tr><th>Ticker</th>' + years.map(y => `<th class="num">${y}</th>`).join('') + '<th class="num">Total</th></tr></thead><tbody>';
  const body = tickers.map(tk => {
    let tc = 0, tv = 0;
    const cells = years.map(y => {
      const c = acc[tk]?.[y];
      if (c) { tc += c.cost; tv += c.value; colTotals[y] = colTotals[y] || { cost: 0, value: 0 }; colTotals[y].cost += c.cost; colTotals[y].value += c.value; }
      return cell(c);
    }).join('');
    const tot = tc ? round2(((tv - tc) / tc) * 100) : null;
    return `<tr><td><b>${tk}</b></td>${cells}<td class="${cls(tot)}"><b>${pctStr(tot)}</b></td></tr>`;
  }).join('');
  const totRow = '<tr><td><b>Total</b></td>' + years.map(y => {
    const c = colTotals[y]; const p = c && c.cost ? round2(((c.value - c.cost) / c.cost) * 100) : null;
    return `<td class="${cls(p)}"><b>${pctStr(p)}</b></td>`;
  }).join('') + (() => { const t = totalsOf(HOLDINGS); return `<td class="${cls(t.plPct)}"><b>${pctStr(t.plPct)}</b></td>`; })() + '</tr>';
  el.innerHTML = head + body + totRow + '</tbody></table>';
}
function yearOf(h) { return h.purchase_date ? String(h.purchase_date).slice(0, 4) : ''; }

function palette(n) {
  const base = ['#1a5fb4', '#0a7d33', '#c0271a', '#e08a00', '#6f42c1', '#17a2b8', '#d63384', '#2b8a3e', '#856404', '#0c5460', '#5f3dc4', '#b02a37', '#087990', '#9c6644', '#3b5bdb', '#2f9e44', '#e8590c', '#7048e8'];
  const out = []; for (let i = 0; i < n; i++) out.push(base[i % base.length]); return out;
}
function drawChart(key, canvasId, cfg) {
  destroyChart(key);
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  CHARTS[key] = new Chart(ctx, cfg);
}
function destroyChart(key) { if (CHARTS[key]) { CHARTS[key].destroy(); delete CHARTS[key]; } }
function emptyCanvas(id, msg) {
  const d = document.createElement('div'); d.id = id; d.className = 'empty'; d.textContent = msg; return d;
}

// ---------- CARTERA ----------
function renderCartera() {
  const f = getFilters();
  const filtered = applyFilters(HOLDINGS, f);
  const t = totalsOf(filtered);
  const rows = f.view === 'consolidated' ? consolidate(filtered)
    : filtered.slice().sort((a, b) => (b.purchase_date || '').localeCompare(a.purchase_date || ''));
  LAST_CARTERA = { rows, view: f.view };

  document.getElementById('totals-strip').innerHTML =
    `<span>Valor: <b>${money(t.value)}</b></span>
     <span>Resultado: <b class="${cls(t.pl)}">${money(t.pl)}</b></span>
     <span>Rendimiento: <b class="${cls(t.plPct)}">${pctStr(t.plPct)}</b></span>
     <span>${f.view === 'consolidated' ? 'Tickers' : 'Lotes'}: <b>${rows.length}</b></span>`;

  const size = f.pageSize, pages = Math.max(1, Math.ceil(rows.length / size));
  if (PAGE > pages) PAGE = pages;
  const start = (PAGE - 1) * size, pageRows = rows.slice(start, start + size);
  const el = document.getElementById('holdings-table');

  if (!rows.length) {
    el.innerHTML = '<div class="empty">' + (HOLDINGS.length ? 'Ningún resultado con esos filtros.' : 'No hay tenencias. Cargalas en la sección Tenencias.') + '</div>';
  } else if (f.view === 'consolidated') {
    el.innerHTML = `<table><thead><tr>
        <th>Ticker</th><th class="num">Compra prom.</th><th class="num">Actual</th>
        <th class="num">Hoy</th><th class="num">P/G</th><th class="num hide-sm">Valor</th>
      </tr></thead><tbody>${pageRows.map(r => `
        <tr>
          <td><b>${r.ticker}</b> <span class="muted-sm">${r.type} · ${r.quantity} CEDEARs · ${r.lots} lote${r.lots > 1 ? 's' : ''}</span></td>
          <td class="num">${money(r.buy_price)}</td><td class="num">${money(r.price)}</td>
          <td class="num ${cls(r.changePct)}">${pctStr(r.changePct)}</td>
          <td class="num ${cls(r.plPct)}"><b>${pctStr(r.plPct)}</b></td>
          <td class="num hide-sm">${money(r.positionValue)}</td>
        </tr>`).join('')}</tbody></table>`;
  } else {
    el.innerHTML = `<table><thead><tr>
        <th>Ticker</th><th class="num">Compra</th><th class="num">Actual</th>
        <th class="num hide-sm">Fecha</th><th class="num">Hoy</th><th class="num">P/G</th><th class="num hide-sm">Valor</th>
      </tr></thead><tbody>${pageRows.map(h => `
        <tr>
          <td><b>${h.ticker}</b> <span class="muted-sm">${h.type} · ${h.quantity} CEDEARs · ratio ${h.ratio}</span>${tagsHtml(h.observations)}</td>
          <td class="num">${money(h.buy_price)}</td><td class="num">${money(h.price)}</td>
          <td class="num hide-sm">${fmtDate(h.purchase_date)}</td>
          <td class="num ${cls(h.changePct)}">${pctStr(h.changePct)}</td>
          <td class="num ${cls(h.plPct)}"><b>${pctStr(h.plPct)}</b></td>
          <td class="num hide-sm">${h.positionValue !== null ? money(h.positionValue) : '—'}</td>
        </tr>`).join('')}</tbody></table>`;
  }
  const from = rows.length ? start + 1 : 0, to = Math.min(start + size, rows.length);
  document.getElementById('pager-info').textContent = `Mostrando ${from}–${to} de ${rows.length}`;
  document.getElementById('page-label').textContent = `Página ${PAGE} / ${pages}`;
  document.getElementById('prev-page').disabled = PAGE <= 1;
  document.getElementById('next-page').disabled = PAGE >= pages;
}

function exportCsv() {
  const { rows, view } = LAST_CARTERA;
  if (!rows.length) return toast('No hay datos para exportar');
  let headers, line;
  if (view === 'consolidated') {
    headers = ['Ticker', 'Tipo', 'CEDEARs', 'CompraProm', 'Actual', 'PG%', 'Valor', 'Costo', 'Lotes'];
    line = (r) => [r.ticker, r.type, r.quantity, r.buy_price, r.price, r.plPct, r.positionValue, r.positionCost, r.lots];
  } else {
    headers = ['Ticker', 'Tipo', 'Fecha', 'Compra', 'CEDEARs', 'Ratio', 'Actual', 'PG%', 'Valor', 'Costo'];
    line = (h) => [h.ticker, h.type, (h.purchase_date || '').slice(0, 10), h.buy_price, h.quantity, h.ratio, h.price, h.plPct, h.positionValue, h.positionCost];
  }
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [headers.join(','), ...rows.map(r => line(r).map(esc).join(','))].join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `cartera-${view}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click(); URL.revokeObjectURL(a.href);
}

// ---------- TICKERS (catálogo) ----------
function renderCatalog() {
  const live = {}; for (const w of WATCHLIVE) live[w.ticker] = w;
  const el = document.getElementById('watch-table');
  if (!CATALOG.length) { el.innerHTML = '<div class="empty">No hay tickers. Usá “Cargar sugeridos” o “+ Agregar ticker”.</div>'; return; }
  el.innerHTML = `<table><thead><tr>
      <th>Ticker</th><th>Tipo</th><th class="num">Ratio</th><th class="num hide-sm">Precio</th><th class="num hide-sm">Hoy</th><th class="num"></th>
    </tr></thead><tbody>${CATALOG.map(w => {
        const l = live[w.ticker];
        return `<tr>
          <td><b>${w.ticker}</b></td><td>${tType(w.ticker)}</td><td class="num">${w.ratio}</td>
          <td class="num hide-sm">${l ? money(l.price) : '—'}</td>
          <td class="num hide-sm ${l ? cls(l.changePct) : ''}">${l ? pctStr(l.changePct) : '—'}</td>
          <td class="num row-actions"><button title="Cambiar ratio (split)" onclick='openRatioChange(${JSON.stringify(w).replace(/'/g, "&#39;")})'>🔁</button><button title="Editar" onclick='openWatchForm(${JSON.stringify(w).replace(/'/g, "&#39;")})'>✏️</button><button title="Borrar" onclick="delWatch(${w.id})">🗑️</button></td>
        </tr>`;
      }).join('')}</tbody></table>`;
}

// ---------- TENENCIAS (gestión) ----------
function renderManage() {
  const el = document.getElementById('manage-table');
  if (!HOLDINGS.length) { el.innerHTML = '<div class="empty">No hay tenencias. Usá “Cargar mis compras”, “Importar lista” o “+ Agregar tenencia”.</div>'; return; }
  const rows = HOLDINGS.slice().sort((a, b) => (b.purchase_date || '').localeCompare(a.purchase_date || ''));
  el.innerHTML = `<div class="muted-sm" style="margin-bottom:8px">${HOLDINGS.length} tenencias cargadas</div>
    <table><thead><tr>
      <th>Ticker</th><th class="num">Fecha</th><th class="num">Compra</th><th class="num">CEDEARs</th><th class="num hide-sm">Ratio</th><th class="num"></th>
    </tr></thead><tbody>${rows.map(h => `
      <tr>
        <td><b>${h.ticker}</b></td>
        <td class="num">${fmtDate(h.purchase_date)}</td>
        <td class="num">${money(h.buy_price)}</td>
        <td class="num">${h.quantity}</td>
        <td class="num hide-sm">${h.ratio}</td>
        <td class="num row-actions"><button onclick='openHoldingForm(${JSON.stringify(h).replace(/'/g, "&#39;")})'>✏️</button><button onclick="delHolding(${h.id})">🗑️</button></td>
      </tr>`).join('')}</tbody></table>`;
}

// ---------- SUGERENCIAS ----------
function renderSugerencias() {
  const badge = document.getElementById('ai-badge');
  if (badge) badge.textContent = (CONFIG.aiEnabled ? '🤖 IA activa' : 'IA no configurada') + (CONFIG.signalsEnabled ? ' · 📈 datos FMP' : ' · sin datos FMP');
  const cur = document.getElementById('sg-cur');
  if (cur) cur.textContent = '(' + (CONFIG.currency || 'USD') + ')';
  const cont = document.getElementById('sg-tickers');
  const existing = cont.querySelectorAll('.sg-tk').length;
  if (!CATALOG.length) cont.innerHTML = '<span class="muted-sm">Cargá tickers primero (sección Tickers).</span>';
  else if (existing !== CATALOG.length) cont.innerHTML = CATALOG.map(c => `<label class="sg-chk"><input type="checkbox" class="sg-tk" value="${c.ticker}" checked> ${c.ticker}</label>`).join('');
  // Repinta el último resultado (p. ej. al togglear el ojito de montos)
  if (LAST_SUGGEST) renderSuggestResult(LAST_SUGGEST);
}

async function computeSuggest() {
  const amount = parseFloat(document.getElementById('sg-amount').value);
  if (!(amount > 0)) return toast('Ingresá un monto válido');
  const include = [...document.querySelectorAll('.sg-tk:checked')].map(x => x.value);
  if (!include.length) return toast('Elegí al menos un ticker');
  const body = {
    amount,
    risk: document.getElementById('sg-risk').value,
    strategy: document.getElementById('sg-strategy').value,
    maxPerTicker: parseFloat(document.getElementById('sg-maxticker').value) || null,
    maxPerType: parseFloat(document.getElementById('sg-maxtype').value) || null,
    maxTickers: parseInt(document.getElementById('sg-maxn').value, 10) || null,
    include,
    note: document.getElementById('sg-note').value,
  };
  const btn = document.getElementById('sg-go'); btn.disabled = true; btn.textContent = 'Calculando…';
  try {
    const data = await api('/suggest', { method: 'POST', body: JSON.stringify(body) });
    renderSuggestResult(data);
  } catch (e) { toast(e.message); }
  btn.disabled = false; btn.textContent = 'Calcular';
}

function renderSuggestResult(data) {
  LAST_SUGGEST = data;
  const p = data.plan;
  const rows = p.rows.filter(r => r.cedears > 0);
  const expl = data.aiRationale || data.rationale;
  const explTitle = data.aiRationale ? 'Comentario del modelo (IA)' : 'Resumen';
  const noticeHtml = data.notice ? `<div class="notice">⚠️ ${data.notice}</div>` : '';
  document.getElementById('sg-result').innerHTML = `
    ${noticeHtml}
    <div class="totals-strip">
      <span>A invertir: <b>${money(p.amount)}</b></span>
      <span>Distribuido: <b>${money(p.invested)}</b></span>
      <span>Sobrante: <b>${money(p.leftover)}</b></span>
      <span>Cartera resultante: <b>${money(p.resultingTotal)}</b></span>
    </div>
    ${rows.length ? `<table><thead><tr>
      <th>Ticker</th><th class="num">Comprar</th><th class="num">% del aporte</th><th class="num hide-sm">Precio CEDEAR</th><th class="num hide-sm">Monto aprox.</th><th class="num">Peso (actual→obj.→final)</th>
    </tr></thead><tbody>${rows.map(r => `
      <tr>
        <td><b>${r.ticker}</b> <span class="muted-sm">${r.type}</span></td>
        <td class="num"><b>${r.cedears}</b></td>
        <td class="num"><b>${r.pctOfNew}%</b></td>
        <td class="num hide-sm">${money(r.cedearPrice)}</td>
        <td class="num hide-sm">${money(r.buyMoney)}</td>
        <td class="num"><span class="muted-sm">${r.currentWeight}% → ${r.targetWeight}% →</span> <b>${r.resultingWeight}%</b></td>
      </tr>`).join('')}</tbody></table>` : '<div class="empty">No hay compras sugeridas con esos parámetros.</div>'}
    <div class="rationale">💡 <b>${explTitle}:</b> ${expl}</div>`;
}

// ---------- REPORTES ----------
function renderReportsList() {
  const el = document.getElementById('reports-list');
  if (!REPORTS.length) { el.innerHTML = '<div class="empty">Todavía no se generó ningún reporte.</div>'; return; }
  el.innerHTML = `<table><thead><tr><th>Fecha</th><th class="num">Valor</th><th class="num">Rendimiento</th><th class="num">Mail</th></tr></thead><tbody>${REPORTS.map(r => `
    <tr>
      <td>${new Date(r.created_at).toLocaleString('es-AR')}</td>
      <td class="num">${money(r.summary?.totalValue)}</td>
      <td class="num ${cls(r.summary?.totalPlPct)}">${pctStr(r.summary?.totalPlPct)}</td>
      <td class="num">${r.emailed ? '✉️ enviado' : '—'}</td>
    </tr>`).join('')}</tbody></table>`;
}

// ---------- Modal ----------
const modal = document.getElementById('modal');
function closeModal() { modal.classList.add('hidden'); }
function field(label, id, value = '', type = 'text', ph = '') {
  return `<label>${label}</label><input id="f-${id}" type="${type}" value="${value ?? ''}" placeholder="${ph}">`;
}
function openHoldingForm(h = null) {
  if (!CATALOG.length) { toast('Primero agregá tickers en la sección Tickers'); showSection('tickers'); return; }
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
  const sel = document.getElementById('f-ticker-sel'), rEl = document.getElementById('f-ratio');
  const sync = () => { rEl.value = sel.selectedOptions[0]?.dataset.ratio || ''; };
  if (!h) sync();
  sel.addEventListener('change', sync);
  document.getElementById('modal-save').onclick = async () => {
    const body = {
      ticker: sel.value, buy_price: parseFloat(document.getElementById('f-buy').value),
      quantity: parseFloat(document.getElementById('f-qty').value) || 0,
      ratio: parseFloat(rEl.value) || null, purchase_date: document.getElementById('f-pdate').value || null,
      notes: document.getElementById('f-notes').value,
    };
    if (!body.ticker || isNaN(body.buy_price)) return toast('Ticker y precio son obligatorios');
    try {
      if (h) await api('/holdings/' + h.id, { method: 'PUT', body: JSON.stringify(body) });
      else await api('/holdings', { method: 'POST', body: JSON.stringify(body) });
      closeModal(); toast('Guardado'); await loadAll();
    } catch (e) { toast(e.message); }
  };
  modal.classList.remove('hidden');
}
// Cambio de ratio (split): actualiza catálogo + ajusta tenencias, con previo
function openRatioChange(w) {
  const lots = HOLDINGS.filter(h => h.ticker === w.ticker);
  const totalNom = lots.reduce((a, h) => a + (Number(h.quantity) || 0), 0);
  document.getElementById('modal-title').textContent = `Cambiar ratio de ${w.ticker}`;
  document.getElementById('modal-body').innerHTML = `
    <p style="font-size:13px;color:#7a8190;margin:0 0 10px">Ratio actual: <b>${w.ratio}</b>. Si el CEDEAR cambió de ratio (split), tus nominales se ajustan por el factor; tu valor y P&amp;L no cambian.</p>
    <label>Nuevo ratio</label>
    <input id="f-newratio" type="number" placeholder="60" min="0" step="any">
    <div id="ratio-preview" style="font-size:13px;color:#1c1c1c;margin-top:10px"></div>`;
  const inp = document.getElementById('f-newratio');
  const prev = document.getElementById('ratio-preview');
  const upd = () => {
    const nr = parseFloat(inp.value);
    if (!(nr > 0)) { prev.textContent = ''; return; }
    const factor = nr / Number(w.ratio);
    prev.innerHTML = `Factor: <b>×${round2(factor)}</b> · Lotes afectados: <b>${lots.length}</b><br>Nominales totales: <b>${totalNom}</b> → <b>${Math.round(totalNom * factor)}</b>`;
  };
  inp.addEventListener('input', upd);
  document.getElementById('modal-save').onclick = async () => {
    const nr = parseFloat(inp.value);
    if (!(nr > 0)) return toast('Ingresá un ratio válido');
    if (!confirm(`Cambiar ${w.ticker} de ratio ${w.ratio} a ${nr} y ajustar ${lots.length} lote(s)?`)) return;
    try {
      const r = await api('/ratio-change', { method: 'POST', body: JSON.stringify({ ticker: w.ticker, newRatio: nr }) });
      closeModal(); toast(`${r.ticker}: ratio ${r.oldRatio}→${r.newRatio}, ${r.holdingsUpdated} tenencias ajustadas`); await loadAll();
    } catch (e) { toast(e.message); }
  };
  modal.classList.remove('hidden');
}

function openWatchForm(w = null) {
  document.getElementById('modal-title').textContent = w ? `Editar ${w.ticker}` : 'Agregar ticker';
  document.getElementById('modal-body').innerHTML =
    field('Ticker (ej. NVDA)', 'wticker', w?.ticker || '', 'text', 'NVDA') +
    field('Ratio (CEDEARs por acción)', 'wratio', w?.ratio ?? '', 'number', '1') +
    field('Notas (opcional)', 'wnotes', w?.notes || '');
  const tEl = document.getElementById('f-wticker'), rEl = document.getElementById('f-wratio');
  if (w) tEl.setAttribute('readonly', 'true');
  const fill = () => { const s = RATIOS[tEl.value.toUpperCase().trim()]; if (s && !rEl.value) rEl.value = s; };
  tEl.addEventListener('input', fill); tEl.addEventListener('blur', fill);
  document.getElementById('modal-save').onclick = async () => {
    const body = { ticker: tEl.value.trim(), ratio: parseFloat(rEl.value) || null, notes: document.getElementById('f-wnotes').value };
    if (!body.ticker) return toast('El ticker es obligatorio');
    try {
      if (w) await api('/watchlist/' + w.id, { method: 'PUT', body: JSON.stringify({ ratio: body.ratio, notes: body.notes }) });
      else await api('/watchlist', { method: 'POST', body: JSON.stringify(body) });
      closeModal(); toast('Guardado'); await loadAll();
    } catch (e) { toast(e.message); }
  };
  modal.classList.remove('hidden');
}

// ---------- Importación / admin ----------
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
    <p style="font-size:12px;color:#7a8190;margin:0 0 8px">Pegá filas: <b>fecha · ticker · precio acción · nominales</b> (ej. <code>13/8/24 MSFT $ 410,75 10</code>).</p>
    <textarea id="f-import" rows="9" placeholder="13/8/24  MSFT  $ 410,75  10"></textarea>
    <label style="display:flex;align-items:center;gap:8px;margin-top:10px;font-size:13px;color:#1c1c1c"><input type="checkbox" id="f-reset" style="width:auto"> Reemplazar lo que ya tengo</label>
    <div id="import-preview" style="font-size:12px;color:#7a8190;margin-top:8px"></div>`;
  const ta = document.getElementById('f-import'), prev = document.getElementById('import-preview');
  ta.addEventListener('input', () => {
    const { items, errors } = parseHoldingsText(ta.value);
    prev.textContent = ta.value.trim() ? `Detectadas ${items.length} filas` + (errors.length ? ` · ${errors.length} no reconocidas` : '') : '';
  });
  document.getElementById('modal-save').onclick = async () => {
    const { items, errors } = parseHoldingsText(ta.value);
    if (!items.length) return toast('No se detectaron filas válidas');
    if (errors.length && !confirm(`${errors.length} líneas no se reconocieron. ¿Importar las ${items.length} válidas?`)) return;
    const reset = document.getElementById('f-reset').checked;
    try {
      const r = await api('/holdings/bulk', { method: 'POST', body: JSON.stringify({ items, reset }) });
      closeModal(); toast(`Importadas ${r.inserted} tenencias`); await loadAll();
    } catch (e) { toast(e.message); }
  };
  modal.classList.remove('hidden');
}
async function loadSuggestedTickers() {
  if (!confirm('¿Cargar los tickers sugeridos con sus ratios?')) return;
  try { const r = await api('/admin/seed-tickers', { method: 'POST', body: '{}' }); toast(`Cargados ${r.tickers} tickers`); await loadAll(); }
  catch (e) { toast(e.message); }
}
async function loadMyHoldings() {
  if (!confirm('¿Cargar tus compras desde el archivo incluido?')) return;
  try { const r = await api('/admin/seed-holdings', { method: 'POST', body: JSON.stringify({ reset: false }) }); toast(`Cargadas ${r.inserted} compras · ${r.tickers} tickers`); await loadAll(); }
  catch (e) { toast(e.message); }
}
async function resetDb() {
  if (!confirm('Esto borra TODO: tenencias, tickers y reportes. ¿Empezar de 0?')) return;
  if (!confirm('Confirmá de nuevo: se borra todo y no se puede deshacer.')) return;
  try { await api('/admin/reset', { method: 'POST', body: '{}' }); toast('Base limpia'); await loadAll(); }
  catch (e) { toast(e.message); }
}
async function delHolding(id) {
  if (!confirm('¿Eliminar esta tenencia?')) return;
  await api('/holdings/' + id, { method: 'DELETE' }); toast('Eliminada'); await loadAll();
}
async function delWatch(id) {
  if (!confirm('¿Quitar este ticker del catálogo?')) return;
  await api('/watchlist/' + id, { method: 'DELETE' }); toast('Quitado'); await loadAll();
}

// ---------- Config / run ----------
async function loadConfig() {
  try {
    CONFIG = await api('/config');
    CONFIG.currency = CONFIG.currency || 'USD';
    const pill = document.getElementById('status-pill');
    pill.textContent = [CONFIG.marketKey ? 'datos ✓' : 'datos demo', CONFIG.emailConfigured ? 'mail ✓' : 'sin mail', `rep ${String(CONFIG.reportHour).padStart(2, '0')}:${String(CONFIG.reportMinute).padStart(2, '0')}`].join(' · ');
    pill.className = 'pill ' + (CONFIG.marketKey && CONFIG.emailConfigured ? 'ok' : 'warn');
    if (CONFIG.sso && CONFIG.user) {
      const up = document.getElementById('user-pill'); up.textContent = CONFIG.user; up.className = 'pill ok';
      document.getElementById('logout-link').style.display = '';
    }
  } catch (e) { /* noop */ }
}

// ---------- Eventos ----------
function bindEvents() {
  document.querySelectorAll('.nav-item').forEach(n => n.onclick = () => showSection(n.dataset.sec));
  document.getElementById('hamburger').onclick = () => document.querySelector('.sidebar').classList.toggle('open');
  document.getElementById('btn-eye').onclick = toggleMoney;
  document.getElementById('sg-go').onclick = computeSuggest;
  document.getElementById('chk-daily-email').addEventListener('change', async function () {
    try {
      SETTINGS = await api('/settings', { method: 'POST', body: JSON.stringify({ dailyEmail: this.checked }) });
      toast(SETTINGS.dailyEmail ? 'Mail diario activado' : 'Mail diario desactivado (el snapshot se sigue guardando)');
    } catch (e) { toast(e.message); this.checked = !this.checked; }
  });
  ['f-view', 'f-type', 'f-ticker', 'f-year', 'f-from', 'f-to', 'f-pl', 'f-pagesize'].forEach(id => {
    document.getElementById(id).addEventListener('change', () => { PAGE = 1; renderCartera(); });
  });
  document.getElementById('prev-page').onclick = () => { if (PAGE > 1) { PAGE--; renderCartera(); } };
  document.getElementById('next-page').onclick = () => { PAGE++; renderCartera(); };
  document.querySelectorAll('.seg-btn').forEach(b => b.onclick = () => {
    b.parentElement.querySelectorAll('.seg-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    if (b.dataset.dist) { DIST_MODE = b.dataset.dist; renderDist(); }
    if (b.dataset.evo) { EVO_MODE = b.dataset.evo; renderEvolution(); }
  });
  document.getElementById('btn-run').onclick = async function () {
    this.disabled = true; this.textContent = 'Generando…';
    try {
      const r = await api('/report/run', { method: 'POST', body: JSON.stringify({ send: true }) });
      toast(r.emailResult.sent ? 'Reporte generado y enviado ✉️' : 'Reporte generado (mail: ' + r.emailResult.reason + ')');
      await loadReports(); if (CURRENT_SEC === 'reportes' || CURRENT_SEC === 'resumen') renderSection(CURRENT_SEC);
    } catch (e) { toast(e.message); }
    this.disabled = false; this.textContent = 'Generar reporte ahora';
  };
}

// ---------- Init ----------
(async function init() {
  bindEvents();
  await loadConfig();
  setEye();
  startIdle();
  try { RATIOS = await api('/ratios'); } catch (e) { RATIOS = {}; }
  CURRENT_SEC = localStorage.getItem(SEC_KEY) || 'resumen';
  await loadAll();
  showSection(CURRENT_SEC);
})();
