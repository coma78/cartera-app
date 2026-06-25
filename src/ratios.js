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
