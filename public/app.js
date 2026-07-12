// ---------- Estado / helpers ----------
const TOKEN_KEY = 'cartera_token';
const SEC_KEY = 'cartera_sec';
let CONFIG = {};
let RATIOS = {};
const ETFS = new Set(['SPY', 'QQQ', 'EEM', 'EWZ', 'FXI', 'VEA', 'XLV', 'SPXL', 'TQQQ', 'DIA', 'IWM', 'EFA', 'ARKK', 'XLF', 'XLE', 'XLK', 'GLD', 'SLV', 'UPRO', 'SOXL', 'TECL', 'XLP', 'XLU']);
const LEVERAGED = new Set(['TQQQ', 'SPXL', 'UPRO', 'SOXL', 'TECL', 'SQQQ', 'TNA', 'FAS', 'LABU', 'SPXS']);
// El tipo elegido en el catálogo manda; si no hay, se infiere del ticker.
const tType = (t) => {
  const sym = (t || '').toUpperCase().trim();
  const c = (Array.isArray(CATALOG) ? CATALOG : []).find(x => String(x.ticker || '').toUpperCase() === sym);
  if (c && c.tipo) return c.tipo;
  return ETFS.has(sym) ? 'ETF' : 'Acción';
};

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
function ic(name, extra) { return `<i data-lucide="${name}"${extra ? ` class="${extra}"` : ''}></i>`; }
// Placeholder de carga (shimmer) — n líneas.
function skel(n = 6) { return `<div class="skel-rows">${Array.from({ length: n }, () => '<div class="skel skel-line"></div>').join('')}</div>`; }
// Estado vacío con llamada a la acción. btn = {label, onclick} opcional.
function emptyCta(icon, title, sub, btn) {
  return `<div class="empty-cta"><div class="ec-icon">${ic(icon)}</div>`
    + `<div class="ec-title">${title}</div>${sub ? `<div class="ec-sub">${sub}</div>` : ''}`
    + (btn ? `<button class="btn primary" onclick="${btn.onclick}">${btn.icon ? ic(btn.icon) + ' ' : ''}${btn.label}</button>` : '')
    + `</div>`;
}
let _iconT;
function refreshIcons() { clearTimeout(_iconT); _iconT = setTimeout(() => { try { window.lucide && lucide.createIcons(); } catch (e) { /* noop */ } }, 30); }
function setEye() {
  const b = document.getElementById('btn-eye');
  if (!b) return;
  b.innerHTML = HIDE_MONEY ? ic('eye-off') + ' Mostrar' : ic('eye') + ' Ocultar';
  b.title = HIDE_MONEY ? 'Mostrar montos' : 'Ocultar montos';
  refreshIcons();
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
const SEC_TITLES = { rendimientos: 'Rendimientos Totales', resumen: 'Rendimiento RV', cartera: 'Cartera', 'rf-analisis': 'Rendimientos RF', rentafija: 'Renta fija · Cartera', 'rf-mov': 'Renta fija · Movimientos', 'rf-ventas': 'Renta fija · Ventas', 'rf-crono': 'Renta fija · Cronograma', 'rf-catalogo': 'Renta fija · Catálogo', 'rf-sug': 'Renta fija · Sugerencias', sugerencias: 'Sugerencias', descubrir: 'Descubrir', tickers: 'Catálogo', tenencias: 'Movimientos', ventas: 'Ventas', reportes: 'Reportes diarios' };
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
  if (!document.getElementById('sec-' + sec)) sec = 'rendimientos';
  if (sec === 'rendimientos') renderRendimientos();
  else if (sec === 'resumen') renderResumen();
  else if (sec === 'cartera') renderCartera();
  else if (sec === 'rentafija') renderRentaFija();
  else if (sec === 'rf-analisis') renderRfAnalisis();
  else if (sec === 'rf-mov') renderRfMovimientos();
  else if (sec === 'rf-ventas') renderRfVentas();
  else if (sec === 'rf-crono') renderRfCronograma();
  else if (sec === 'rf-catalogo') renderRfCatalogo();
  else if (sec === 'rf-sug') renderRfSug();
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
  const chkR = document.getElementById('chk-renta-reminder');
  if (chkR) chkR.checked = SETTINGS.rentaReminder !== false;
}
let GUIDE_MAP = {};
async function loadGuide() { try { const g = await api('/guide'); GUIDE_MAP = g.map || {}; } catch { GUIDE_MAP = {}; } }
async function loadAll() {
  await refreshCatalog();
  await loadDashboard();
  await loadReports();
  await loadSales();
  await loadSettings();
  loadGuide();
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
    const g = (by[h.ticker] ??= { ticker: h.ticker, type: h.type, region: h.region, ratio: h.ratio, price: h.price, changePct: h.changePct, quantity: 0, shares: 0, cost: 0, value: 0, lots: 0 });
    const shares = h.ratio > 0 ? h.quantity / h.ratio : 0;
    g.quantity += h.quantity; g.shares += shares; g.cost += h.positionCost || 0; g.value += h.positionValue || 0; g.lots += 1;
  }
  return Object.values(by).map(g => {
    const plAbs = round2(g.value - g.cost);
    const plPct = g.cost > 0 ? round2((plAbs / g.cost) * 100) : null;
    return {
      ticker: g.ticker, type: g.type, region: g.region || 'Sin clasificar', ratio: g.ratio, price: g.price, changePct: g.changePct,
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
  renderDist(); renderWinLoss(); renderGeo(); renderEvolution(); renderYearTable();
}

// Exposición geográfica: cuánta plata tenés en cada región, de mayor a menor.
function renderGeo() {
  const rows = consolidate(HOLDINGS).filter(r => r.positionValue > 0);
  const by = {};
  rows.forEach(r => {
    const reg = r.region || 'Sin clasificar';
    (by[reg] ??= { valor: 0, tickers: [] });
    by[reg].valor += r.positionValue || 0;
    by[reg].tickers.push(r.ticker);
  });
  const pairs = Object.entries(by).map(([reg, v]) => ({ reg, ...v })).sort((a, b) => b.valor - a.valor);
  const total = pairs.reduce((a, p) => a + p.valor, 0);
  const cv = document.getElementById('chart-geo');
  if (cv && cv.parentElement) cv.parentElement.style.height = Math.max(200, pairs.length * 38) + 'px';
  const COLORS = { EEUU: '#1a5fb4', Latam: '#e08a00', Brasil: '#2f9e44', China: '#c0271a', Argentina: '#17a2b8', Global: '#6f42c1', México: '#d63384', Chile: '#0c5460', Europa: '#3b5bdb', Asia: '#e8590c' };
  const note = document.getElementById('geo-note');
  if (note) {
    const sin = by['Sin clasificar'];
    note.textContent = sin
      ? `Sin región asignada: ${sin.tickers.join(', ')} — cargala en el Catálogo (editar ticker → Región).`
      : 'Los ETFs globales (EEM, VEA) son canastas de muchos países, por eso van como "Global".';
  }
  drawChart('geo', 'chart-geo', {
    type: 'bar',
    data: {
      labels: pairs.map(p => p.reg),
      datasets: [{ data: pairs.map(p => round2(p.valor)), backgroundColor: pairs.map(p => COLORS[p.reg] || '#5f6c80'), borderRadius: 4 }],
    },
    options: {
      indexAxis: 'y', maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (x) => {
          const p = pairs[x.dataIndex];
          const pct = total > 0 ? round2(p.valor / total * 100) : 0;
          return [`${money(p.valor)} · ${pct}%`, p.tickers.join(', ')];
        } } },
      },
      scales: {
        x: { beginAtZero: true, ticks: { callback: (v) => v >= 1000 ? (v / 1000) + 'k' : v } },
        y: { ticks: { autoSkip: false, font: { size: 12 } } },
      },
    },
  });
}

// Alto de fila COMPARTIDO por Distribución y Ganadoras/perdedoras, así las dos
// (mismo orden y misma cantidad de tickers) quedan alineadas fila por fila.
function rvRowsAlineadas() {
  return consolidate(HOLDINGS).filter(r => r.positionValue > 0)
    .sort((a, b) => (b.positionValue || 0) - (a.positionValue || 0));
}
function rvChartHeight(n) { return Math.max(260, n * 30) + 'px'; }

function renderDist() {
  let labels, data;
  if (DIST_MODE === 'type') {
    const rows = consolidate(HOLDINGS).filter(r => r.positionValue > 0);
    const by = {}; rows.forEach(r => by[r.type] = (by[r.type] || 0) + r.positionValue);
    const pairs = Object.entries(by).map(([l, v]) => ({ l, v })).sort((a, b) => b.v - a.v);
    labels = pairs.map(p => p.l); data = pairs.map(p => Math.round(p.v * 100) / 100);
  } else {
    // Mismo orden que Ganadoras/perdedoras (por valor de posición, desc).
    const rows = rvRowsAlineadas();
    labels = rows.map(r => r.ticker); data = rows.map(r => Math.round((r.positionValue || 0) * 100) / 100);
  }
  const total = data.reduce((a, b) => a + b, 0);
  const cv = document.getElementById('chart-dist');
  if (cv && cv.parentElement) cv.parentElement.style.height = rvChartHeight(labels.length);
  drawChart('dist', 'chart-dist', {
    type: 'bar',
    data: { labels, datasets: [{ data, backgroundColor: '#3b82f6', borderRadius: 4 }] },
    options: {
      indexAxis: 'y', maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => {
          const v = ctx.parsed.x; const p = total ? Math.round((v / total) * 1000) / 10 : 0;
          return `${(CONFIG.currency || 'USD')} ${Number(v).toLocaleString('es-AR')} · ${p}%`;
        } } },
      },
      scales: {
        x: { beginAtZero: true, ticks: { callback: (v) => v >= 1000 ? (v / 1000) + 'k' : v } },
        y: { ticks: { autoSkip: false, font: { size: 11 } } },
      },
    },
  });
}

