// ---------- Estado / helpers ----------
const TOKEN_KEY = 'cartera_token';
const SEC_KEY = 'cartera_sec';
let CONFIG = {};
let RATIOS = {};
const ETFS = new Set(['SPY', 'QQQ', 'EEM', 'EWZ', 'FXI', 'VEA', 'XLV', 'SPXL', 'TQQQ', 'DIA', 'IWM', 'EFA', 'ARKK', 'XLF', 'XLE', 'XLK', 'GLD', 'SLV', 'UPRO', 'SOXL', 'TECL', 'XLP', 'XLU']);
const LEVERAGED = new Set(['TQQQ', 'SPXL', 'UPRO', 'SOXL', 'TECL', 'SQQQ', 'TNA', 'FAS', 'LABU', 'SPXS']);
const tType = (t) => ETFS.has((t || '').toUpperCase()) ? 'ETF' : 'Acción';

let HOLDINGS = [];
let CATALOG = [];
let WATCHLIVE = [];
let REPORTS = [];
let SALES = [];
let SETTINGS = { dailyEmail: true };
let PAGE = 1;
let CURRENT_SEC = 'resumen';
let DIST_MODE = 'ticker';
let EVO_MODE = 'mercado';
let EVO_GROUP = 'dia';
let WL_MODE = 'pct';
let LAST_CARTERA = { rows: [], view: 'lots' };
let LAST_SUGGEST = null;
let RF_VIEW = 'fija';
let RF_DATA = null;   // { rows, totals, monthly, upcoming, hasData }
let RF_CONS = null;   // consolidado
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
// Formatea una fecha-solo (YYYY-MM-DD o ISO) SIN corrimiento de zona horaria.
const fmtDate = (d) => {
  if (!d) return '—';
  const s = String(d);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  const dt = new Date(d);
  return isNaN(dt) ? '—' : dt.toLocaleDateString('es-AR');
};

// Nombres de tickers (sobre todo ETFs) para el tooltip
const NAMES = {
  AVGO: 'Broadcom', BRKB: 'Berkshire Hathaway (clase B)', GOOGL: 'Alphabet (Google)',
  JPM: 'JPMorgan Chase', MELI: 'MercadoLibre', META: 'Meta Platforms (Facebook/Instagram)',
  MSFT: 'Microsoft', NU: 'Nu Holdings (Nubank)', PFE: 'Pfizer',
  EEM: 'iShares MSCI Emerging Markets — mercados emergentes', EWZ: 'iShares MSCI Brazil — Brasil',
  FXI: 'iShares China Large-Cap — China', VEA: 'Vanguard Developed Markets — desarrollados ex-EEUU',
  XLV: 'Health Care Select Sector SPDR — sector salud (EEUU)',
  QQQ: 'Invesco QQQ — índice Nasdaq 100', SPY: 'SPDR S&P 500 — índice S&P 500',
  SPXL: 'Direxion S&P 500 Bull 3x — apalancado x3', TQQQ: 'ProShares UltraPro QQQ — Nasdaq 100 x3 (apalancado)',
};
function tName(t) {
  const up = (t || '').toUpperCase().trim();
  return NAMES[up] || (CATALOG.find(c => c.ticker === up)?.notes) || '';
}
// <b> del ticker con tooltip de nombre
function tb(t) { const n = tName(t); return `<b${n ? ` title="${n}"` : ''}>${t}</b>`; }

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
const SEC_TITLES = { resumen: 'Resumen', cartera: 'Cartera', rentafija: 'Renta fija', sugerencias: 'Sugerencias', descubrir: 'Descubrir', tickers: 'Tickers', tenencias: 'Tenencias', ventas: 'Ventas', reportes: 'Reportes diarios' };
function showSection(sec) {
  if (!document.getElementById('sec-' + sec)) sec = 'resumen';
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
  if (!document.getElementById('sec-' + sec)) sec = 'resumen';
  if (sec === 'resumen') renderResumen();
  else if (sec === 'cartera') renderCartera();
  else if (sec === 'rentafija') renderRentaFija();
  else if (sec === 'sugerencias') renderSugerencias();
  else if (sec === 'descubrir') renderDescubrir();
  else if (sec === 'tickers') renderCatalog();
  else if (sec === 'tenencias') renderManage();
  else if (sec === 'ventas') renderVentas();
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
async function loadSales() {
  SALES = await api('/sales').catch(() => []);
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
  await loadSales();
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
    if (f.type) {
      if (f.type === 'ETF apalancado') { if (!(h.type === 'ETF' && LEVERAGED.has(h.ticker))) return false; }
      else if (h.type !== f.type) return false;
    }
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
  const usd = WL_MODE === 'usd';
  const key = usd ? 'plAbs' : 'plPct';
  const rows = consolidate(HOLDINGS).filter(r => r[key] != null);
  const sorted = [...rows].sort((a, b) => b[key] - a[key]);
  const top = sorted.slice(0, 5), bottom = sorted.slice(-5).filter(x => !top.includes(x));
  const sel = [...top, ...bottom];
  drawChart('wl', 'chart-wl', {
    type: 'bar',
    data: {
      labels: sel.map(r => r.ticker),
      datasets: [{ data: sel.map(r => r[key]), backgroundColor: sel.map(r => r[key] >= 0 ? '#0a7d33' : '#c0271a') }],
    },
    options: {
      indexAxis: 'y', maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => usd ? money(ctx.parsed.x) : ctx.parsed.x + '%' } },
      },
      scales: { x: { ticks: { display: usd ? !HIDE_MONEY : true, callback: v => usd ? v : v + '%' } } },
    },
  });
}

