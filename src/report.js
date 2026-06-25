import { listHoldings, listWatchlist, saveReport } from './db.js';
import { getQuoteSafe } from './marketData.js';
import { analyzeHolding, analyzeWatch, portfolioSummary } from './analysis.js';
import { sendEmail, emailConfigured } from './email.js';

const CURRENCY = process.env.CURRENCY || 'USD';

function fmtMoney(n) {
  if (n === null || n === undefined) return '-';
  return `${CURRENCY} ${Number(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtPct(n) {
  if (n === null || n === undefined) return '-';
  const s = n > 0 ? '+' : '';
  return `${s}${n}%`;
}

function color(n) {
  if (n === null || n === undefined) return '#555';
  return n > 0 ? '#0a7d33' : n < 0 ? '#c0271a' : '#555';
}

// Construye el objeto de reporte completo (datos + HTML), sin enviar ni guardar.
export async function buildReport() {
  const [holdings, watch] = await Promise.all([listHoldings(), listWatchlist()]);

  const holdingResults = [];
  const errors = [];
  for (const h of holdings) {
    const r = await getQuoteSafe(h.ticker, false);
    if (r.ok) holdingResults.push(analyzeHolding(h, r.quote));
    else errors.push({ ticker: r.symbol, error: r.error });
  }

  const watchResults = [];
  for (const w of watch) {
    const r = await getQuoteSafe(w.ticker, true);
    if (r.ok) watchResults.push(analyzeWatch(w, r.quote, r.news));
    else errors.push({ ticker: r.symbol, error: r.error });
  }

  const summary = portfolioSummary(holdingResults);
  const generatedAt = new Date().toISOString();

  const html = renderHtml({ summary, holdingResults, watchResults, errors, generatedAt });

  return {
    summary: { ...summary, generatedAt, errors, holdings: holdingResults, watch: watchResults },
    html,
  };
}

// Genera, guarda y (opcional) envia el reporte.
export async function generateReport({ send = true } = {}) {
  const { summary, html } = await buildReport();

  let emailResult = { sent: false, reason: 'No solicitado' };
  if (send && emailConfigured()) {
    try {
      const subject = `Tu cartera hoy — ${fmtPct(summary.totalPlPct)} acumulado`;
      emailResult = await sendEmail({ subject, html });
    } catch (e) {
      emailResult = { sent: false, reason: e.message };
    }
  } else if (send) {
    emailResult = { sent: false, reason: 'Mail no configurado' };
  }

  const saved = await saveReport({ summary, html, emailed: emailResult.sent });
  return { reportId: saved.id, createdAt: saved.created_at, summary, html, emailResult };
}

function obsHtml(observations) {
  return observations
    .map((o) => `<span style="display:inline-block;background:#eef1f6;border-radius:10px;padding:2px 8px;margin:1px 2px;font-size:12px;color:#333">${o.text}</span>`)
    .join(' ');
}

function renderHtml({ summary, holdingResults, watchResults, errors, generatedAt }) {
  const date = new Date(generatedAt).toLocaleString('es-AR', { dateStyle: 'full', timeStyle: 'short' });

  const holdingRows = holdingResults
    .map(
      (h) => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #eee"><b>${h.ticker}</b>
        <div style="color:#999;font-size:11px">${h.quantity} CEDEARs · ratio ${h.ratio}${h.purchase_date ? ' · ' + new Date(h.purchase_date).toLocaleDateString('es-AR') : ''}</div>
      </td>
      <td style="padding:8px;border-bottom:1px solid #eee;text-align:right">${fmtMoney(h.buy_price)}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;text-align:right">${fmtMoney(h.price)}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;color:${color(h.changePct)}">${fmtPct(h.changePct)}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;color:${color(h.plPct)}"><b>${fmtPct(h.plPct)}</b></td>
      <td style="padding:8px;border-bottom:1px solid #eee;text-align:right">${h.positionValue !== null ? fmtMoney(h.positionValue) : '-'}</td>
    </tr>
    <tr><td colspan="6" style="padding:0 8px 10px 8px">${obsHtml(h.observations)}</td></tr>`
    )
    .join('');

  const watchRows = watchResults
    .map((w) => {
      const news = (w.news || [])
        .map((n) => `<li style="margin:2px 0"><a href="${n.url}" style="color:#1a5fb4;text-decoration:none">${n.headline}</a> <span style="color:#888;font-size:11px">(${n.source || ''})</span></li>`)
        .join('');
      return `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #eee"><b>${w.ticker}</b></td>
      <td style="padding:8px;border-bottom:1px solid #eee;text-align:right">${fmtMoney(w.price)}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;color:${color(w.changePct)}">${fmtPct(w.changePct)}</td>
    </tr>
    <tr><td colspan="3" style="padding:0 8px 10px 8px">${obsHtml(w.observations)}${news ? `<ul style="margin:6px 0 0 16px;padding:0">${news}</ul>` : ''}</td></tr>`;
    })
    .join('');

  const errorsBlock = errors.length
    ? `<p style="color:#c0271a;font-size:13px">No se pudieron leer: ${errors.map((e) => e.ticker).join(', ')}</p>`
    : '';

  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f4f6f9;font-family:Arial,Helvetica,sans-serif;color:#1c1c1c">
  <div style="max-width:680px;margin:0 auto;padding:20px">
    <h1 style="font-size:20px;margin:0 0 4px">Reporte diario de tu cartera</h1>
    <p style="color:#777;margin:0 0 16px;font-size:13px">${date}</p>

    <div style="background:#fff;border-radius:12px;padding:16px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,.06)">
      <table style="width:100%;border-collapse:collapse">
        <tr>
          <td style="padding:6px"><div style="color:#777;font-size:12px">Valor total</div><div style="font-size:20px;font-weight:700">${fmtMoney(summary.totalValue)}</div></td>
          <td style="padding:6px"><div style="color:#777;font-size:12px">Resultado</div><div style="font-size:20px;font-weight:700;color:${color(summary.totalPl)}">${fmtMoney(summary.totalPl)}</div></td>
          <td style="padding:6px"><div style="color:#777;font-size:12px">Rendimiento</div><div style="font-size:20px;font-weight:700;color:${color(summary.totalPlPct)}">${fmtPct(summary.totalPlPct)}</div></td>
        </tr>
      </table>
    </div>

    <h2 style="font-size:16px;margin:0 0 8px">Tu cartera</h2>
    <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.06)">
      <thead><tr style="background:#fafbfc">
        <th style="padding:8px;text-align:left;font-size:12px;color:#777">Ticker</th>
        <th style="padding:8px;text-align:right;font-size:12px;color:#777">Compra</th>
        <th style="padding:8px;text-align:right;font-size:12px;color:#777">Actual</th>
        <th style="padding:8px;text-align:right;font-size:12px;color:#777">Hoy</th>
        <th style="padding:8px;text-align:right;font-size:12px;color:#777">P/G</th>
        <th style="padding:8px;text-align:right;font-size:12px;color:#777">Valor</th>
      </tr></thead>
      <tbody>${holdingRows || '<tr><td style="padding:12px;color:#888">Todavia no cargaste tenencias.</td></tr>'}</tbody>
    </table>

    ${watchResults.length ? `
    <h2 style="font-size:16px;margin:20px 0 8px">Tickers de interes</h2>
    <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.06)">
      <thead><tr style="background:#fafbfc">
        <th style="padding:8px;text-align:left;font-size:12px;color:#777">Ticker</th>
        <th style="padding:8px;text-align:right;font-size:12px;color:#777">Precio</th>
        <th style="padding:8px;text-align:right;font-size:12px;color:#777">Hoy</th>
      </tr></thead>
      <tbody>${watchRows}</tbody>
    </table>` : ''}

    ${errorsBlock}

    <p style="color:#999;font-size:12px;margin-top:24px;line-height:1.5;border-top:1px solid #e3e6ea;padding-top:12px">
      Esto es informacion para tu decision, no asesoramiento financiero. Las observaciones son objetivas
      (variaciones, rendimiento vs. tu precio de compra) y no constituyen una recomendacion de compra o venta.
      Verifica los datos antes de operar.
    </p>
  </div>
</body></html>`;
}