function renderWinLoss() {
  const usd = WL_MODE === 'usd';
  const key = usd ? 'plAbs' : 'plPct';
  // Mismo conjunto y orden que el gráfico de tenencias (Distribución por ticker):
  // ordenado por valor de posición, de mayor a menor, así cada ticker queda a la
  // misma altura en los dos gráficos. El color sigue marcando ganancia/pérdida.
  const sel = rvRowsAlineadas();
  const cv = document.getElementById('chart-wl');
  if (cv && cv.parentElement) cv.parentElement.style.height = rvChartHeight(sel.length);
  drawChart('wl', 'chart-wl', {
    type: 'bar',
    data: {
      labels: sel.map(r => r.ticker),
      datasets: [{ data: sel.map(r => r[key] != null ? r[key] : 0), backgroundColor: sel.map(r => (r[key] || 0) >= 0 ? '#0a7d33' : '#c0271a'), borderRadius: 4 }],
    },
    options: {
      indexAxis: 'y', maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => usd ? money(ctx.parsed.x) : ctx.parsed.x + '%' } },
      },
      scales: {
        x: { ticks: { callback: v => (usd && HIDE_MONEY) ? '' : (usd ? v : v + '%') } },
        y: { ticks: { autoSkip: false, font: { size: 11 } } },
      },
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
    el.innerHTML = HOLDINGS.length
      ? '<div class="empty">Ningún resultado con esos filtros.</div>'
      : emptyCta('briefcase', 'Todavía no cargaste tu cartera', 'Agregá tus compras de acciones y CEDEARs para ver valuación, resultado y evolución.', { label: 'Agregar tenencia', icon: 'plus', onclick: "showSection('tenencias')" });
  } else if (f.view === 'consolidated') {
    el.innerHTML = `<table><thead><tr>
        <th>Ticker</th><th class="num">Compra prom.</th><th class="num">Actual</th>
        <th class="num">Hoy</th><th class="num">P/G</th><th class="num">Peso</th><th class="num hide-sm">Valor</th>
      </tr></thead><tbody>${pageRows.map(r => `
        <tr>
          <td>${tb(r.ticker)} <span class="muted-sm">${r.type} · ${r.quantity} nominales · ${r.lots} lote${r.lots > 1 ? 's' : ''}</span></td>
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
          <td>${tb(h.ticker)} <span class="muted-sm">${h.type} · ${h.quantity} nominales · ratio ${h.ratio}</span>${tagsHtml(h.observations)}</td>
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
          <td class="num row-actions"><button title="Cambiar ratio (split)" onclick='openRatioChange(${JSON.stringify(w).replace(/'/g, "&#39;")})'>${ic('repeat-2')}</button><button title="Editar" onclick='openWatchForm(${JSON.stringify(w).replace(/'/g, "&#39;")})'>${ic('pencil')}</button><button title="Borrar" onclick="delWatch(${w.id})">${ic('trash-2')}</button></td>
        </tr>`;
      }).join('')}</tbody></table>`;
}

// ---------- TENENCIAS (gestión) ----------
function renderManage() {
  const el = document.getElementById('manage-table');
  const compras = (HOLDINGS || []).map(h => ({
    fecha: h.purchase_date, ticker: h.ticker, op: 'COMPRA', nominales: h.quantity, precio: h.buy_price,
    sub: `${tType(h.ticker)} · ratio ${h.ratio}`,
    actions: `<button onclick='openHoldingForm(${JSON.stringify(h).replace(/'/g, "&#39;")})'>${ic('pencil')}</button><button onclick="delHolding(${h.id})">${ic('trash-2')}</button>`,
  }));
  const ventas = (SALES || []).map(s => ({
    fecha: s.sell_date, ticker: s.ticker, op: 'VENTA', nominales: s.quantity, precio: s.sell_price,
    sub: 'venta', actions: `<button title="Borrar (devuelve la cantidad)" onclick="delSale(${s.id})">${ic('trash-2')}</button>`,
  }));
  const all = [...compras, ...ventas].sort((a, b) => String(b.fecha || '').localeCompare(String(a.fecha || '')));
  if (!all.length) { el.innerHTML = emptyCta('arrow-left-right', 'No hay movimientos', 'Registrá tus compras y ventas para armar el histórico de la cartera.', { label: 'Agregar tenencia', icon: 'plus', onclick: 'openHoldingForm()' }); return; }
  el.innerHTML = `<div class="muted-sm" style="margin-bottom:8px">${compras.length} compras · ${ventas.length} ventas</div>
    <table><thead><tr>
      <th>Ticker</th><th class="num">Fecha</th><th>Op</th><th class="num">Nominales</th><th class="num">Precio</th><th class="num"></th>
    </tr></thead><tbody>${all.map(m => `
      <tr>
        <td>${tb(m.ticker)} <span class="muted-sm">${m.sub}</span></td>
        <td class="num">${fmtDate(m.fecha)}</td>
        <td><span class="${m.op === 'VENTA' ? 'neg' : 'pos'}">${m.op === 'VENTA' ? 'Venta' : 'Compra'}</span></td>
        <td class="num">${m.nominales}</td>
        <td class="num">${money(m.precio)}</td>
        <td class="num row-actions">${m.actions}</td>
      </tr>`).join('')}</tbody></table>`;
}

// ---------- VENTAS ----------
function renderVentas() {
  const sel = document.getElementById('sv-lot');
  const lots = HOLDINGS.filter(h => Number(h.quantity) > 0)
    .sort((a, b) => a.ticker.localeCompare(b.ticker) || String(a.purchase_date || '').localeCompare(String(b.purchase_date || '')));
  sel.innerHTML = lots.length
    ? lots.map(h => `<option value="${h.id}">${h.ticker} · ${fmtDate(h.purchase_date)} · ${h.quantity} nominales · compra ${money(h.buy_price)}</option>`).join('')
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
        <td class="num row-actions"><button title="Borrar (devuelve la cantidad)" onclick="delSale(${s.id})">${ic('trash-2')}</button></td>
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
  if (badge) badge.innerHTML = (CONFIG.aiEnabled ? ic('bot') + ' IA activa' : 'IA no configurada') + (CONFIG.signalsEnabled ? ' · ' + ic('trending-up') + ' datos FMP' : ' · sin datos FMP');
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
  const noticeHtml = data.notice ? `<div class="notice">${ic('alert-triangle')} ${data.notice}</div>` : '';
  const ti = data.techInfo;
  let techNote = '';
  if (ti && ti.enabled && ti.count === 0) techNote = `<div class="notice">Sin indicadores técnicos: FMP no devolvió datos${ti.error ? ` — ${ti.error}` : ''}.</div>`;
  else if (ti && !ti.enabled) techNote = `<div class="muted-sm" style="margin-bottom:8px">Indicadores técnicos desactivados (falta FMP_API_KEY en el servidor).</div>`;
  const gSenal = (tk) => (GUIDE_MAP[String(tk).toUpperCase()] || {}).senal || null;
  const gPerfil = (tk) => (GUIDE_MAP[String(tk).toUpperCase()] || {}).perfil || null;
  const hasGuide = Object.keys(GUIDE_MAP).length > 0;
  const vender = rows.filter(r => gSenal(r.ticker) === 'Vender').map(r => r.ticker);
  const fuera = hasGuide ? rows.filter(r => !gSenal(r.ticker)).map(r => r.ticker) : [];
  const guideAlert = (vender.length ? `<div style="margin-bottom:10px;padding:9px 12px;border:1px solid var(--red);border-radius:10px;color:var(--red);font-size:13px">${ic('alert-triangle')} Sugiere comprar algo que tu guía marca <b>Vender</b>: ${vender.join(', ')}.</div>` : '')
    + (fuera.length ? `<div class="muted-sm" style="margin-bottom:8px">${ic('alert-triangle')} Fuera de tu guía: ${fuera.join(', ')}</div>` : '')
    + (hasGuide && !vender.length && !fuera.length ? `<div class="muted-sm" style="margin-bottom:8px"><span class="pos">✓</span> Todo lo sugerido está en tu guía.</div>` : '');
  document.getElementById('sg-result').innerHTML = `
    ${noticeHtml}${techNote}${guideAlert}
    <div class="totals-strip">
      <span>A invertir: <b>${money(p.amount)}</b></span>
      <span>Distribuido: <b>${money(p.invested)}</b></span>
      <span>Sobrante: <b>${money(p.leftover)}</b></span>
      <span>Cartera resultante: <b>${money(p.resultingTotal)}</b></span>
    </div>
    ${rows.length ? `<table><thead><tr>
      <th>Ticker</th><th>Guía</th><th class="num">Comprar</th><th class="num">% del aporte</th><th class="num hide-sm">Precio CEDEAR</th><th class="num hide-sm">Monto aprox.</th><th class="num">Peso (actual→obj.→final)</th>
    </tr></thead><tbody>${rows.map(r => `
      <tr>
        <td>${r.preferida ? ic('star') : ic('search')} ${tb(r.ticker)} <span class="muted-sm">${r.type}${r.preferida ? '' : ' · nuevo'}</span>${r.preferida ? '' : ` <button class="btn" style="padding:2px 7px;font-size:12px" onclick='addSuggested(${JSON.stringify(r.ticker)},${r.ratio},${r.ratioKnown},${JSON.stringify(r.name || '')})'>+ Agregar</button>`}${techBadges(r.tech)}</td>
        <td>${senalBadge(gSenal(r.ticker))} ${perfilChip(gPerfil(r.ticker))}</td>
        <td class="num"><b>${r.cedears}</b></td>
        <td class="num"><b>${r.pctOfNew}%</b></td>
        <td class="num hide-sm">${money(r.cedearPrice)}</td>
        <td class="num hide-sm">${money(r.buyMoney)}</td>
        <td class="num"><span class="muted-sm">${r.currentWeight}% → ${r.targetWeight}% →</span> <b>${r.resultingWeight}%</b></td>
      </tr>`).join('')}</tbody></table>` : '<div class="empty">No hay compras sugeridas con esos parámetros.</div>'}
    ${rows.length && rows.some(r => r.tech) ? TECH_LEGEND : ''}
    <div class="rationale">${ic('lightbulb')} <b>${explTitle}:</b> ${expl}</div>`;
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
  if (badge) badge.innerHTML = CONFIG.aiEnabled ? ic('bot') + ' IA disponible' : 'IA no configurada';
  const f = discFilters();
  const el = document.getElementById('disc-result');
  el.innerHTML = skel(5);
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
  const aiHtml = LAST_DISC_AI ? `<div class="rationale">${ic('bot')} <b>Análisis IA:</b> ${LAST_DISC_AI}</div>` : '';
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
      <td class="num">${r.emailed ? ic('mail') + ' enviado' : '—'}</td>
      <td class="num row-actions"><button title="Borrar" onclick="delReport(${r.id})">${ic('trash-2')}</button></td>
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
  const tipoActual = w?.tipo || tType(w?.ticker);
  const opts = ['Acción', 'ETF', 'ETF apalancado']
    .map(o => `<option${o === tipoActual ? ' selected' : ''}>${o}</option>`).join('');
  const regionActual = w?.region || '';
  const regOpts = ['', 'EEUU', 'Latam', 'Brasil', 'Argentina', 'México', 'Chile', 'China', 'Europa', 'Asia', 'Global']
    .map(o => `<option value="${o}"${o === regionActual ? ' selected' : ''}>${o || '(automática)'}</option>`).join('');
  document.getElementById('modal-body').innerHTML =
    field('Ticker (ej. NVDA)', 'wticker', w?.ticker || '', 'text', 'NVDA') +
    `<label>Tipo</label><select id="f-wtipo">${opts}</select>` +
    `<label>Región</label><select id="f-wregion">${regOpts}</select>` +
    field('Ratio (CEDEARs por acción)', 'wratio', w?.ratio ?? '', 'number', '1') +
    field('Notas (opcional)', 'wnotes', w?.notes || '');
  const tEl = document.getElementById('f-wticker'), rEl = document.getElementById('f-wratio');
  const tipoEl = document.getElementById('f-wtipo'), regEl = document.getElementById('f-wregion');
  if (w) tEl.setAttribute('readonly', 'true');
  const fill = () => {
    const sym = tEl.value.toUpperCase().trim();
    const s = RATIOS[sym]; if (s && !rEl.value) rEl.value = s;
    // Sugerencia de tipo por el ticker (el usuario la puede cambiar).
    if (!w && sym && ETFS.has(sym)) tipoEl.value = LEVERAGED.has(sym) ? 'ETF apalancado' : 'ETF';
  };
  tEl.addEventListener('input', fill); tEl.addEventListener('blur', fill);
  document.getElementById('modal-save').onclick = async () => {
    const body = { ticker: tEl.value.trim(), tipo: tipoEl.value, region: regEl.value || null, ratio: parseFloat(rEl.value) || null, notes: document.getElementById('f-wnotes').value };
    if (!body.ticker) return toast('El ticker es obligatorio');
    try {
      if (w) await api('/watchlist/' + w.id, { method: 'PUT', body: JSON.stringify({ ratio: body.ratio, notes: body.notes, tipo: body.tipo, region: body.region }) });
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
  document.getElementById('btn-search').onclick = openCmdK;
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
  document.getElementById('chk-renta-reminder').addEventListener('change', async function () {
    try {
      SETTINGS = await api('/settings', { method: 'POST', body: JSON.stringify({ rentaReminder: this.checked }) });
      toast(SETTINGS.rentaReminder ? 'Aviso de renta activado' : 'Aviso de renta desactivado');
    } catch (e) { toast(e.message); this.checked = !this.checked; }
  });
  document.getElementById('btn-renta-test').addEventListener('click', async function () {
    this.disabled = true; const o = this.textContent; this.textContent = 'Enviando…';
    try {
      const r = await api('/rf/renta-reminder/test', { method: 'POST', body: '{}' });
      toast(r.sent ? `Aviso enviado (${(r.tickers || []).join(', ')})` : (r.reason || 'No se envió') + (r.reason === 'Sin pagos ese día' ? '' : ''));
    } catch (e) { toast(e.message); }
    this.disabled = false; this.textContent = o;
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
    if (b.dataset.rfgain) { RF_GAIN_MODE = b.dataset.rfgain; drawRfGain(); }
  });
  // ---- Renta fija ----
  document.getElementById('rf-imp-boletos').onclick = () => document.getElementById('rf-file-boletos').click();
  document.getElementById('rf-imp-crono').onclick = () => document.getElementById('rf-file-crono').click();
  document.getElementById('rf-file-boletos').addEventListener('change', onImportBoletos);
  document.getElementById('rf-file-crono').addEventListener('change', onImportCronograma);
  document.getElementById('rf-imp-mov').onclick = () => document.getElementById('rf-file-mov').click();
  document.getElementById('rf-file-mov').addEventListener('change', onImportMovimientos);
  document.getElementById('rf-refresh').onclick = rfRefreshPrices;
  document.getElementById('rf-add').onclick = () => openRfTradeForm();
  document.getElementById('rfv-go').onclick = registerRfSale;
  document.getElementById('rf-cat-add').onclick = () => openRfCatalogForm();
  document.getElementById('rf-cat-seed').onclick = seedRfCatalog;
  document.getElementById('rf-cat-estmin').onclick = estimateRfMin;
  document.getElementById('rf-cat-minimport').onclick = openRfMinImport;
  document.getElementById('rfs-search').addEventListener('input', () => { if (RF_SUG) renderRfSugResult(); });
  document.getElementById('rfs-clase').addEventListener('change', () => { if (RF_SUG) renderRfSugResult(); });
  document.getElementById('rfs-new').addEventListener('change', () => { if (RF_SUG) renderRfSugResult(); });
  document.getElementById('rfs-comprar').addEventListener('change', () => { if (RF_SUG) renderRfSugResult(); });
  document.getElementById('rfs-go').onclick = renderRfSug;
  document.getElementById('rfs-monto').addEventListener('change', renderRfSug);
  document.getElementById('btn-run').onclick = async function () {
    this.disabled = true; this.innerHTML = ic('loader') + ' Generando…';
    try {
      const r = await api('/report/run', { method: 'POST', body: JSON.stringify({ send: true }) });
      toast(r.emailResult.sent ? 'Reporte generado y enviado' : 'Reporte generado (mail: ' + r.emailResult.reason + ')');
      await loadReports(); if (CURRENT_SEC === 'reportes' || CURRENT_SEC === 'resumen') renderSection(CURRENT_SEC);
    } catch (e) { toast(e.message); }
    this.disabled = false; this.innerHTML = ic('refresh-cw') + ' Generar reporte ahora'; refreshIcons();
  };
  setupTableSort();
  setTopbarHeight();
  window.addEventListener('resize', setTopbarHeight);
}

// Fija --topbar-h para que los encabezados sticky se apoyen bajo la barra.
function setTopbarHeight() {
  const tb = document.querySelector('.topbar');
  if (tb) document.documentElement.style.setProperty('--topbar-h', tb.offsetHeight + 'px');
}

// ---------- Orden por columna (delegado, para todas las tablas) ----------
function cellNum(td) {
  if (!td) return null;
  const raw = (td.innerText || td.textContent || '').trim();
  if (!raw) return null;
  let s = raw.replace(/[^0-9,.\-]/g, '');
  if (s === '' || s === '-' || s === '.' || s === ',') return null;
  if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.'); // 1.234,56
  else if (s.includes(',')) s = s.replace(',', '.'); // 1234,56
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}
function setupTableSort() {
  document.body.addEventListener('click', (e) => {
    const th = e.target.closest('thead th');
    if (!th || !(th.innerText || th.textContent || '').trim()) return;
    const table = th.closest('table'); if (!table || !table.tBodies.length) return;
    const idx = [...th.parentElement.children].indexOf(th);
    const asc = th.getAttribute('data-sort') !== 'asc';
    [...th.parentElement.children].forEach(h => h.removeAttribute('data-sort'));
    th.setAttribute('data-sort', asc ? 'asc' : 'desc');
    const tbody = table.tBodies[0];
    const rows = [...tbody.rows].filter(r => r.cells.length > idx);
    rows.sort((ra, rb) => {
      const na = cellNum(ra.cells[idx]), nb = cellNum(rb.cells[idx]);
      let cmp;
      if (na != null && nb != null) cmp = na - nb;
      else if (na != null) cmp = 1;
      else if (nb != null) cmp = -1;
      else cmp = (ra.cells[idx]?.innerText || '').trim().localeCompare((rb.cells[idx]?.innerText || '').trim(), 'es', { numeric: true });
      return asc ? cmp : -cmp;
    });
    rows.forEach(r => tbody.appendChild(r));
  });
}

// ---------- Buscador rápido (Cmd/Ctrl + K) ----------
let CMDK_ITEMS = [], CMDK_SEL = 0;
function cmdkSections() {
  return Object.entries(SEC_TITLES).map(([sec, title]) => ({
    title, sub: 'Sección', icon: 'panel-left', run: () => showSection(sec),
  }));
}
function cmdkTickers() {
  const out = [], seen = new Set();
  const add = (tk, sub, sec) => {
    const k = tk + '|' + sec; if (!tk || seen.has(k)) return; seen.add(k);
    out.push({ title: tk, sub, icon: 'search', run: () => showSection(sec) });
  };
  (Array.isArray(CATALOG) ? CATALOG : []).forEach(c => add(c.ticker, 'Renta variable', 'cartera'));
  (Array.isArray(RF_CAT) ? RF_CAT : []).forEach(c => add(c.ticker, 'Renta fija', 'rentafija'));
  (Array.isArray(RF_DATA?.rows) ? RF_DATA.rows : []).forEach(r => add(r.ticker, 'Renta fija', 'rentafija'));
  return out;
}
function ensureCmdK() {
  if (document.getElementById('cmdk')) return;
  const el = document.createElement('div');
  el.id = 'cmdk'; el.className = 'cmdk hidden';
  el.innerHTML = `<div class="cmdk-box">
    <div class="cmdk-input">${ic('search')}<input id="cmdk-q" type="text" placeholder="Buscar sección o ticker…" autocomplete="off"></div>
    <div class="cmdk-list" id="cmdk-list"></div>
  </div>`;
  document.body.appendChild(el);
  el.addEventListener('click', (e) => { if (e.target === el) closeCmdK(); });
  document.getElementById('cmdk-q').addEventListener('input', renderCmdK);
  document.getElementById('cmdk-q').addEventListener('keydown', cmdkNav);
  refreshIcons();
}
function openCmdK() {
  ensureCmdK();
  document.getElementById('cmdk').classList.remove('hidden');
  const q = document.getElementById('cmdk-q'); q.value = ''; CMDK_SEL = 0;
  renderCmdK(); q.focus();
}
function closeCmdK() { const el = document.getElementById('cmdk'); if (el) el.classList.add('hidden'); }
function renderCmdK() {
  const q = (document.getElementById('cmdk-q').value || '').toLowerCase().trim();
  const all = [...cmdkSections(), ...cmdkTickers()];
  CMDK_ITEMS = (q ? all.filter(i => (i.title + ' ' + i.sub).toLowerCase().includes(q)) : all).slice(0, 40);
  if (CMDK_SEL >= CMDK_ITEMS.length) CMDK_SEL = 0;
  const list = document.getElementById('cmdk-list');
  if (!CMDK_ITEMS.length) { list.innerHTML = '<div class="cmdk-empty">Sin resultados</div>'; return; }
  list.innerHTML = CMDK_ITEMS.map((i, n) => `<div class="cmdk-item ${n === CMDK_SEL ? 'active' : ''}" data-n="${n}">
    <span class="ci-ic">${ic(i.icon)}</span><span>${esc(i.title)}</span><span class="ci-sub">${esc(i.sub)}</span></div>`).join('');
  list.querySelectorAll('.cmdk-item').forEach(it => {
    it.onclick = () => runCmdK(Number(it.dataset.n));
    it.onmousemove = () => { CMDK_SEL = Number(it.dataset.n); highlightCmdK(); };
  });
  refreshIcons();
}
function highlightCmdK() {
  document.querySelectorAll('.cmdk-item').forEach((it, n) => it.classList.toggle('active', n === CMDK_SEL));
}
function runCmdK(n) {
  const it = CMDK_ITEMS[n]; if (!it) return;
  closeCmdK(); it.run();
}
function cmdkNav(e) {
  if (e.key === 'ArrowDown') { e.preventDefault(); CMDK_SEL = Math.min(CMDK_SEL + 1, CMDK_ITEMS.length - 1); highlightCmdK(); scrollCmdK(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); CMDK_SEL = Math.max(CMDK_SEL - 1, 0); highlightCmdK(); scrollCmdK(); }
  else if (e.key === 'Enter') { e.preventDefault(); runCmdK(CMDK_SEL); }
  else if (e.key === 'Escape') { e.preventDefault(); closeCmdK(); }
}
function scrollCmdK() {
  const act = document.querySelector('.cmdk-item.active');
  if (act) act.scrollIntoView({ block: 'nearest' });
}
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    const el = document.getElementById('cmdk');
    if (el && !el.classList.contains('hidden')) closeCmdK(); else openCmdK();
  }
});

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

// Sección "Rendimientos": cartera total consolidada (variable + fija).
async function renderRendimientos() {
  const el = document.getElementById('rend-content');
  if (!el) return;
  el.innerHTML = skel(7);
  await loadRfCons();
  rfRenderConsolidado(el);
}

// Sección "Renta fija": detalle de ONs y bonos + su ABM.
async function renderRentaFija() {
  const el = document.getElementById('rf-content');
  if (!el) return;
  el.innerHTML = skel(7);
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
      <button class="btn primary" onclick="document.getElementById('rf-file-boletos').click()">${ic('upload')} Importar boletos</button>
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

  if (t.escalaRara > 0) {
    html += `<div style="margin:12px 0 0;padding:9px 12px;border:1px solid var(--red);border-radius:10px;color:var(--red);font-size:13px">
      ${ic('alert-triangle')} ${t.escalaRara} ${t.escalaRara === 1 ? 'precio con escala incorrecta' : 'precios con escala incorrecta'} (quedaron en pesos): se valúan al costo.
      <a href="#" id="rf-nudge-clear">Limpiar precios</a> y después <a href="#" id="rf-nudge-refresh2">Actualizar precios</a>.</div>`;
  }
  if (t.sinPrecio > 0) {
    html += `<div class="muted-sm" style="margin:12px 0 0;padding:9px 12px;border:1px dashed var(--line);border-radius:10px">
      ${ic('alert-triangle')} ${t.sinPrecio} ${t.sinPrecio === 1 ? 'posición valuada' : 'posiciones valuadas'} al costo (sin precio de mercado).
      <a href="#" id="rf-nudge-refresh">Actualizar precios</a> o cargalos a mano en la tabla.</div>`;
  }

  html += `<div class="panel-head" style="margin-top:16px"><h2 style="font-size:15px">Tenencias</h2></div>`;
  html += rfTable(
    ['Ticker', 'Nominales', 'Compra', 'Actual', 'Valor', 'Gan. capital', 'Renta cobr.'],
    (d.rows || []).map(r => [
      `${tb(r.ticker)} <span class="muted-sm">${esc(r.clase)}</span>`,
      `${nf(r.vn)}${r.amortizado > 0 ? ` <span class="muted-sm" title="VN original ${nf(r.vnOriginal)}, amortizado ${nf(r.amortizado)}">(amort.)</span>` : ''}`,
      r.precioCompra != null ? round2(r.precioCompra) : '—',
      r.precioActual != null
        ? `${round2(r.precioActual)} <span title="${r.precioSource === 'manual' ? 'precio manual' : 'precio automático'}">${ic(r.precioSource === 'manual' ? 'pencil' : 'signal')}</span> <a href="#" class="muted-sm rf-editpx" data-tk="${esc(r.ticker)}" data-px="${r.precioActual}">editar</a>`
        : `<a href="#" class="rf-editpx" data-tk="${esc(r.ticker)}" data-px="">cargar</a>`,
      r.valorActual != null ? money(r.valorActual) : '—',
      r.ganCapital != null ? `<span class="${cls(r.ganCapital)}">${money(r.ganCapital)}${r.ganCapitalPct != null ? ` <span class="muted-sm">${rfPct(r.ganCapitalPct)}</span>` : ''}</span>` : '—',
      r.rentaCobrada > 0 ? `<span class="pos">${money(r.rentaCobrada)}</span>` : '—',
    ]),
    [1, 0, 0, 0, 0, 0, 0]
  );
  el.innerHTML = html;

  el.querySelectorAll('.rf-editpx').forEach(a => a.onclick = (e) => {
    e.preventDefault(); rfSetPrice(a.dataset.tk, a.dataset.px);
  });
  const nudge = document.getElementById('rf-nudge-refresh');
  if (nudge) nudge.onclick = (e) => { e.preventDefault(); rfRefreshPrices(); };
  const nudge2 = document.getElementById('rf-nudge-refresh2');
  if (nudge2) nudge2.onclick = (e) => { e.preventDefault(); rfRefreshPrices(); };
  const nudgeC = document.getElementById('rf-nudge-clear');
  if (nudgeC) nudgeC.onclick = async (e) => {
    e.preventDefault();
    try { await api('/rf/prices/clear', { method: 'POST', body: '{}' }); toast('Precios limpiados'); RF_DATA = null; RF_CONS = null; renderSection(CURRENT_SEC); }
    catch (err) { toast(err.message); }
  };
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
      <div class="chart-wrap" style="height:200px"><canvas id="rf-cons-monthly"></canvas></div>`;
  }
  el.innerHTML = html;
  rfDonut('rf-chart-donut', c);
  if ((c.monthly || []).length) rfMonthlyChart('rf-cons-monthly', c.monthly);
}
function rfClassRow(color, label, v, peso) {
  return `<div style="display:flex;align-items:center;gap:8px">
    <span style="width:11px;height:11px;border-radius:3px;background:${color};flex-shrink:0"></span>
    <div style="flex:1"><div>${esc(label)}</div><div class="muted-sm">${money(v.valorActual)} · ${round2(peso)}%</div></div>
    <span class="${cls(v.ganancia)}">${money(v.ganancia)} · ${rfPct(v.rendimientoPct)}</span>
  </div>`;
}

// Usa el mismo markup/estilo que las tablas de renta variable (th, td.num)
// para que ambas clases se vean idénticas.
function rfTable(headers, rows, alignLeft) {
  const th = headers.map((h, i) => `<th class="${alignLeft[i] ? '' : 'num'}">${h}</th>`).join('');
  const tr = rows.length
    ? rows.map(r => '<tr>' + r.map((c, i) => `<td class="${alignLeft[i] ? '' : 'num'}">${c}</td>`).join('') + '</tr>').join('')
    : `<tr><td colspan="${headers.length}" class="empty" style="padding:14px">Sin datos.</td></tr>`;
  return `<table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;
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
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (x) => HIDE_MONEY ? '••••' : (CONFIG.currency || 'USD') + ' ' + Number(x.raw).toLocaleString('es-AR') } } },
      scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { callback: (v) => HIDE_MONEY ? '' : (v >= 1000 ? (v / 1000) + 'k' : v) } } },
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