function mondayOf(d) {
  const dt = new Date(d); const off = (dt.getDay() + 6) % 7; // 0=lunes
  dt.setDate(dt.getDate() - off); dt.setHours(0, 0, 0, 0); return dt;
}
function evoBucketKey(d) {
  const dt = new Date(d), y = dt.getFullYear(), m = String(dt.getMonth() + 1).padStart(2, '0'), day = String(dt.getDate()).padStart(2, '0');
  if (EVO_GROUP === 'anio') return '' + y;
  if (EVO_GROUP === 'mes') return y + '-' + m;
  if (EVO_GROUP === 'semana') return mondayOf(d).toISOString().slice(0, 10);
  return y + '-' + m + '-' + day;
}
function evoLabel(d) {
  const dt = new Date(d);
  if (EVO_GROUP === 'anio') return '' + dt.getFullYear();
  if (EVO_GROUP === 'mes') return dt.toLocaleDateString('es-AR', { month: 'short', year: '2-digit' });
  if (EVO_GROUP === 'semana') return 'sem ' + mondayOf(d).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' });
  return dt.toLocaleDateString('es-AR');
}
function renderEvolution() {
  if (!REPORTS.length) { destroyChart('evo'); return; }
  // Agrupar por día/mes/año: último snapshot de cada período (orden cronológico).
  const chrono = [...REPORTS].reverse();
  const byKey = new Map();
  for (const x of chrono) byKey.set(evoBucketKey(x.created_at), x);
  const r = [...byKey.values()];
  const labels = r.map(x => evoLabel(x.created_at));
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
  const wpct = (v) => (v != null && t.value > 0) ? round2((v / t.value) * 100) + '%' : '—';
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
        <th class="num">Hoy</th><th class="num">P/G</th><th class="num">Peso</th><th class="num hide-sm">Valor</th>
      </tr></thead><tbody>${pageRows.map(r => `
        <tr>
          <td>${tb(r.ticker)} <span class="muted-sm">${r.type} · ${r.quantity} CEDEARs · ${r.lots} lote${r.lots > 1 ? 's' : ''}</span></td>
          <td class="num">${money(r.buy_price)}</td><td class="num">${money(r.price)}</td>
          <td class="num ${cls(r.changePct)}">${pctStr(r.changePct)}</td>
          <td class="num ${cls(r.plPct)}"><b>${pctStr(r.plPct)}</b></td>
          <td class="num"><b>${wpct(r.positionValue)}</b></td>
          <td class="num hide-sm">${money(r.positionValue)}</td>
        </tr>`).join('')}</tbody></table>`;
  } else {
    el.innerHTML = `<table><thead><tr>
        <th>Ticker</th><th class="num">Compra</th><th class="num">Actual</th>
        <th class="num hide-sm">Fecha</th><th class="num">Hoy</th><th class="num">P/G</th><th class="num">Peso</th><th class="num hide-sm">Valor</th>
      </tr></thead><tbody>${pageRows.map(h => `
        <tr>
          <td>${tb(h.ticker)} <span class="muted-sm">${h.type} · ${h.quantity} CEDEARs · ratio ${h.ratio}</span>${tagsHtml(h.observations)}</td>
          <td class="num">${money(h.buy_price)}</td><td class="num">${money(h.price)}</td>
          <td class="num hide-sm">${fmtDate(h.purchase_date)}</td>
          <td class="num ${cls(h.changePct)}">${pctStr(h.changePct)}</td>
          <td class="num ${cls(h.plPct)}"><b>${pctStr(h.plPct)}</b></td>
          <td class="num"><b>${wpct(h.positionValue)}</b></td>
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
          <td>${tb(w.ticker)}</td><td>${tType(w.ticker)}</td><td class="num">${w.ratio}</td>
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
        <td>${tb(h.ticker)}</td>
        <td class="num">${fmtDate(h.purchase_date)}</td>
        <td class="num">${money(h.buy_price)}</td>
        <td class="num">${h.quantity}</td>
        <td class="num hide-sm">${h.ratio}</td>
        <td class="num row-actions"><button onclick='openHoldingForm(${JSON.stringify(h).replace(/'/g, "&#39;")})'>✏️</button><button onclick="delHolding(${h.id})">🗑️</button></td>
      </tr>`).join('')}</tbody></table>`;
}

// ---------- VENTAS ----------
function renderVentas() {
  const sel = document.getElementById('sv-lot');
  const lots = HOLDINGS.filter(h => Number(h.quantity) > 0)
    .sort((a, b) => a.ticker.localeCompare(b.ticker) || String(a.purchase_date || '').localeCompare(String(b.purchase_date || '')));
  sel.innerHTML = lots.length
    ? lots.map(h => `<option value="${h.id}">${h.ticker} · ${fmtDate(h.purchase_date)} · ${h.quantity} CEDEARs · compra ${money(h.buy_price)}</option>`).join('')
    : '<option value="">No hay tenencias para vender</option>';
  const dEl = document.getElementById('sv-date');
  if (!dEl.value) dEl.value = new Date().toISOString().slice(0, 10);

  let realized = 0;
  for (const s of SALES) { const r = Number(s.ratio) > 0 ? Number(s.ratio) : 1; realized += (Number(s.quantity) / r) * (Number(s.sell_price) - Number(s.buy_price)); }
  realized = round2(realized);
  const rl = document.getElementById('ventas-realized');
  rl.textContent = SALES.length ? `Ganancia realizada: ${HIDE_MONEY ? '••••' : money(realized)}` : '';

  const el = document.getElementById('sales-list');
  if (!SALES.length) { el.innerHTML = '<div class="empty">Todavía no registraste ventas.</div>'; return; }
  el.innerHTML = `<table><thead><tr>
      <th>Ticker</th><th class="num">Fecha</th><th class="num">Nominales</th><th class="num hide-sm">Compra</th><th class="num">Venta</th><th class="num">Ganancia</th><th class="num"></th>
    </tr></thead><tbody>${SALES.map(s => {
      const r = Number(s.ratio) > 0 ? Number(s.ratio) : 1;
      const g = round2((Number(s.quantity) / r) * (Number(s.sell_price) - Number(s.buy_price)));
      return `<tr>
        <td>${tb(s.ticker)}</td>
        <td class="num">${fmtDate(s.sell_date)}</td>
        <td class="num">${s.quantity}</td>
        <td class="num hide-sm">${money(s.buy_price)}</td>
        <td class="num">${money(s.sell_price)}</td>
        <td class="num ${cls(g)}">${money(g)}</td>
        <td class="num row-actions"><button title="Borrar (devuelve la cantidad)" onclick="delSale(${s.id})">🗑️</button></td>
      </tr>`;
    }).join('')}</tbody></table>`;
}

async function registerSale() {
  const holding_id = document.getElementById('sv-lot').value;
  if (!holding_id) return toast('Elegí una tenencia');
  const body = {
    holding_id: Number(holding_id),
    quantity: parseFloat(document.getElementById('sv-qty').value),
    sell_price: parseFloat(document.getElementById('sv-price').value),
    sell_date: document.getElementById('sv-date').value || null,
  };
  if (!(body.quantity > 0) || isNaN(body.sell_price)) return toast('Completá nominales y precio de venta');
  const b = document.getElementById('sv-go'); b.disabled = true; b.textContent = 'Guardando…';
  try {
    await api('/sales', { method: 'POST', body: JSON.stringify(body) });
    toast('Venta registrada');
    document.getElementById('sv-qty').value = ''; document.getElementById('sv-price').value = '';
    await loadAll();
  } catch (e) { toast(e.message); }
  b.disabled = false; b.textContent = 'Registrar venta';
}

async function delSale(id) {
  if (!confirm('¿Borrar esta venta? Se devuelve la cantidad a la tenencia.')) return;
  try { await api('/sales/' + id, { method: 'DELETE' }); toast('Venta borrada'); await loadAll(); }
  catch (e) { toast(e.message); }
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
  else if (existing !== CATALOG.length) {
    const sel = SETTINGS.suggestTickers;
    cont.innerHTML = CATALOG.map(c => {
      const checked = !Array.isArray(sel) || sel.includes(c.ticker);
      return `<label class="sg-chk"><input type="checkbox" class="sg-tk" value="${c.ticker}" ${checked ? 'checked' : ''}> ${c.ticker}</label>`;
    }).join('');
  }
  // Repinta el último resultado (p. ej. al togglear el ojito de montos)
  if (LAST_SUGGEST) renderSuggestResult(LAST_SUGGEST);
}

let _sgSaveTimer = null;
function saveSuggestTickers() {
  const sel = [...document.querySelectorAll('.sg-tk:checked')].map(x => x.value);
  clearTimeout(_sgSaveTimer);
  _sgSaveTimer = setTimeout(async () => {
    try { SETTINGS = await api('/settings', { method: 'POST', body: JSON.stringify({ suggestTickers: sel }) }); }
    catch (e) { /* noop */ }
  }, 700);
}

// Precio de mercado (no se oculta con el ojito; es dato público)
const px = (n) => n == null ? '—' : (CONFIG.currency || 'USD') + ' ' + Number(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

let TECH_ALL_OPEN = false;
async function toggleAllTech() {
  const cont = document.getElementById('tech-all');
  const b = document.getElementById('sg-all');
  if (TECH_ALL_OPEN) { cont.innerHTML = ''; TECH_ALL_OPEN = false; b.textContent = 'Ver análisis de todos'; return; }
  b.disabled = true; b.textContent = 'Cargando…';
  try {
    const d = await api('/technicals');
    let head = '';
    if (d.techInfo && d.techInfo.enabled && d.techInfo.count === 0) head = `<div class="notice">Sin indicadores: FMP no devolvió datos${d.techInfo.error ? ` — ${d.techInfo.error}` : ''}.</div>`;
    else if (d.techInfo && !d.techInfo.enabled) head = `<div class="muted-sm" style="margin:6px 0">Indicadores desactivados (falta FMP_API_KEY).</div>`;
    const cards = (d.items || []).slice().sort((a, b2) => a.ticker.localeCompare(b2.ticker)).map(it => {
      const t = it.tech;
      return `<div class="tcard">
        <div class="tcard-h">${tb(it.ticker)} <span class="muted-sm">${tType(it.ticker)}</span></div>
        ${t ? `<div class="muted-sm" style="margin-bottom:4px">Precio: ${px(t.price)}</div>${techBadges(t)}` : '<div class="muted-sm">sin datos</div>'}
      </div>`;
    }).join('');
    cont.innerHTML = head + `<div class="tgrid">${cards}</div>` + TECH_LEGEND;
    TECH_ALL_OPEN = true; b.textContent = 'Ocultar análisis';
  } catch (e) { toast(e.message); }
  b.disabled = false;
}

async function seedDemoSeries() {
  if (!confirm('¿Cargar series de PRUEBA (sintéticas) para ver los indicadores sin FMP? Se reemplazan por datos reales cuando FMP tenga cupo.')) return;
  try {
    const r = await api('/admin/seed-series-demo', { method: 'POST', body: '{}' });
    toast(`Cargadas ${r.seeded} series de prueba. Ahora tocá Calcular.`);
  } catch (e) { toast(e.message); }
}

async function addSuggested(ticker, ratio, ratioKnown, name) {
  let r = ratio;
  if (!ratioKnown) {
    const v = prompt(`Ratio de ${ticker} (CEDEARs por acción). Verificalo en tu broker; si es acción local suele ser 1:`, '1');
    if (v === null) return;
    r = parseFloat(v) || 1;
  }
  try { await api('/watchlist', { method: 'POST', body: JSON.stringify({ ticker, ratio: r }) }); toast(`${ticker} agregado a preferidas ★`); await refreshCatalog(); }
  catch (e) { toast(e.message); }
}

function composeSuggestNote() {
  const region = document.getElementById('sg-region').value;
  const sector = document.getElementById('sg-sector').value;
  const free = (document.getElementById('sg-note').value || '').trim();
  const parts = [];
  if (region && region !== 'Todas') parts.push('Priorizá la región ' + region);
  if (sector && sector !== 'Todos') parts.push('priorizá el sector ' + sector);
  if (free) parts.push(free);
  return parts.join('. ');
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
    note: composeSuggestNote(),
    region: document.getElementById('sg-region').value,
    sector: document.getElementById('sg-sector').value,
    type: document.getElementById('sg-type').value,
    includeNew: document.getElementById('sg-incnew').checked,
  };
  const btn = document.getElementById('sg-go'); btn.disabled = true; btn.textContent = 'Calculando…';
  try {
    const data = await api('/suggest', { method: 'POST', body: JSON.stringify(body) });
    renderSuggestResult(data);
  } catch (e) { toast(e.message); }
  btn.disabled = false; btn.textContent = 'Calcular';
}

function techBadges(t) {
  if (!t) return '';
  const p = [];
  if (t.rsi != null) {
    const v = t.rsi, c = v > 70 ? 'neg' : v < 30 ? 'pos' : '';
    const tip = `RSI ${v} — ${v > 70 ? 'sobrecompra (caro/estirado)' : v < 30 ? 'sobreventa (barato/castigado)' : 'fuerza ' + (v >= 55 ? 'positiva' : v <= 45 ? 'floja' : 'neutra')}. Escala 0–100: >70 caro, <30 barato.`;
    p.push(`<span class="tag ${c}" title="${tip}">RSI ${v}</span>`);
  }
  if (t.trend) {
    const tip = `Tendencia ${t.trend} — la media de 50 días está ${t.trend === 'alcista' ? 'por encima' : t.trend === 'bajista' ? 'por debajo' : 'cerca'} de la de 200.`;
    p.push(`<span class="tag" title="${tip}">${t.trend === 'alcista' ? '↑' : t.trend === 'bajista' ? '↓' : '→'} ${t.trend}</span>`);
  }
  if (t.macdHist != null) {
    const up = t.macdHist > 0;
    p.push(`<span class="tag ${up ? 'pos' : 'neg'}" title="MACD ${up ? 'positivo' : 'negativo'} — momentum de corto plazo ${up ? 'al alza' : 'a la baja'}.">MACD ${up ? '+' : '−'}</span>`);
  }
  if (t.distHigh != null) p.push(`<span class="tag" title="A ${t.distHigh}% del máximo de 52 semanas (0% = en máximos; muy negativo = lejos del máximo).">a máx ${t.distHigh}%</span>`);
  if (t.vol != null) p.push(`<span class="tag" title="Volatilidad anualizada ${t.vol}% — ${t.vol < 15 ? 'tranquila' : t.vol > 30 ? 'movida (riesgo alto)' : 'media'}.">vol ${t.vol}%</span>`);
  return `<div class="tags">${p.join('')}</div>`;
}

const TECH_LEGEND = `<details class="tech-legend"><summary>¿Cómo leer los indicadores?</summary>
  <ul>
    <li><b>RSI</b> (0–100): fuerza del precio. &gt;70 sobrecompra (caro), &lt;30 sobreventa (barato), ~50 neutro.</li>
    <li><b>Tendencia</b>: media de 50 vs 200 días. <b>↑ alcista</b> = cotiza sobre su promedio largo; <b>↓ bajista</b> al revés.</li>
    <li><b>MACD</b>: <b>+</b> momentum al alza, <b>−</b> a la baja.</li>
    <li><b>a máx</b>: distancia al máximo de 52 semanas (0% = en máximos, muy negativo = lejos).</li>
    <li><b>vol</b>: volatilidad anual. &lt;15% tranquila, &gt;30% movida (más riesgo).</li>
  </ul>
  <p class="muted-sm" style="margin:6px 0 0">Son indicadores conocidos, no garantías: pueden dar señales falsas. Información para tu decisión, no recomendación.</p>
</details>`;

function renderSuggestResult(data) {
  LAST_SUGGEST = data;
  const p = data.plan;
  const rows = p.rows.filter(r => r.cedears > 0);
  const expl = data.aiRationale || data.rationale;
  const explTitle = data.aiRationale ? 'Comentario del modelo (IA)' : 'Resumen';
  const noticeHtml = data.notice ? `<div class="notice">⚠️ ${data.notice}</div>` : '';
  const ti = data.techInfo;
  let techNote = '';
  if (ti && ti.enabled && ti.count === 0) techNote = `<div class="notice">Sin indicadores técnicos: FMP no devolvió datos${ti.error ? ` — ${ti.error}` : ''}.</div>`;
  else if (ti && !ti.enabled) techNote = `<div class="muted-sm" style="margin-bottom:8px">Indicadores técnicos desactivados (falta FMP_API_KEY en el servidor).</div>`;
  document.getElementById('sg-result').innerHTML = `
    ${noticeHtml}${techNote}
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
        <td>${r.preferida ? '★' : '🔎'} ${tb(r.ticker)} <span class="muted-sm">${r.type}${r.preferida ? '' : ' · nuevo'}</span>${r.preferida ? '' : ` <button class="btn" style="padding:2px 7px;font-size:12px" onclick='addSuggested(${JSON.stringify(r.ticker)},${r.ratio},${r.ratioKnown},${JSON.stringify(r.name || '')})'>+ Agregar</button>`}${techBadges(r.tech)}</td>
        <td class="num"><b>${r.cedears}</b></td>
        <td class="num"><b>${r.pctOfNew}%</b></td>
        <td class="num hide-sm">${money(r.cedearPrice)}</td>
        <td class="num hide-sm">${money(r.buyMoney)}</td>
        <td class="num"><span class="muted-sm">${r.currentWeight}% → ${r.targetWeight}% →</span> <b>${r.resultingWeight}%</b></td>
      </tr>`).join('')}</tbody></table>` : '<div class="empty">No hay compras sugeridas con esos parámetros.</div>'}
    ${rows.length && rows.some(r => r.tech) ? TECH_LEGEND : ''}
    <div class="rationale">💡 <b>${explTitle}:</b> ${expl}</div>`;
}

// ---------- REPORTES ----------
// ---------- DESCUBRIR ----------
let DISC_ITEMS = [];
let DISC_VIEW = 'lista';
let LAST_DISC_AI = null;
let LAST_DISC_TECH = null;
function discFilters() {
  return {
    region: document.getElementById('dc-region').value,
    sector: document.getElementById('dc-sector').value,
    type: document.getElementById('dc-type').value,
    note: document.getElementById('dc-note').value,
  };
}
async function renderDescubrir() { await loadDiscover(false); }
async function loadDiscover(useAI) {
  const badge = document.getElementById('disc-badge');
  if (badge) badge.textContent = CONFIG.aiEnabled ? '🤖 IA disponible' : 'IA no configurada';
  const f = discFilters();
  const el = document.getElementById('disc-result');
  el.innerHTML = '<div class="empty">Buscando…</div>';
  try {
    let data;
    if (useAI) data = await api('/discover', { method: 'POST', body: JSON.stringify(f) });
    else data = await api(`/universe?region=${encodeURIComponent(f.region)}&sector=${encodeURIComponent(f.sector)}&type=${encodeURIComponent(f.type)}`);
    DISC_ITEMS = data.items || [];
    LAST_DISC_TECH = data.techInfo || null;
    renderDiscoverResult(DISC_ITEMS, useAI ? data.aiRationale : null);
  } catch (e) { toast(e.message); el.innerHTML = ''; }
}
function renderDiscoverResult(items, aiRationale) {
  LAST_DISC_AI = aiRationale ?? null;
  const el = document.getElementById('disc-result');
  const aiHtml = LAST_DISC_AI ? `<div class="rationale">🤖 <b>Análisis IA:</b> ${LAST_DISC_AI}</div>` : '';
  if (!items.length) { el.innerHTML = aiHtml + '<div class="empty">No hay candidatos nuevos con esos filtros (quizás ya están en tu catálogo).</div>'; return; }
  // Aviso si no hay indicadores (FMP)
  let techNote = '';
  const anyTech = items.some(i => i.tech);
  const ti = LAST_DISC_TECH;
  if (!anyTech && ti) {
    if (!ti.enabled) techNote = '<div class="muted-sm" style="margin:4px 0 8px">Indicadores técnicos desactivados (falta FMP_API_KEY).</div>';
    else techNote = `<div class="notice">Sin indicadores técnicos por ahora${ti.error ? ` — ${ti.error}` : ' (FMP no devolvió datos para estos tickers)'}.</div>`;
  }
  const btn = (u) => `<button class="btn" onclick='addFromUniverse(${JSON.stringify(u).replace(/'/g, "&#39;")})'>+ Agregar</button>`;
  let body;
  if (DISC_VIEW === 'cards') {
    body = `<div class="tgrid">${items.map(u => `
      <div class="tcard">
        <div class="tcard-h"><b title="${u.name}">${u.ticker}</b></div>
        <div class="muted-sm" style="margin-bottom:6px">${u.name}</div>
        <div class="tags"><span class="tag">${u.region}</span><span class="tag">${u.sector}</span><span class="tag">${u.type}</span><span class="tag">ratio ${u.ratio != null ? u.ratio : '?'}</span></div>
        ${u.tech ? techBadges(u.tech) : ''}
        <div style="margin-top:8px">${btn(u)}</div>
      </div>`).join('')}</div>`;
  } else {
    body = `<table><thead><tr><th>Ticker</th><th>Región</th><th>Sector</th><th>Tipo</th><th class="num">Ratio</th><th class="num"></th></tr></thead><tbody>${items.map(u => `
      <tr>
        <td><b title="${u.name}">${u.ticker}</b> <span class="muted-sm">${u.name}</span>${u.tech ? techBadges(u.tech) : ''}</td>
        <td>${u.region}</td><td>${u.sector}</td><td>${u.type}</td>
        <td class="num">${u.ratio != null ? u.ratio : '<span class="muted-sm">verificar</span>'}</td>
        <td class="num">${btn(u)}</td>
      </tr>`).join('')}</tbody></table>`;
  }
  el.innerHTML = aiHtml + techNote + body;
}
async function addFromUniverse(u) {
  let ratio = u.ratio;
  if (ratio == null) {
    const v = prompt(`Ratio de ${u.ticker} (CEDEARs por acción). Verificalo en tu broker. Si es una acción local (ej. argentina) suele ser 1:`, '1');
    if (v === null) return; // canceló
    ratio = parseFloat(v) || 1;
  }
  try {
    await api('/watchlist', { method: 'POST', body: JSON.stringify({ ticker: u.ticker, ratio }) });
    toast(`${u.ticker} agregado al catálogo (ratio ${ratio})`);
    await refreshCatalog();
    DISC_ITEMS = DISC_ITEMS.filter(x => x.ticker !== u.ticker);
    renderDiscoverResult(DISC_ITEMS, LAST_DISC_AI);
  } catch (e) { toast(e.message); }
}

