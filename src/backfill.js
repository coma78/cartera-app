// Reconstrucción histórica de snapshots de la cartera.
// Para cada fecha pasada calcula el valor usando las tenencias que ya existían
// (purchase_date <= fecha) y el precio histórico de cada ticker (FMP).
// Es una aproximación: usa los lotes actuales retrocedidos por su fecha de
// compra; no contempla ventas/cierres previos.
import { listHoldings, insertReportAt, deleteReconstructedReports } from './db.js';
import { signalsEnabled, getHistory } from './signals.js';

const r2 = (n) => Math.round(n * 100) / 100;
const fmt = (d) => d.toISOString().slice(0, 10);

function buildDates(from, granularity) {
  const dates = [];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(from + 'T00:00:00');
  while (d <= today) {
    const dow = d.getDay();
    if (granularity === 'daily') {
      if (dow !== 0 && dow !== 6) dates.push(fmt(d));
      d.setDate(d.getDate() + 1);
    } else if (granularity === 'weekly') {
      dates.push(fmt(d)); d.setDate(d.getDate() + 7);
    } else {
      dates.push(fmt(d)); d.setMonth(d.getMonth() + 1);
    }
  }
  const t = fmt(today);
  if (dates[dates.length - 1] !== t) dates.push(t);
  return dates;
}

// Último cierre con fecha <= D (serie ascendente)
function priceOn(series, D) {
  let p = null;
  for (const row of series) { if (row.date <= D) p = row.close; else break; }
  return p;
}

export async function reconstruct({ from, granularity = 'daily' }) {
  if (!signalsEnabled()) throw new Error('Necesita FMP_API_KEY (datos históricos)');
  if (!from) throw new Error('Falta la fecha "desde"');
  const holdings = await listHoldings();
  if (!holdings.length) throw new Error('No hay tenencias para reconstruir');

  const tickers = [...new Set(holdings.map(h => h.ticker))];
  const history = await getHistory(tickers, from);
  if (!Object.keys(history).length) throw new Error('No se pudieron traer precios históricos de FMP');

  const dates = buildDates(from, granularity);
  const snaps = [];
  for (const D of dates) {
    let value = 0, cost = 0, count = 0;
    for (const h of holdings) {
      const pd = h.purchase_date ? String(h.purchase_date).slice(0, 10) : null;
      if (!pd || pd > D) continue;                  // todavía no comprado
      const series = history[h.ticker];
      if (!series) continue;
      const close = priceOn(series, D);
      if (close == null) continue;
      const ratio = Number(h.ratio) > 0 ? Number(h.ratio) : 1;
      const shares = (Number(h.quantity) || 0) / ratio;
      value += shares * close;
      cost += shares * Number(h.buy_price);
      count++;
    }
    if (!count) continue;
    value = r2(value); cost = r2(cost);
    const pl = r2(value - cost);
    const plPct = cost > 0 ? r2((pl / cost) * 100) : null;
    snaps.push({
      at: D + 'T12:00:00.000Z',
      summary: { count, totalValue: value, totalCost: cost, totalPl: pl, totalPlPct: plPct, generatedAt: D + 'T12:00:00.000Z', reconstructed: true },
    });
  }

  await deleteReconstructedReports();
  for (const s of snaps) await insertReportAt(s.at, s.summary);
  return { inserted: snaps.length, from, granularity, tickers: Object.keys(history).length };
}