// ---- Rendimientos RF (análisis) ----
let RF_GAIN_MODE = 'capital', RF_AN_ROWS = [], RF_GAIN_ANUAL = false;
// Alto de fila compartido por los dos gráficos de RF (Valor y Ganancia), así
// quedan alineados fila por fila (mismo orden, misma cantidad de especies).
function rfChartHeight(n) { return Math.max(260, n * 30) + 'px'; }
function drawRfGain() {
  const rows = RF_AN_ROWS; if (!rows.length) return;
  const cv = document.getElementById('rfa-gain'); if (!cv || typeof Chart === 'undefined') return;
  const anios = rows.map(r => Number(r.aniosTenido) > 0 ? Number(r.aniosTenido) : 1);
  // "Corta" = tenida hace menos de 1 año: anualizar la extrapolaría, así que en
  // modo Anual la marcamos (gris + *) y mostramos su acumulado.
  const short = rows.map(r => (Number(r.aniosTenido) || 99) < 1);
  const marked = (i) => RF_GAIN_ANUAL && short[i];
  const labels = rows.map((r, i) => marked(i) ? r.ticker + ' *' : r.ticker);
  let capPct = rows.map(r => round2(r.ganCapitalPct || 0));
  let rentaPct = rows.map(r => { const inv = (Number(r.precioCompra) || 0) * (Number(r.vn) || 0); return inv > 0 ? round2((Number(r.rentaCobrada) || 0) / inv * 100) : 0; });
  if (RF_GAIN_ANUAL) {
    capPct = capPct.map((v, i) => short[i] ? v : round2(v / anios[i]));
    rentaPct = rentaPct.map((v, i) => short[i] ? v : round2(v / anios[i]));
  }
  const suf = RF_GAIN_ANUAL ? '% anual' : '%';
  const note = document.getElementById('rfa-gain-note');
  if (note) {
    // Leyenda de colores FUERA del gráfico (si estuviera dentro, en modo "Ambas"
    // empujaría las barras hacia abajo y se desalinearían con el de la izquierda).
    const sq = (c) => `<span style="display:inline-block;width:9px;height:9px;background:${c};border-radius:2px;margin:0 4px -1px 0"></span>`;
    const leg = RF_GAIN_MODE === 'ambas' ? `<span style="margin-right:12px">${sq('#0a7d33')}Capital ${sq('#e0a800')}Renta</span>` : '';
    const corta = (RF_GAIN_ANUAL && short.some(Boolean)) ? '* tenidas hace menos de 1 año: se muestra el acumulado (anualizarlas lo distorsiona).' : '';
    note.innerHTML = leg + corta;
  }
  if (CHARTS['rfa-gain']) CHARTS['rfa-gain'].destroy();
  if (cv.parentElement) cv.parentElement.style.height = rfChartHeight(rows.length);
  const GREY = '#5f6c80', GREY2 = '#8a97a8';
  // Capital con el MISMO verde/rojo que renta variable; renta en dorado/ámbar
  // (va con "renta ganada"). El color no cambia entre modos y coincide con la leyenda.
  const capBar = (v, i) => marked(i) ? GREY : (v >= 0 ? '#0a7d33' : '#c0271a');
  const rentaBar = (i) => marked(i) ? GREY2 : '#e0a800';
  let datasets, stacked = false;
  if (RF_GAIN_MODE === 'renta') datasets = [{ data: rentaPct, backgroundColor: rentaPct.map((v, i) => rentaBar(i)), borderRadius: 4 }];
  else if (RF_GAIN_MODE === 'ambas') { stacked = true; datasets = [{ label: 'Capital', data: capPct, backgroundColor: capPct.map((v, i) => capBar(v, i)), borderRadius: 4 }, { label: 'Renta', data: rentaPct, backgroundColor: rentaPct.map((v, i) => rentaBar(i)), borderRadius: 4 }]; }
  else datasets = [{ data: capPct, backgroundColor: capPct.map((v, i) => capBar(v, i)), borderRadius: 4 }];
  CHARTS['rfa-gain'] = new Chart(cv, {
    type: 'bar', data: { labels, datasets },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (x) => (x.dataset.label ? x.dataset.label + ': ' : '') + x.raw + suf } } },
      scales: { x: { stacked, ticks: { callback: (v) => v + '%' } }, y: { stacked, ticks: { autoSkip: false, font: { size: 11 } } } },
    },
  });
}
async function renderRfAnalisis() {
  const el = document.getElementById('rf-analisis-content'); if (!el) return;
  el.innerHTML = skel(7);
  await loadRf();
  const d = RF_DATA || {}; const t = d.totals || {};
  const rows = (d.rows || []).filter(r => r.valorActual != null);
  if (!rows.length) { el.innerHTML = emptyCta('pie-chart', 'Todavía no hay datos de renta fija', 'Importá el export de boletos del broker para ver tus ONs y bonos.', { label: 'Ir a Cartera RF', icon: 'landmark', onclick: "showSection('rentafija')" }); return; }
  let html = rfKpiCards([
    { label: 'Capital aportado', value: money(t.capitalAportado) },
    { label: 'Valor actual', value: money(t.valorActual) },
    { label: 'Ganancia total', value: money(t.gananciaTotal), sub: rfPct(t.rendimientoPct), cls: cls(t.gananciaTotal) },
    { label: 'Renta cobrada', value: money(t.rentaCobrada), cls: t.rentaCobrada > 0 ? 'pos' : '' },
    { label: 'Posiciones', value: String(t.posiciones || rows.length) },
  ]);
  html += `<div class="grid2" style="margin-top:16px">
    <div class="panel" style="box-shadow:none;border:1px solid var(--line)"><div class="panel-head" style="min-height:40px"><h2 style="font-size:15px">Valor por especie</h2><span class="muted-sm">USD · % en el tooltip</span></div><div class="chart-wrap" style="height:240px"><canvas id="rfa-dist"></canvas></div></div>
    <div class="panel" style="box-shadow:none;border:1px solid var(--line)">
      <div class="panel-head" style="flex-wrap:nowrap;gap:6px;min-height:40px"><h2 style="font-size:15px">Ganancia (%)</h2>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <div class="seg">
            <button class="seg-btn ${RF_GAIN_MODE === 'capital' ? 'active' : ''}" data-rfgain="capital">Capital</button>
            <button class="seg-btn ${RF_GAIN_MODE === 'renta' ? 'active' : ''}" data-rfgain="renta">Renta</button>
            <button class="seg-btn ${RF_GAIN_MODE === 'ambas' ? 'active' : ''}" data-rfgain="ambas">Ambas</button>
          </div>
          <div class="seg">
            <button class="seg-btn ${!RF_GAIN_ANUAL ? 'active' : ''}" data-rfper="acum">Acum.</button>
            <button class="seg-btn ${RF_GAIN_ANUAL ? 'active' : ''}" data-rfper="anual">Anual</button>
          </div>
        </div>
      </div>
      <div class="chart-wrap" style="height:240px"><canvas id="rfa-gain"></canvas></div>
      <div class="muted-sm" id="rfa-gain-note" style="margin-top:4px"></div>
    </div>
  </div>`;
  const totVal = rows.reduce((a, r) => a + (r.valorActual || 0), 0);
  const byYear = d.byYear || [];
  if (byYear.length) {
    const totRenta = byYear.reduce((a, y) => a + (y.renta || 0), 0);
    const totAmort = byYear.reduce((a, y) => a + (y.amort || 0), 0);
    html += `<div class="panel-head" style="margin-top:16px"><h2 style="font-size:15px">Renta cobrada por año</h2><span class="muted-sm">cupones efectivamente cobrados (USD)</span></div>
      <div class="muted-sm" style="margin:-4px 0 8px">La ganancia total de arriba también incluye la valorización actual de mercado, que no se atribuye a un año puntual.</div>
      <div class="grid2">
        <div class="chart-wrap" style="height:230px"><canvas id="rfa-year"></canvas></div>
        <div>${rfTable(['Año', 'Renta', 'Amort.', 'Total'],
          byYear.map(y => [y.year, `<span class="pos">${money(y.renta)}</span>`, y.amort > 0 ? money(y.amort) : '—', money(y.total)])
            .concat([['Total', `<b class="pos">${money(totRenta)}</b>`, totAmort > 0 ? `<b>${money(totAmort)}</b>` : '—', `<b>${money(totRenta + totAmort)}</b>`]]),
          [1, 0, 0, 0])}</div>
      </div>`;
  }
  html += `<div class="panel-head" style="margin-top:16px"><h2 style="font-size:15px">Detalle por especie</h2></div>`;
  const diasAnios = (d, a) => d == null ? '—' : `${nf(d)} Días <span class="muted-sm">(${(Number(a) || 0).toFixed(2).replace('.', ',')} Años)</span>`;
  html += rfTable(['Ticker', 'Valor', 'Peso', 'Gan. capital', 'Renta cobrada', 'Tenencia', 'Al vto.'],
    [...rows].sort((a, b) => (b.valorActual || 0) - (a.valorActual || 0)).map(r => [
      tb(r.ticker),
      money(r.valorActual),
      totVal > 0 ? round2(r.valorActual / totVal * 100) + '%' : '—',
      r.ganCapital != null ? `<span class="${cls(r.ganCapital)}">${money(r.ganCapital)}${r.ganCapitalPct != null ? ' · ' + rfPct(r.ganCapitalPct) : ''}</span>` : '—',
      r.rentaCobrada > 0 ? `<span class="pos">${money(r.rentaCobrada)}</span>` : '—',
      diasAnios(r.diasTenido, r.aniosTenido),
      diasAnios(r.diasVto, r.aniosVto),
    ]), [1, 0, 0, 0, 0, 0, 0]);
  html += `<div class="panel-head" style="margin-top:16px"><h2 style="font-size:15px">Evolución de precio</h2>
    <select id="rfa-evo-ticker" style="width:auto"></select></div>
    <div class="muted-sm" style="margin:-4px 0 6px">Se arma con el snapshot diario de data912 (USD por nominal).</div>
    <div class="chart-wrap" style="height:220px"><canvas id="rfa-evo"></canvas></div>`;
  el.innerHTML = html;
  // Mismo orden (por valor, de mayor a menor) para los dos gráficos alineados.
  const rowsOrdenadas = [...rows].sort((a, b) => (b.valorActual || 0) - (a.valorActual || 0));
  rfBarValor('rfa-dist', rowsOrdenadas);
  if (byYear.length) rfBarYear('rfa-year', byYear);
  RF_AN_ROWS = rowsOrdenadas;
  drawRfGain();
  el.querySelectorAll('.seg-btn[data-rfgain]').forEach(b => b.onclick = () => {
    el.querySelectorAll('.seg-btn[data-rfgain]').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    RF_GAIN_MODE = b.dataset.rfgain; drawRfGain();
  });
  el.querySelectorAll('.seg-btn[data-rfper]').forEach(b => b.onclick = () => {
    el.querySelectorAll('.seg-btn[data-rfper]').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    RF_GAIN_ANUAL = b.dataset.rfper === 'anual'; drawRfGain();
  });
  const evoSel = document.getElementById('rfa-evo-ticker');
  if (evoSel) {
    evoSel.innerHTML = labels.map(t => `<option>${t}</option>`).join('');
    evoSel.onchange = () => drawRfEvo(evoSel.value);
    if (labels.length) drawRfEvo(labels[0]);
  }
}
async function drawRfEvo(ticker) {
  let hist = [];
  try { hist = await api('/rf/price-history?ticker=' + encodeURIComponent(ticker)); } catch { hist = []; }
  const cv = document.getElementById('rfa-evo'); if (!cv || typeof Chart === 'undefined') return;
  if (CHARTS['rfa-evo']) CHARTS['rfa-evo'].destroy();
  if (!hist.length) {
    const ctx = cv.getContext('2d'); ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = '#8a97a8'; ctx.font = '13px sans-serif'; ctx.fillText('Sin histórico todavía (se completa con el snapshot diario)', 10, 24);
    return;
  }
  CHARTS['rfa-evo'] = new Chart(cv, {
    type: 'line',
    data: { labels: hist.map(h => fmtDate(h.fecha)), datasets: [{ data: hist.map(h => h.price), borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,.12)', fill: true, tension: 0.2, pointRadius: 0 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (x) => ticker + ': ' + x.raw } } }, scales: { x: { grid: { display: false } }, y: { beginAtZero: false } } },
  });
}
function rfBarValor(id, rows) {
  const cv = document.getElementById(id); if (!cv || typeof Chart === 'undefined') return;
  if (CHARTS[id]) CHARTS[id].destroy();
  const sorted = [...rows].sort((a, b) => (b.valorActual || 0) - (a.valorActual || 0));
  const tot = sorted.reduce((a, r) => a + (r.valorActual || 0), 0);
  const labels = sorted.map(r => r.ticker);
  const data = sorted.map(r => round2(r.valorActual || 0));
  if (cv.parentElement) cv.parentElement.style.height = rfChartHeight(sorted.length);
  CHARTS[id] = new Chart(cv, {
    type: 'bar',
    data: { labels, datasets: [{ data, backgroundColor: '#3b82f6', borderRadius: 4 }] },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (x) => `${(CONFIG.currency || 'USD')} ${Number(x.raw).toLocaleString('es-AR')} · ${tot > 0 ? round2(x.raw / tot * 100) : 0}%` } } },
      scales: { x: { beginAtZero: true, ticks: { callback: (v) => v >= 1000 ? (v / 1000) + 'k' : v } }, y: { ticks: { autoSkip: false, font: { size: 11 } } } },
    },
  });
}
function rfBarYear(id, byYear) {
  const cv = document.getElementById(id); if (!cv || typeof Chart === 'undefined') return;
  if (CHARTS[id]) CHARTS[id].destroy();
  const labels = byYear.map(y => y.year);
  const data = byYear.map(y => round2(y.renta || 0));
  CHARTS[id] = new Chart(cv, {
    type: 'bar',
    data: { labels, datasets: [{ data, backgroundColor: '#34d399', borderRadius: 4 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (x) => `${(CONFIG.currency || 'USD')} ${Number(x.raw).toLocaleString('es-AR')}` } } },
      scales: { y: { beginAtZero: true, ticks: { callback: (v) => v >= 1000 ? (v / 1000) + 'k' : v } }, x: { grid: { display: false } } },
    },
  });
}
function rfDoughnutBy(id, labels, data) {
  const cv = document.getElementById(id); if (!cv || typeof Chart === 'undefined') return;
  if (CHARTS[id]) CHARTS[id].destroy();
  CHARTS[id] = new Chart(cv, {
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: palette(labels.length), borderWidth: 0 }] },
    options: { responsive: true, maintainAspectRatio: false, cutout: '58%', plugins: { legend: { position: 'right', labels: { boxWidth: 10, font: { size: 11 } } }, tooltip: { callbacks: { label: (x) => `${x.label}: ${x.raw}%` } } } },
  });
}
function rfBarSigned(id, labels, data) {
  const cv = document.getElementById(id); if (!cv || typeof Chart === 'undefined') return;
  if (CHARTS[id]) CHARTS[id].destroy();
  CHARTS[id] = new Chart(cv, {
    type: 'bar',
    data: { labels, datasets: [{ data, backgroundColor: data.map(v => v >= 0 ? '#34d399' : '#f87171'), borderRadius: 4 }] },
    options: { responsive: true, maintainAspectRatio: false, indexAxis: 'y', plugins: { legend: { display: false }, tooltip: { callbacks: { label: (x) => `${x.raw}%` } } }, scales: { x: { ticks: { callback: (v) => v + '%' } } } },
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
    RF_DATA = null; RF_CONS = null; renderSection(CURRENT_SEC);
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
    RF_DATA = null; RF_CONS = null; renderSection(CURRENT_SEC);
  } catch (err) { toast('Error al importar cronograma: ' + err.message); }
}

async function onImportMovimientos(e) {
  const file = e.target.files[0]; e.target.value = ''; if (!file) return;
  if (typeof XLSX === 'undefined') return toast('No se pudo cargar el lector de Excel');
  toast('Leyendo movimientos…');
  try {
    const raw = await readSheet(file);
    const rows = raw.map(r => ({
      descripcion: col(r, 'Descripcion', 'Descripción'), ticker: col(r, 'Ticker'),
      moneda: col(r, 'Moneda'), importe: col(r, 'Importe'),
      fecha: toYmd(col(r, 'Concertacion', 'Liquidacion', 'Fecha')),
    })).filter(r => r.descripcion);
    if (!rows.length) return toast('No se detectaron movimientos');
    const res = await api('/rf/import-movimientos', { method: 'POST', body: JSON.stringify({ rows }) });
    toast(res.nuevos ? `Renta: ${res.nuevos} eventos nuevos (sin duplicar) · total ${money(res.rentaCobrada)}` : `Sin eventos nuevos · total ${money(res.rentaCobrada)}`);
    RF_DATA = null; RF_CONS = null; renderSection(CURRENT_SEC);
  } catch (err) { toast('Error al importar movimientos: ' + err.message); }
}

async function rfRefreshPrices() {
  const b = document.getElementById('rf-refresh'); const o = b.textContent; b.disabled = true; b.textContent = 'Actualizando…';
  try {
    const r = await api('/rf/refresh-prices', { method: 'POST', body: '{}' });
    const mepTxt = r.mep ? ` · MEP ${Number(r.mep).toLocaleString('es-AR')}${r.mepSource ? ' (' + r.mepSource + ')' : ''}` : '';
    toast(r.updated ? `Precios actualizados: ${r.updated}${mepTxt}` : ('Sin precios nuevos' + (r.error ? ` — ${r.error}` : '')));
    RF_DATA = null; RF_CONS = null; renderSection(CURRENT_SEC);
  } catch (e) { toast(e.message); }
  b.disabled = false; b.textContent = o;
}
async function rfSetPrice(ticker, cur) {
  const v = prompt(`Precio actual de ${ticker} (USD por 1 nominal, ej. 1,09):`, cur || '');
  if (v == null) return;
  const price = Number(String(v).replace(',', '.'));
  if (!(price > 0)) return toast('Precio inválido');
  try { await api('/rf/price', { method: 'POST', body: JSON.stringify({ ticker, price }) }); toast('Precio guardado'); RF_DATA = null; RF_CONS = null; renderSection(CURRENT_SEC); }
  catch (e) { toast(e.message); }
}
function openRfTradeForm(t) {
  const edit = t && t.id;
  const sel = (v, opt) => v === opt ? ' selected' : '';
  const v = (k, d = '') => edit && t[k] != null && t[k] !== '' ? t[k] : d;
  document.getElementById('modal-title').textContent = edit ? 'Editar movimiento' : 'Agregar compra / venta de ON o bono';
  document.getElementById('modal-body').innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <label>Ticker<input id="rf-t-ticker" placeholder="YM34O" value="${esc(v('ticker'))}"></label>
      <label>Operación<select id="rf-t-side"><option value="COMPRA"${sel(v('side', 'COMPRA'), 'COMPRA')}>Compra</option><option value="VENTA"${sel(v('side'), 'VENTA')}>Venta</option></select></label>
      <label>Tipo<select id="rf-t-clase"><option value="ON"${sel(v('clase', 'ON'), 'ON')}>ON</option><option value="Bono"${sel(v('clase'), 'Bono')}>Bono</option></select></label>
      <label>Nominales (VN)<input id="rf-t-cant" type="number" step="any" placeholder="1000" value="${esc(v('cantidad'))}"></label>
      <label>Precio<input id="rf-t-precio" type="number" step="any" placeholder="1.09" value="${esc(v('precio'))}"></label>
      <label>Moneda<select id="rf-t-moneda"><option${sel(v('moneda', 'Dólares'), 'Dólares')}>Dólares</option><option${sel(v('moneda'), 'Pesos')}>Pesos</option></select></label>
      <label>Fecha<input id="rf-t-fecha" type="date" value="${esc(v('fecha'))}"></label>
      <label>Emisor (opcional)<input id="rf-t-emisor" placeholder="YPF" value="${esc(v('emisor'))}"></label>
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
    try {
      if (edit) await api('/rf/trade/' + t.id, { method: 'PUT', body: JSON.stringify(body) });
      else await api('/rf/trade', { method: 'POST', body: JSON.stringify(body) });
      closeModal(); toast(edit ? 'Movimiento actualizado' : 'Movimiento agregado');
      RF_DATA = null; RF_CONS = null; renderSection(CURRENT_SEC);
    } catch (e) { toast(e.message); }
  };
  modal.classList.remove('hidden');
}