// ---------- REPORTES ----------
let REP_PAGE = 1, REP_SIZE = 20;
function repPrev() { if (REP_PAGE > 1) { REP_PAGE--; renderReportsList(); } }
function repNext() { REP_PAGE++; renderReportsList(); }
function repSetSize(v) { REP_SIZE = parseInt(v, 10) || 20; REP_PAGE = 1; renderReportsList(); }
function renderReportsList() {
  const el = document.getElementById('reports-list');
  if (!REPORTS.length) { el.innerHTML = '<div class="empty">Todavía no se generó ningún reporte.</div>'; return; }
  const total = REPORTS.length, pages = Math.max(1, Math.ceil(total / REP_SIZE));
  if (REP_PAGE > pages) REP_PAGE = pages;
  if (REP_PAGE < 1) REP_PAGE = 1;
  const start = (REP_PAGE - 1) * REP_SIZE, shown = REPORTS.slice(start, start + REP_SIZE);
  const from = start + 1, to = Math.min(start + REP_SIZE, total);
  const pager = `<div class="pager">
    <span class="muted-sm">Mostrando ${from}–${to} de ${total}</span>
    <div class="pager-ctrls">
      <label class="muted-sm">Por página
        <select onchange="repSetSize(this.value)">${[10, 20, 50, 100].map(n => `<option value="${n}"${n === REP_SIZE ? ' selected' : ''}>${n}</option>`).join('')}</select>
      </label>
      <button class="btn" onclick="repPrev()"${REP_PAGE <= 1 ? ' disabled' : ''}>‹</button>
      <span class="muted-sm">Página ${REP_PAGE} / ${pages}</span>
      <button class="btn" onclick="repNext()"${REP_PAGE >= pages ? ' disabled' : ''}>›</button>
    </div></div>`;
  el.innerHTML = `<table><thead><tr><th>Fecha</th><th class="num">Valor</th><th class="num">Rendimiento</th><th class="num">Mail</th><th class="num"></th></tr></thead><tbody>${shown.map(r => `
    <tr>
      <td>${new Date(r.created_at).toLocaleString('es-AR')}</td>
      <td class="num">${money(r.summary?.totalValue)}</td>
      <td class="num ${cls(r.summary?.totalPlPct)}">${pctStr(r.summary?.totalPlPct)}</td>
      <td class="num">${r.emailed ? '✉️ enviado' : '—'}</td>
      <td class="num row-actions"><button title="Borrar" onclick="delReport(${r.id})">🗑️</button></td>
    </tr>`).join('')}</tbody></table>${pager}`;
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
    <input id="f-ratio" type="number" value="${h?.ratio ?? ''}" readonly>
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
    <label style="display:flex;align-items:center;gap:8px;margin-top:10px;font-size:13px;color:var(--ink)"><input type="checkbox" id="f-reset" style="width:auto"> Reemplazar lo que ya tengo</label>
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
async function runBackfill() {
  const from = document.getElementById('bf-from').value;
  if (!from) return toast('Elegí una fecha "desde"');
  const granularity = document.getElementById('bf-gran').value;
  if (!confirm(`Reconstruir el histórico desde ${from} (${granularity})? Reemplaza los snapshots reconstruidos previos.`)) return;
  const b = document.getElementById('bf-go'); b.disabled = true; b.textContent = 'Reconstruyendo…';
  try {
    const r = await api('/admin/backfill', { method: 'POST', body: JSON.stringify({ from, granularity }) });
    let msg = `Reconstruidos ${r.inserted} puntos (${(r.tickersOk || []).length} tickers con datos)`;
    if (r.tickersMissing && r.tickersMissing.length) msg += ` · sin datos FMP: ${r.tickersMissing.join(', ')}`;
    toast(msg);
    await loadReports(); renderSection(CURRENT_SEC);
  } catch (e) { toast(e.message); }
  b.disabled = false; b.textContent = 'Reconstruir histórico';
}

async function clearSeriesCache() {
  if (!confirm('¿Limpiar la caché de precios (incluidas las series de prueba)? En la próxima carga se bajan datos reales de FMP (necesita cupo disponible).')) return;
  try { await api('/admin/clear-series', { method: 'POST', body: '{}' }); toast('Caché de precios limpiada. Reconstruí o calculá para bajar datos reales.'); }
  catch (e) { toast(e.message); }
}

async function delReport(id) {
  if (!confirm('¿Borrar este reporte?')) return;
  try { await api('/reports/' + id, { method: 'DELETE' }); toast('Reporte borrado'); await loadReports(); renderReportsList(); }
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
  document.getElementById('sg-all').onclick = toggleAllTech;
  document.getElementById('sg-tickers').addEventListener('change', (e) => { if (e.target.classList.contains('sg-tk')) saveSuggestTickers(); });
  document.getElementById('bf-go').onclick = runBackfill;
  document.getElementById('bf-clear').onclick = clearSeriesCache;
  document.getElementById('sv-go').onclick = registerSale;
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
    if (b.dataset.evog) { EVO_GROUP = b.dataset.evog; renderEvolution(); }
    if (b.dataset.wl) { WL_MODE = b.dataset.wl; renderWinLoss(); }
    if (b.dataset.dview) { DISC_VIEW = b.dataset.dview; renderDiscoverResult(DISC_ITEMS, LAST_DISC_AI); }
    if (b.dataset.rfview) { RF_VIEW = b.dataset.rfview; renderRentaFija(); }
  });
  // ---- Renta fija ----
  document.getElementById('rf-imp-boletos').onclick = () => document.getElementById('rf-file-boletos').click();
  document.getElementById('rf-imp-crono').onclick = () => document.getElementById('rf-file-crono').click();
  document.getElementById('rf-file-boletos').addEventListener('change', onImportBoletos);
  document.getElementById('rf-file-crono').addEventListener('change', onImportCronograma);
  document.getElementById('rf-refresh').onclick = rfRefreshPrices;
  document.getElementById('rf-add').onclick = openRfTradeForm;
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

