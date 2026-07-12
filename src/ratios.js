// Ratios de conversion CEDEAR -> accion subyacente.
// "ratio: 39" significa que 39 CEDEARs equivalen a 1 accion en EEUU,
// por lo tanto el precio de 1 CEDEAR = precio de la accion / ratio.
//
// Estos valores cambian con el tiempo (los emisores los ajustan). Son
// solo una sugerencia para autocompletar; en cada tenencia se guarda el
// ratio que cargues, y lo podes editar cuando quieras.

export const CEDEAR_RATIOS = {
  AVGO: 39,
  BRKB: 22,
  EEM: 5,
  EWZ: 2,
  FXI: 5,
  GOOGL: 58,
  JPM: 15,
  MELI: 120,
  META: 25,
  MSFT: 30,
  NU: 2,
  PFE: 4,
  QQQ: 20,
  SPY: 20,
  SPXL: 25,
  TQQQ: 25,
  VEA: 10,
  XLV: 29,
};

export function suggestRatio(ticker) {
  if (!ticker) return 1;
  return CEDEAR_RATIOS[ticker.toUpperCase().trim()] || 1;
}

// ETFs / indices (el resto se considera "Accion").
export const CEDEAR_ETFS = new Set([
  'SPY', 'QQQ', 'EEM', 'EWZ', 'FXI', 'VEA', 'XLV', 'SPXL', 'TQQQ',
  'DIA', 'IWM', 'EFA', 'ARKK', 'XLF', 'XLE', 'XLK', 'GLD', 'SLV',
]);

// Tipos elegidos a mano en el catálogo (watchlist.tipo). Se refrescan cada vez
// que se lee la watchlist y tienen prioridad sobre la lista fija de arriba, así
// un ticker nuevo (ej. un ETF que no está en CEDEAR_ETFS) queda bien clasificado.
const TYPE_OVERRIDES = new Map();
export function setTypeOverrides(rows = []) {
  TYPE_OVERRIDES.clear();
  for (const r of rows) {
    const t = String(r?.ticker || '').toUpperCase().trim();
    const tipo = String(r?.tipo || '').trim();
    if (t && tipo) TYPE_OVERRIDES.set(t, tipo);
  }
}

export function tickerType(ticker) {
  const t = (ticker || '').toUpperCase().trim();
  if (TYPE_OVERRIDES.has(t)) return TYPE_OVERRIDES.get(t);
  return CEDEAR_ETFS.has(t) ? 'ETF' : 'Acción';
}