// ---- Movimientos (boletos: compras/ventas) ----
let RF_TRADES = [];
async function loadRfTrades() { try { RF_TRADES = await api('/rf/trades'); } catch { RF_TRADES = []; } }
function rfSetupHidden() { return localStorage.getItem('rf_setup_hidden') === '1'; }
function applyRfSetupVisibility() {
  const panel = document.getElementById('rf-setup-panel'), show = document.getElementById('rf-setup-show');
  if (!panel) return;
  const hidden = rfSetupHidden();
  panel.style.display = hidden ? 'none' : '';
  if (show) show.style.display = hidden ? '' : 'none';
}
async function renderRfMovimientos() {
  const el = document.getElementById('rf-mov-content'); if (!el) return;
  el.innerHTML = skel(7);
  await loadRfTrades();
  const rows = [...RF_TRADES].sort((a, b) => String(b.fecha || '').localeCompare(String(a.fecha || '')));
  const compras = rows.filter(t => t.side !== 'VENTA').length, ventas = rows.length - compras;
  el.innerHTML = `<div class="muted-sm" style="margin-bottom:8px">${compras} compras · ${ventas} ventas</div>` + rfTable(
    ['Ticker', 'Fecha', 'Op', 'Nominales', 'Precio', ''],
    rows.map(t => [
      `${tb(t.ticker)} <span class="muted-sm">${esc(t.clase)}${t.moneda ? ' · ' + esc(t.moneda) : ''} · ${t.source === 'manual' ? 'manual' : 'boleto'}</span>`,
      fmtDate(t.fecha),
      `<span class="${t.side === 'VENTA' ? 'neg' : 'pos'}">${t.side === 'VENTA' ? 'Venta' : 'Compra'}</span>`,
      nf(t.cantidad), t.precio != null ? round2(t.precio) : '—',
      `<button title="Editar" onclick='openRfTradeForm(${JSON.stringify({ id: t.id, ticker: t.ticker, side: t.side, clase: t.clase, cantidad: Number(t.cantidad), precio: t.precio != null ? Number(t.precio) : '', moneda: t.moneda || '', emisor: t.emisor || '', fecha: t.fecha ? String(t.fecha).slice(0, 10) : '' }).replace(/'/g, '&#39;')})'>${ic('pencil')}</button><button class="rf-deltrade" title="Borrar" data-id="${t.id}">${ic('trash-2')}</button>`,
    ]),
    [1, 0, 0, 0, 0, 0]
  );
  el.querySelectorAll('.rf-deltrade').forEach(a => a.onclick = async (e) => {
    e.preventDefault();
    if (!confirm('¿Borrar este movimiento?')) return;
    try { await api('/rf/trade/' + a.dataset.id, { method: 'DELETE' }); toast('Movimiento borrado'); RF_DATA = null; RF_CONS = null; renderRfMovimientos(); }
    catch (err) { toast(err.message); }
  });
}