// ==================== RENTA FIJA ====================
const rfPct = (n) => n === null || n === undefined ? '—' : (n > 0 ? '+' : '') + round2(n) + '%';
const nf = (n) => n === null || n === undefined ? '—' : Number(n).toLocaleString('es-AR', { maximumFractionDigits: 0 });
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

async function loadRf() {
  try { RF_DATA = await api('/rf/holdings'); } catch (e) { RF_DATA = { rows: [], totals: {}, monthly: [], upcoming: [], hasData: false }; }
}
async function loadRfCons() {
  try { RF_CONS = await api('/rf/consolidated'); } catch (e) { RF_CONS = null; }
}

async function renderRentaFija() {
  document.querySelectorAll('#sec-rentafija .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.rfview === RF_VIEW));
  const el = document.getElementById('rf-content');
  if (!el) return;
  el.innerHTML = '<div class="muted-sm" style="padding:20px 4px">Cargando…</div>';
  if (RF_VIEW === 'variable') return rfRenderVariable(el);
  if (RF_VIEW === 'consolidado') { await loadRfCons(); return rfRenderConsolidado(el); }
  await loadRf();
  rfRenderFija(el);
}

function rfKpiCards(items) {
  return '<div class="cards">' + items.map(k =>
    `<div class="card"><div class="card-label">${esc(k.label)}</div><div class="card-value ${k.cls || ''}">${k.value}</div>${k.sub ? `<div class="muted-sm ${k.cls || ''}">${k.sub}</div>` : ''}</div>`
  ).join('') + '</div>';
}

// ---- Vista Renta variable (CEDEARs, resumen) ----
function rfRenderVariable(el) {
  const rows = (HOLDINGS || []).filter(h => h.positionValue != null);
  const value = rows.reduce((a, r) => a + (r.positionValue || 0), 0);
  const cost = rows.reduce((a, r) => a + (r.positionCost || 0), 0);
  const pl = value - cost, plpct = cost > 0 ? pl / cost * 100 : null;
  let html = rfKpiCards([
    { label: 'Capital aportado', value: money(cost) },
    { label: 'Valor actual', value: money(value) },
    { label: 'Ganancia', value: money(pl), cls: cls(pl) },
    { label: 'Rendimiento', value: rfPct(plpct), cls: cls(pl) },
  ]);
  const top = [...rows].sort((a, b) => (b.positionValue || 0) - (a.positionValue || 0)).slice(0, 12);
  html += `<div class="muted-sm" style="margin:14px 0 8px">Detalle completo y filtros en la sección <b>Cartera</b>.</div>`;
  html += rfTable(
    ['Ticker', 'Valor', 'P/G', 'Peso'],
    top.map(r => [tb(r.ticker), money(r.positionValue), `<span class="${cls(r.plPct)}">${rfPct(r.plPct)}</span>`, r.weight != null ? round2(r.weight) + '%' : '—']),
    [1, 0, 0, 0]
  );
  el.innerHTML = html;
}

// ---- Vista Renta fija ----
function rfRenderFija(el) {
  const d = RF_DATA || {};
  if (!d.hasData) {
    el.innerHTML = `<div class="panel" style="text-align:center;padding:32px 16px;box-shadow:none;border:1px dashed var(--line)">
      <div style="font-size:15px;margin-bottom:6px">Todavía no cargaste renta fija</div>
      <div class="muted-sm" style="margin-bottom:14px">Importá el export de <b>boletos</b> del broker para ver tus ONs y bonos, y el <b>cronograma</b> (DetallePagos) para los cupones.</div>
      <button class="btn primary" onclick="document.getElementById('rf-file-boletos').click()">⬆️ Importar boletos</button>
    </div>`;
    return;
  }
  const t = d.totals || {};
  let html = rfKpiCards([
    { label: 'Capital aportado', value: money(t.capitalAportado) },
    { label: 'Valor actual', value: money(t.valorActual) },
    { label: 'Gan. capital', value: money(t.gananciaCapital), cls: cls(t.gananciaCapital) },
    { label: 'Renta cobrada', value: money(t.rentaCobrada), cls: t.rentaCobrada > 0 ? 'pos' : '' },
    { label: 'Total', value: money(t.gananciaTotal), sub: rfPct(t.rendimientoPct), cls: cls(t.gananciaTotal) },
  ]);

  if (t.sinPrecio > 0) {
    html += `<div class="muted-sm" style="margin:12px 0 0;padding:9px 12px;border:1px dashed var(--line);border-radius:10px">
      ⚠️ ${t.sinPrecio} ${t.sinPrecio === 1 ? 'posición valuada' : 'posiciones valuadas'} al costo (sin precio de mercado).
      <a href="#" id="rf-nudge-refresh">Actualizar precios</a> o cargalos a mano en la tabla.</div>`;
  }

  if ((d.monthly || []).length) {
    html += `<div class="panel-head" style="margin-top:18px"><h2 style="font-size:15px">Renta a cobrar por mes</h2></div>
      <div class="muted-sm" style="margin:-4px 0 6px">Cupones y amortizaciones proyectados (${CONFIG.currency || 'USD'})</div>
      <div class="chart-wrap" style="height:200px"><canvas id="rf-chart-monthly"></canvas></div>`;
  }
  if ((d.upcoming || []).length) {
    html += `<div class="panel-head" style="margin-top:16px"><h2 style="font-size:15px">Próximos cupones</h2></div>
      <div class="totals-strip" style="flex-direction:column;gap:0">` +
      d.upcoming.slice(0, 6).map(p => `<div style="display:flex;justify-content:space-between;padding:7px 2px;border-bottom:1px solid var(--line)">
        <span>${fmtDate(p.fecha)} · ${tb(p.ticker)} · <span class="muted-sm">${esc(p.tipo)}</span></span>
        <span>${money(p.total)}</span></div>`).join('') + `</div>`;
  }

  html += `<div class="panel-head" style="margin-top:16px"><h2 style="font-size:15px">Tenencias</h2></div>`;
  html += rfTable(
    ['Ticker', 'VN', 'P.compra', 'P.actual', 'Valor', 'Gan. capital', 'Renta cobr.'],
    (d.rows || []).map(r => [
      `${tb(r.ticker)} <span class="muted-sm">${esc(r.clase)}</span>`,
      nf(r.vn),
      r.precioCompra != null ? round2(r.precioCompra) : '—',
      r.precioActual != null
        ? `${round2(r.precioActual)} <span title="${r.precioSource === 'manual' ? 'precio manual' : 'precio automático'}">${r.precioSource === 'manual' ? '✏️' : '📶'}</span> <a href="#" class="muted-sm rf-editpx" data-tk="${esc(r.ticker)}" data-px="${r.precioActual}">editar</a>`
        : `<a href="#" class="rf-editpx" data-tk="${esc(r.ticker)}" data-px="">cargar</a>`,
      r.valorActual != null ? money(r.valorActual) : '—',
      r.ganCapital != null ? `<span class="${cls(r.ganCapital)}">${money(r.ganCapital)}${r.ganCapitalPct != null ? ` <span class="muted-sm">${rfPct(r.ganCapitalPct)}</span>` : ''}</span>` : '—',
      r.rentaCobrada > 0 ? `<span class="pos">${money(r.rentaCobrada)}</span>` : '—',
    ]),
    [1, 0, 0, 0, 0, 0, 0]
  );
  el.innerHTML = html;

  if ((d.monthly || []).length) rfMonthlyChart('rf-chart-monthly', d.monthly);
  el.querySelectorAll('.rf-editpx').forEach(a => a.onclick = (e) => {
    e.preventDefault(); rfSetPrice(a.dataset.tk, a.dataset.px);
  });
  const nudge = document.getElementById('rf-nudge-refresh');
  if (nudge) nudge.onclick = (e) => { e.preventDefault(); rfRefreshPrices(); };
}

// ---- Vista Consolidado ----
function rfRenderConsolidado(el) {
  const c = RF_CONS;
  if (!c) { el.innerHTML = '<div class="muted-sm" style="padding:20px 4px">No se pudo cargar el consolidado.</div>'; return; }
  const tt = c.total || {};
  let html = rfKpiCards([
    { label: 'Capital aportado', value: money(tt.capitalAportado) },
    { label: 'Valor actual', value: money(tt.valorActual) },
    { label: 'Renta cobrada', value: money(c.fija.rentaCobrada), cls: c.fija.rentaCobrada > 0 ? 'pos' : '' },
    { label: 'Ganancia total', value: money(tt.gananciaTotal), sub: rfPct(tt.rendimientoPct), cls: cls(tt.gananciaTotal) },
  ]);
  html += `<div class="grid2" style="margin-top:16px">
    <div class="panel" style="box-shadow:none;border:1px solid var(--line)">
      <div class="chart-wrap" style="height:200px"><canvas id="rf-chart-donut"></canvas></div>
    </div>
    <div class="panel" style="box-shadow:none;border:1px solid var(--line)">
      <div style="display:flex;flex-direction:column;gap:12px;padding:6px 2px">
        ${rfClassRow('#3b82f6', 'Renta variable · CEDEARs', c.variable, c.pesos.variable)}
        ${rfClassRow('#34d399', 'Renta fija · ON + bonos', c.fija, c.pesos.fija)}
        <div style="border-top:1px solid var(--line);padding-top:10px;display:flex;justify-content:space-between">
          <span class="muted-sm">Rendimiento total</span>
          <span class="${cls(tt.gananciaTotal)}">${money(tt.gananciaTotal)} · ${rfPct(tt.rendimientoPct)}</span>
        </div>
      </div>
    </div>
  </div>`;
  if ((c.monthly || []).length) {
    html += `<div class="panel-head" style="margin-top:16px"><h2 style="font-size:15px">Renta a cobrar por mes</h2></div>
      <div class="muted-sm" style="margin:-4px 0 6px">Sólo aplica a la parte de renta fija</div>
      <div class="chart-wrap" style="height:200px"><canvas id="rf-chart-monthly"></canvas></div>`;
  }
  el.innerHTML = html;
  rfDonut('rf-chart-donut', c);
  if ((c.monthly || []).length) rfMonthlyChart('rf-chart-monthly', c.monthly);
}
function rfClassRow(color, label, v, peso) {
  return `<div style="display:flex;align-items:center;gap:8px">
    <span style="width:11px;height:11px;border-radius:3px;background:${color};flex-shrink:0"></span>
    <div style="flex:1"><div>${esc(label)}</div><div class="muted-sm">${money(v.valorActual)} · ${round2(peso)}%</div></div>
    <span class="${cls(v.ganancia)}">${money(v.ganancia)} · ${rfPct(v.rendimientoPct)}</span>
  </div>`;
}

function rfTable(headers, rows, alignLeft) {
  const th = headers.map((h, i) => `<th style="padding:8px 6px;text-align:${alignLeft[i] ? 'left' : 'right'};font-size:12px;color:var(--muted);font-weight:600">${h}</th>`).join('');
  const tr = rows.length ? rows.map(r => '<tr>' + r.map((c, i) => `<td style="padding:8px 6px;text-align:${alignLeft[i] ? 'left' : 'right'};border-top:1px solid var(--line);font-size:13px">${c}</td>`).join('') + '</tr>').join('')
    : `<tr><td colspan="${headers.length}" style="padding:14px;color:var(--muted)">Sin datos.</td></tr>`;
  return `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse">${'<thead><tr>' + th + '</tr></thead>'}<tbody>${tr}</tbody></table></div>`;
}

function rfMonthlyChart(id, monthly) {
  const cv = document.getElementById(id); if (!cv || typeof Chart === 'undefined') return;
  if (CHARTS[id]) { CHARTS[id].destroy(); }
  const labels = monthly.map(m => { const [y, mm] = m.ym.split('-'); return ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'][+mm - 1] + ' ' + y.slice(2); });
  const data = monthly.map(m => round2(m.total));
  const max = Math.max(...data, 0);
  CHARTS[id] = new Chart(cv, {
    type: 'bar',
    data: { labels, datasets: [{ data, backgroundColor: data.map(v => v >= max ? '#0f6e56' : '#1D9E75'), borderRadius: 4 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (x) => (CONFIG.currency || 'USD') + ' ' + Number(x.raw).toLocaleString('es-AR') } } },
      scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { callback: (v) => v >= 1000 ? (v / 1000) + 'k' : v } } },
    },
  });
}
function rfDonut(id, c) {
  const cv = document.getElementById(id); if (!cv || typeof Chart === 'undefined') return;
  if (CHARTS[id]) { CHARTS[id].destroy(); }
  CHARTS[id] = new Chart(cv, {
    type: 'doughnut',
    data: { labels: ['Renta variable', 'Renta fija'], datasets: [{ data: [round2(c.variable.valorActual), round2(c.fija.valorActual)], backgroundColor: ['#3b82f6', '#34d399'], borderWidth: 0 }] },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '62%',
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, padding: 12 } }, tooltip: { callbacks: { label: (x) => x.label + ': ' + round2(c.pesos[x.dataIndex === 0 ? 'variable' : 'fija']) + '%' } } },
    },
  });
}