// ---- Ventas de renta fija ----
async function renderRfVentas() {
  await loadRf();
  const sel = document.getElementById('rfv-ticker');
  if (sel) sel.innerHTML = (RF_DATA.rows || []).length
    ? (RF_DATA.rows || []).map(r => `<option value="${esc(r.ticker)}">${esc(r.ticker)} · ${nf(r.vn)} VN</option>`).join('')
    : '<option value="">(sin posiciones)</option>';
  await loadRfTrades();
  const ventas = RF_TRADES.filter(t => t.side === 'VENTA').sort((a, b) => String(b.fecha || '').localeCompare(String(a.fecha || '')));
  const el = document.getElementById('rf-ventas-content'); if (!el) return;
  el.innerHTML = `<div class="panel-head" style="margin-top:6px"><h2 style="font-size:15px">Historial de ventas</h2></div>` +
    rfTable(['Ticker', 'Fecha', 'Nominales', 'Precio', 'Moneda', ''],
      ventas.map(t => [tb(t.ticker), fmtDate(t.fecha), nf(t.cantidad), t.precio != null ? round2(t.precio) : '—', esc(t.moneda || ''), `<button class="rf-deltrade" title="Borrar" data-id="${t.id}">${ic('trash-2')}</button>`]),
      [1, 0, 0, 0, 1, 0]);
  el.querySelectorAll('.rf-deltrade').forEach(a => a.onclick = async (e) => {
    e.preventDefault();
    if (!confirm('¿Borrar esta venta?')) return;
    try { await api('/rf/trade/' + a.dataset.id, { method: 'DELETE' }); toast('Venta borrada'); RF_DATA = null; RF_CONS = null; renderRfVentas(); }
    catch (err) { toast(err.message); }
  });
}
async function registerRfSale() {
  const ticker = document.getElementById('rfv-ticker').value;
  const qty = document.getElementById('rfv-qty').value;
  const price = document.getElementById('rfv-price').value;
  const date = document.getElementById('rfv-date').value;
  if (!ticker || !(Number(qty) > 0)) return toast('Elegí especie y nominales');
  const clase = (RF_DATA?.rows || []).find(r => r.ticker === ticker)?.clase || 'ON';
  try {
    await api('/rf/trade', { method: 'POST', body: JSON.stringify({ ticker, side: 'VENTA', clase, cantidad: qty, precio: price, moneda: 'Dólares', fecha: date }) });
    toast('Venta registrada'); RF_DATA = null; RF_CONS = null;
    document.getElementById('rfv-qty').value = ''; document.getElementById('rfv-price').value = '';
    renderRfVentas();
  } catch (e) { toast(e.message); }
}

// ---- Cronograma (cupones) ----
async function renderRfCronograma() {
  const el = document.getElementById('rf-crono-content'); if (!el) return;
  el.innerHTML = skel(7);
  await loadRf();
  let payments = []; try { payments = await api('/rf/payments'); } catch { payments = []; }
  const today = new Date().toISOString().slice(0, 10);
  const d = RF_DATA || {};
  const rc = d.totals?.rentaCobrada || 0;
  const rcBlock = `<div class="cards" style="margin-bottom:14px">
      <div class="card"><div class="card-label">Renta ya cobrada</div><div class="card-value ${rc > 0 ? 'pos' : ''}">${money(rc)}</div>
      <div class="muted-sm">de <a href="#" onclick="document.getElementById('rf-file-mov').click();return false">Importar movimientos</a></div></div></div>`;
  let html = rcBlock;
  if (!payments.length) {
    html += `<div style="text-align:center;padding:24px 12px;border:1px dashed var(--line);border-radius:12px">
      <div style="margin-bottom:6px">Todavía no cargaste el cronograma futuro</div>
      <div class="muted-sm" style="margin-bottom:12px">Subí el DetallePagos del broker para ver los próximos cupones y amortizaciones.</div>
      <button class="btn primary" onclick="document.getElementById('rf-file-crono').click()">${ic('calendar-days')} Importar cronograma</button></div>`;
    el.innerHTML = html; return;
  }
  const mm = d.monthly || [];
  const sumRenta = mm.reduce((a, x) => a + (Number(x.renta) || 0), 0);
  const sumAmort = mm.reduce((a, x) => a + (Number(x.amort) || 0), 0);
  html += `<div class="cards" style="margin-bottom:14px">
      <div class="card"><div class="card-label">Renta promedio mensual</div><div class="card-value">${money(sumRenta / 12)}</div><div class="muted-sm">próximos 12 meses</div></div>
      <div class="card"><div class="card-label">Renta acumulada (12 meses)</div><div class="card-value pos">${money(sumRenta)}</div>${sumAmort > 0 ? `<div class="muted-sm">+ amortizaciones ${money(sumAmort)}</div>` : ''}</div>
    </div>`;
  if (mm.length) {
    html += `<div class="panel-head"><h2 style="font-size:15px">Renta a cobrar por mes</h2></div>
      <div class="muted-sm" style="margin:-4px 0 6px">Cupones y amortizaciones proyectados (${CONFIG.currency || 'USD'})</div>
      <div class="chart-wrap" style="height:200px"><canvas id="rf-crono-monthly"></canvas></div>`;
  }
  const fut = payments.filter(p => String(p.fecha) >= today).sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));
  html += `<div class="panel-head" style="margin-top:14px"><h2 style="font-size:15px">Próximos pagos</h2><span class="muted-sm">${fut.length} pagos</span></div>`;
  html += rfTable(['Fecha', 'Ticker', 'Renta', 'Amortización', 'Total'],
    fut.map(p => [fmtDate(p.fecha), tb(p.ticker), money(p.renta), p.amortizacion > 0 ? money(p.amortizacion) : '—', money(p.total)]),
    [0, 1, 0, 0, 0]);
  el.innerHTML = html;
  if ((d.monthly || []).length) rfMonthlyChart('rf-crono-monthly', d.monthly);
}