// ---- Imports (xlsx en el navegador con SheetJS) ----
function toYmd(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) { let [, d, mo, y] = m; if (y.length === 2) y = '20' + y; return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`; }
  return s.slice(0, 10);
}
async function readSheet(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { defval: null, raw: true });
}
const col = (row, ...names) => { for (const n of names) { for (const k of Object.keys(row)) if (k.toLowerCase().trim() === n.toLowerCase()) return row[k]; } return null; };

async function onImportBoletos(e) {
  const file = e.target.files[0]; e.target.value = ''; if (!file) return;
  if (typeof XLSX === 'undefined') return toast('No se pudo cargar el lector de Excel');
  if (!confirm('Importar boletos reemplaza los datos importados previos de renta fija (los movimientos que cargaste a mano se conservan). ¿Seguir?')) return;
  toast('Leyendo archivo…');
  try {
    const raw = await readSheet(file);
    const rows = raw.map(r => ({
      especie: col(r, 'Especie'), ticker: col(r, 'Ticker'), side: col(r, 'Tipo'),
      cantidad: col(r, 'Cantidad'), precio: col(r, 'Precio'), neto: col(r, 'Neto'),
      moneda: col(r, 'Moneda'), fecha: toYmd(col(r, 'Concertacion', 'Fecha', 'Liquidacion')),
    })).filter(r => r.ticker);
    if (!rows.length) return toast('No se detectaron filas con ticker');
    const res = await api('/rf/import-boletos', { method: 'POST', body: JSON.stringify({ rows }) });
    toast(`Importados ${res.imported} boletos · ${res.posiciones} posiciones de renta fija`);
    RF_VIEW = 'fija'; RF_DATA = null; RF_CONS = null; renderRentaFija();
  } catch (err) { toast('Error al importar: ' + err.message); }
}
async function onImportCronograma(e) {
  const file = e.target.files[0]; e.target.value = ''; if (!file) return;
  if (typeof XLSX === 'undefined') return toast('No se pudo cargar el lector de Excel');
  toast('Leyendo cronograma…');
  try {
    const raw = await readSheet(file);
    const rows = raw.map(r => ({
      ticker: col(r, 'Ticker', 'Especie'), fecha: toYmd(col(r, 'Fecha')),
      renta: col(r, 'Renta'), amortizacion: col(r, 'Amortizacion', 'Amortización'), total: col(r, 'Total'),
    })).filter(r => r.ticker && r.fecha);
    if (!rows.length) return toast('No se detectaron pagos válidos');
    const res = await api('/rf/import-cronograma', { method: 'POST', body: JSON.stringify({ rows }) });
    toast(`Cronograma actualizado · ${res.imported} pagos`);
    RF_DATA = null; RF_CONS = null; renderRentaFija();
  } catch (err) { toast('Error al importar cronograma: ' + err.message); }
}

async function rfRefreshPrices() {
  const b = document.getElementById('rf-refresh'); const o = b.textContent; b.disabled = true; b.textContent = 'Actualizando…';
  try {
    const r = await api('/rf/refresh-prices', { method: 'POST', body: '{}' });
    toast(r.updated ? `Precios actualizados: ${r.updated}` : ('Sin precios nuevos' + (r.error ? ` (${r.error})` : '')));
    RF_DATA = null; RF_CONS = null; renderRentaFija();
  } catch (e) { toast(e.message); }
  b.disabled = false; b.textContent = o;
}
async function rfSetPrice(ticker, cur) {
  const v = prompt(`Precio actual de ${ticker} (USD por 1 nominal, ej. 1,09):`, cur || '');
  if (v == null) return;
  const price = Number(String(v).replace(',', '.'));
  if (!(price > 0)) return toast('Precio inválido');
  try { await api('/rf/price', { method: 'POST', body: JSON.stringify({ ticker, price }) }); toast('Precio guardado'); RF_DATA = null; RF_CONS = null; renderRentaFija(); }
  catch (e) { toast(e.message); }
}
function openRfTradeForm() {
  document.getElementById('modal-title').textContent = 'Agregar compra / venta de ON o bono';
  document.getElementById('modal-body').innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <label>Ticker<input id="rf-t-ticker" placeholder="YM34O"></label>
      <label>Operación<select id="rf-t-side"><option value="COMPRA">Compra</option><option value="VENTA">Venta</option></select></label>
      <label>Tipo<select id="rf-t-clase"><option value="ON">ON</option><option value="Bono">Bono</option></select></label>
      <label>Nominales (VN)<input id="rf-t-cant" type="number" step="any" placeholder="1000"></label>
      <label>Precio<input id="rf-t-precio" type="number" step="any" placeholder="1.09"></label>
      <label>Moneda<select id="rf-t-moneda"><option>Dólares</option><option>Pesos</option></select></label>
      <label>Fecha<input id="rf-t-fecha" type="date"></label>
      <label>Emisor (opcional)<input id="rf-t-emisor" placeholder="YPF"></label>
    </div>
    <p class="muted-sm" style="margin:8px 0 0">Si la operación es en pesos, se convierte a USD con el MEP de esa fecha automáticamente.</p>`;
  document.getElementById('modal-save').onclick = async () => {
    const body = {
      ticker: document.getElementById('rf-t-ticker').value,
      side: document.getElementById('rf-t-side').value,
      clase: document.getElementById('rf-t-clase').value,
      cantidad: document.getElementById('rf-t-cant').value,
      precio: document.getElementById('rf-t-precio').value,
      moneda: document.getElementById('rf-t-moneda').value,
      fecha: document.getElementById('rf-t-fecha').value,
      emisor: document.getElementById('rf-t-emisor').value,
    };
    if (!body.ticker || !(Number(body.cantidad) > 0)) return toast('Ticker y nominales son obligatorios');
    try { await api('/rf/trade', { method: 'POST', body: JSON.stringify(body) }); closeModal(); toast('Movimiento agregado'); RF_DATA = null; RF_CONS = null; renderRentaFija(); }
    catch (e) { toast(e.message); }
  };
  modal.classList.remove('hidden');
}

// ---------- Init ----------
(async function init() {
  if (typeof Chart !== 'undefined') {
    Chart.defaults.color = '#8a97a8';
    Chart.defaults.borderColor = 'rgba(255,255,255,0.06)';
  }
  bindEvents();
  await loadConfig();
  setEye();
  startIdle();
  try { RATIOS = await api('/ratios'); } catch (e) { RATIOS = {}; }
  CURRENT_SEC = localStorage.getItem(SEC_KEY) || 'resumen';
  await loadAll();
  showSection(CURRENT_SEC);
})();