// ---- Catálogo de renta fija ----
let RF_CAT = [];
async function renderRfCatalogo() {
  const el = document.getElementById('rf-cat-content'); if (!el) return;
  el.innerHTML = skel(7);
  try { RF_CAT = await api('/rf/catalog'); } catch { RF_CAT = []; }
  if (!RF_CAT.length) { el.innerHTML = emptyCta('bookmark', 'Catálogo vacío', 'Cargá ONs y bonos candidatos para cruzarlos con tu guía y las sugerencias.', { label: 'Agregar', icon: 'plus', onclick: "document.getElementById('rf-cat-add').click()" }); return; }
  el.innerHTML = `<table><thead><tr>
      <th>Ticker</th><th class="hide-sm">Emisor</th><th>Clase</th><th class="num">Rating</th><th class="num">Mín. nom.</th><th class="num hide-sm">Precio</th><th class="num"></th>
    </tr></thead><tbody>${RF_CAT.map(c => `
      <tr>
        <td>${tb(c.ticker)}</td>
        <td class="hide-sm muted-sm">${esc(c.emisor || '')}</td>
        <td>${esc(c.clase || '')}</td>
        <td class="num">${esc(c.rating || '—')}</td>
        <td class="num">${c.min_nominales ? nf(c.min_nominales) : '—'}</td>
        <td class="num hide-sm">${c.price != null ? round2(c.price) : '—'}</td>
        <td class="num row-actions"><button title="Editar" onclick='openRfCatalogForm(${JSON.stringify(c).replace(/'/g, "&#39;")})'>${ic('pencil')}</button><button title="Borrar" onclick="delRfCatalog(${c.id})">${ic('trash-2')}</button></td>
      </tr>`).join('')}</tbody></table>`;
}
function openRfCatalogForm(c) {
  const edit = c && c.id;
  const sel = (v, o) => v === o ? ' selected' : '';
  const v = (k, d = '') => edit && c[k] != null && c[k] !== '' ? c[k] : d;
  document.getElementById('modal-title').textContent = edit ? 'Editar especie del catálogo' : 'Agregar al catálogo';
  document.getElementById('modal-body').innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <label>Ticker<input id="rc-ticker" placeholder="YM34O" value="${esc(v('ticker'))}"></label>
      <label>Emisor<input id="rc-emisor" placeholder="YPF" value="${esc(v('emisor'))}"></label>
      <label>Clase<select id="rc-clase"><option${sel(v('clase', 'ON'), 'ON')}>ON</option><option${sel(v('clase'), 'Bono')}>Bono</option></select></label>
      <label>Moneda<select id="rc-moneda"><option${sel(v('moneda', 'USD'), 'USD')}>USD</option><option${sel(v('moneda'), 'Pesos')}>Pesos</option></select></label>
      <label>Rating<input id="rc-rating" placeholder="A / BBB…" value="${esc(v('rating'))}"></label>
      <label>Mínimo de nominales<input id="rc-min" type="number" step="any" placeholder="1000" value="${esc(v('min_nominales'))}"></label>
      <label style="grid-column:1/3">Notas<input id="rc-notes" value="${esc(v('notes'))}"></label>
    </div>`;
  document.getElementById('modal-save').onclick = async () => {
    const body = {
      ticker: document.getElementById('rc-ticker').value, emisor: document.getElementById('rc-emisor').value,
      clase: document.getElementById('rc-clase').value, moneda: document.getElementById('rc-moneda').value,
      rating: document.getElementById('rc-rating').value, min_nominales: document.getElementById('rc-min').value,
      notes: document.getElementById('rc-notes').value,
    };
    if (!body.ticker) return toast('El ticker es obligatorio');
    try {
      if (edit) await api('/rf/catalog/' + c.id, { method: 'PUT', body: JSON.stringify(body) });
      else await api('/rf/catalog', { method: 'POST', body: JSON.stringify(body) });
      closeModal(); toast('Guardado'); renderRfCatalogo();
    } catch (e) { toast(e.message); }
  };
  modal.classList.remove('hidden');
}
async function delRfCatalog(id) {
  if (!confirm('¿Borrar del catálogo?')) return;
  try { await api('/rf/catalog/' + id, { method: 'DELETE' }); toast('Borrado'); renderRfCatalogo(); }
  catch (e) { toast(e.message); }
}
async function seedRfCatalog() {
  try { const r = await api('/rf/catalog/seed-held', { method: 'POST', body: '{}' }); toast(`Agregadas ${r.added} al catálogo`); renderRfCatalogo(); }
  catch (e) { toast(e.message); }
}
async function estimateRfMin() {
  try { const r = await api('/rf/catalog/estimate-min', { method: 'POST', body: '{}' }); toast(r.updated ? `Mínimos estimados: ${r.updated} (editables)` : 'Nada para estimar (ya cargados o sin boletos)'); renderRfCatalogo(); }
  catch (e) { toast(e.message); }
}
function parseMinList(text) {
  const rows = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const m = raw.trim().match(/^([A-Za-z0-9]{2,10})\D+([\d.]+)/);
    if (m) rows.push({ ticker: m[1].toUpperCase(), min: Number(String(m[2]).replace(/\./g, '')) });
  }
  return rows;
}
function openRfMinImport() {
  document.getElementById('modal-title').textContent = 'Cargar mínimos (pegar)';
  document.getElementById('modal-body').innerHTML = `
    <p class="muted-sm" style="margin:0 0 8px">Pegá una línea por especie: <b>ticker y mínimo</b> (ej. <code>YM34O 100</code>). Crea la especie si no está y no toca los demás campos.</p>
    <textarea id="rf-min-text" rows="9" placeholder="YM34O 100&#10;SFD34 1000&#10;DNC5O 1000"></textarea>
    <div id="rf-min-prev" class="muted-sm" style="margin-top:6px"></div>`;
  const ta = document.getElementById('rf-min-text'), prev = document.getElementById('rf-min-prev');
  ta.addEventListener('input', () => { const r = parseMinList(ta.value); prev.textContent = r.length ? `${r.length} detectadas` : ''; });
  document.getElementById('modal-save').onclick = async () => {
    const rows = parseMinList(ta.value);
    if (!rows.length) return toast('No se detectaron líneas válidas');
    try { const r = await api('/rf/catalog/min-bulk', { method: 'POST', body: JSON.stringify({ rows }) }); closeModal(); toast(`Mínimos cargados: ${r.updated}`); renderRfCatalogo(); }
    catch (e) { toast(e.message); }
  };
  modal.classList.remove('hidden');
}

// ---- Sugerencias RF (reforzar meses flojos) ----
let RF_SUG = null;
const mesLabel = (ym) => { const [y, mm] = ym.split('-'); return ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'][+mm - 1] + ' ' + y.slice(2); };
const chip = (txt, color, title) => `<span class="chip-ic"${title ? ` title="${title}"` : ''} style="font-size:11px;padding:1px 6px;border-radius:6px;border:1px solid var(--line);color:${color};white-space:nowrap;display:inline-flex;align-items:center;gap:3px">${txt}</span>`;
const senalBadge = (s) => !s ? chip(ic('alert-triangle') + ' fuera', 'var(--red)', 'No figura en tu guía')
  : s === 'Comprar' ? chip('Comprar', '#34d399')
    : s === 'Vender' ? chip('Vender', '#f87171')
      : chip('Mantener', 'var(--amber,#e0a800)');
const perfilChip = (p) => !p ? '' : chip(`${ic(p === 'Conservador' ? 'shield' : p === 'Agresivo' ? 'rocket' : 'scale')} ${p}`, p === 'Conservador' ? '#34d399' : p === 'Agresivo' ? '#f87171' : 'var(--amber,#e0a800)', `Perfil ${p}`);
const liqBadge = (l) => !l ? '—' : chip(l, l === 'Alta' ? '#34d399' : l === 'Media' ? 'var(--amber,#e0a800)' : '#f87171', 'Liquidez ' + l);
async function renderRfSug() {
  const el = document.getElementById('rf-sug-content'); if (!el) return;
  el.innerHTML = skel(7);
  const monto = Number(document.getElementById('rfs-monto').value) || 0;
  try { RF_SUG = await api('/rf/suggest' + (monto ? ('?monto=' + monto) : '')); } catch { RF_SUG = null; }
  renderRfSugResult();
}
function renderRfSugResult() {
  const el = document.getElementById('rf-sug-content'); if (!el) return;
  const s = RF_SUG;
  if (!s || !s.monthly || !s.monthly.length) { el.innerHTML = '<div class="empty">Cargá el cronograma (DetallePagos) para calcular sugerencias.</div>'; return; }
  const q = (document.getElementById('rfs-search').value || '').toLowerCase().trim();
  const clase = document.getElementById('rfs-clase').value;
  const onlyNew = document.getElementById('rfs-new').checked;
  const onlyComprar = document.getElementById('rfs-comprar').checked;
  const monto = Number(document.getElementById('rfs-monto').value) || 0;

  let html = '';
  html += `<div class="muted-sm" style="margin-bottom:6px">${s.guideCount ? `Guía: ${s.guideCount} recomendaciones cruzadas` : (s.guideError ? `${ic('alert-triangle')} Guía no disponible (${s.guideError})` : 'Guía no cargada')}</div>`;
  if ((s.alertasVender || []).length) html += `<div style="margin-bottom:10px;padding:9px 12px;border:1px solid var(--red);border-radius:10px;color:var(--red);font-size:13px">${ic('alert-triangle')} Tu guía marca <b>Vender</b> algo que tenés: ${s.alertasVender.map(a => a.ticker).join(', ')}. Revisá si conviene salir.</div>`;
  if ((s.fueraGuia || []).length) html += `<div class="muted-sm" style="margin-bottom:10px">Tenés fuera de la guía: ${s.fueraGuia.join(', ')}</div>`;

  // --- Principal: las "Comprar" de tu guía ---
  let comprar = (s.comprar || []);
  if (clase) comprar = comprar.filter(x => !x.clase || x.clase === clase);
  if (onlyNew) comprar = comprar.filter(x => !x.held);
  if (q) comprar = comprar.filter(x => x.ticker.toLowerCase().includes(q) || String(x.emisor).toLowerCase().includes(q));
  html += `<div class="panel-head" style="margin-top:4px"><h2 style="font-size:15px">Para comprar (según tu guía)</h2><span class="muted-sm">${comprar.length}</span></div>`;
  if (!s.guideCount) html += `<div class="muted-sm" style="margin-bottom:10px">Compartí tu guía (link público) para ver las recomendadas a comprar.</div>`;
  else if (!comprar.length) html += `<div class="muted-sm" style="margin-bottom:10px">Ninguna "Comprar" con esos filtros.</div>`;
  else html += rfTable(['Ticker', 'Rating', 'TIR', 'Liquidez', 'Mín. nom.', monto > 0 ? 'Nominales' : 'Estado', 'Paga en'],
    comprar.map(x => {
      const estado = x.held ? '<span class="pos">la tenés</span>' : '<span class="muted-sm">nueva</span>';
      const nomCell = x.nominales != null ? `${nf(x.nominales)}${x.alcanzaMinimo === false ? ' <span class="neg">(&lt; mín)</span>' : ''}` : (x.precio == null ? '<span class="muted-sm">sin precio</span>' : '—');
      const MES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
      const lowMM = new Set((x.llenaMesFlojo || []).map(ym => ym.slice(5, 7)));
      const paga = (x.mesesPago && x.mesesPago.length)
        ? x.mesesPago.map(mm => lowMM.has(mm) ? `<span class="pos">${MES[+mm - 1]}</span>` : MES[+mm - 1]).join(', ')
        : '<span class="muted-sm">sin cronograma</span>';
      return [`${tb(x.ticker)} ${perfilChip(x.perfil)} ${senalBadge(x.senal)} <span class="muted-sm">${esc(x.emisor || '')}${x.held ? '' : ' · nueva'}</span>`, esc(x.rating || '—'), x.tir != null ? rfPct(x.tir) : (x.tirNota ? `<span class="neg" title="${esc(x.tirNota)}">${ic('alert-triangle')}</span>` : '—'), liqBadge(x.liquidez), x.minNominales ? nf(x.minNominales) : '—', monto > 0 ? nomCell : estado, paga];
    }), [1, 0, 0, 0, 0, 0, 1]);

  // --- Secundario: emparejar renta por mes ---
  html += `<div class="panel-head" style="margin-top:18px"><h2 style="font-size:15px">Emparejar tu renta por mes</h2><span class="muted-sm">opcional</span></div>
    <div class="muted-sm" style="margin:-2px 0 6px">Renta promedio mensual: <b>${money(s.avg)}</b> · valle si es menor a ${money(s.umbral)} (en rojo)</div>
    <div class="chart-wrap" style="height:200px"><canvas id="rf-sug-monthly"></canvas></div>`;

  if (!s.suggestions.length) {
    html += '<div class="muted-sm" style="margin-top:10px">Tu renta está pareja: no hay meses por debajo del umbral.</div>';
    el.innerHTML = html; drawSugMonthly(s); return;
  }
  const cols = ['Ticker', 'Rating', 'Mín. nom.', monto > 0 ? 'Nominales' : 'Estado'];
  const align = [1, 0, 0, 0];
  html += '<div style="margin-top:14px;display:flex;flex-direction:column;gap:12px">';
  for (const m of s.suggestions) {
    let cands = m.candidatos;
    if (clase) cands = cands.filter(c => c.clase === clase);
    if (onlyNew) cands = cands.filter(c => !c.held);
    if (onlyComprar) cands = cands.filter(c => c.senal === 'Comprar');
    if (q) cands = cands.filter(c => c.ticker.toLowerCase().includes(q) || String(c.emisor).toLowerCase().includes(q));
    html += `<div class="panel" style="box-shadow:none;border:1px solid var(--line);padding:12px">
      <div style="display:flex;justify-content:space-between;margin-bottom:8px"><b>${mesLabel(m.ym)}</b><span class="muted-sm">cobrás ${money(m.total)}</span></div>`;
    html += cands.length
      ? rfTable(cols, cands.map(c => {
        const estado = c.held ? '<span class="pos">la tenés</span>' : '<span class="muted-sm">nueva</span>';
        const nomCell = c.nominales != null
          ? `${nf(c.nominales)}${c.alcanzaMinimo === false ? ' <span class="neg">(&lt; mín)</span>' : ''}`
          : (c.precio == null ? '<span class="muted-sm">sin precio</span>' : '—');
        return [`${tb(c.ticker)} ${perfilChip(c.perfil)} ${senalBadge(c.senal)} <span class="muted-sm">${esc(c.emisor || '')}${c.held ? '' : ' · nueva'}</span>`, esc(c.rating || '—'), c.minNominales ? nf(c.minNominales) : '—', monto > 0 ? nomCell : estado];
      }), align)
      : `<div class="muted-sm">Ninguna especie (con estos filtros) paga en ${mesLabel(m.ym)}. Buena candidata para sumar una ON nueva de ese mes desde el Catálogo.</div>`;
    html += '</div>';
  }
  html += '</div>';
  el.innerHTML = html;
  drawSugMonthly(s);
}
function drawSugMonthly(s) {
  const cv = document.getElementById('rf-sug-monthly'); if (!cv || typeof Chart === 'undefined') return;
  const lowSet = new Set(s.suggestions.map(x => x.ym));
  if (CHARTS['rf-sug-monthly']) CHARTS['rf-sug-monthly'].destroy();
  CHARTS['rf-sug-monthly'] = new Chart(cv, {
    type: 'bar',
    data: { labels: s.monthly.map(m => mesLabel(m.ym)), datasets: [{ data: s.monthly.map(m => round2(m.total)), backgroundColor: s.monthly.map(m => lowSet.has(m.ym) ? '#f87171' : '#1D9E75'), borderRadius: 4 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (x) => money(x.raw) } } }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true } } },
  });
}

// ---------- Init ----------
(async function init() {
  if (typeof Chart !== 'undefined') {
    Chart.defaults.color = '#8a97a8';
    Chart.defaults.borderColor = 'rgba(255,255,255,0.06)';
  }
  bindEvents();
  try { if (window.lucide) lucide.createIcons(); } catch (e) { /* noop */ }
  window.addEventListener('load', () => { try { window.lucide && lucide.createIcons(); } catch (e) { /* noop */ } });
  // Convierte cualquier <i data-lucide> inyectado dinámicamente (tablas, botones, etc.).
  try { new MutationObserver(() => refreshIcons()).observe(document.body, { childList: true, subtree: true }); } catch (e) { /* noop */ }
  await loadConfig();
  setEye();
  startIdle();
  try { RATIOS = await api('/ratios'); } catch (e) { RATIOS = {}; }
  CURRENT_SEC = localStorage.getItem(SEC_KEY) || 'rendimientos';
  await loadAll();
  showSection(CURRENT_SEC);
})();
