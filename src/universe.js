// Universo curado de CEDEARs (acciones/ETFs que se operan en BYMA), etiquetados
// por región, sector y tipo, para descubrir nuevos tickers.
// IMPORTANTE: los ratios cambian con el tiempo; los que figuran como null hay
// que verificarlos y cargarlos al agregar. Es una lista orientativa, no exhaustiva.
import { CEDEAR_RATIOS } from './ratios.js';

// t=ticker, n=nombre, r=región, s=sector, y=tipo
const RAW = [
  // ---- EEUU · Tecnología ----
  ['AAPL', 'Apple', 'EEUU', 'Tecnología', 'Acción'],
  ['MSFT', 'Microsoft', 'EEUU', 'Tecnología', 'Acción'],
  ['GOOGL', 'Alphabet (Google)', 'EEUU', 'Tecnología', 'Acción'],
  ['META', 'Meta (Facebook/Instagram)', 'EEUU', 'Tecnología', 'Acción'],
  ['NVDA', 'Nvidia', 'EEUU', 'Tecnología', 'Acción'],
  ['AVGO', 'Broadcom', 'EEUU', 'Tecnología', 'Acción'],
  ['AMD', 'AMD', 'EEUU', 'Tecnología', 'Acción'],
  ['INTC', 'Intel', 'EEUU', 'Tecnología', 'Acción'],
  ['ORCL', 'Oracle', 'EEUU', 'Tecnología', 'Acción'],
  ['IBM', 'IBM', 'EEUU', 'Tecnología', 'Acción'],
  ['ADBE', 'Adobe', 'EEUU', 'Tecnología', 'Acción'],
  ['CRM', 'Salesforce', 'EEUU', 'Tecnología', 'Acción'],
  ['QCOM', 'Qualcomm', 'EEUU', 'Tecnología', 'Acción'],
  ['CSCO', 'Cisco', 'EEUU', 'Tecnología', 'Acción'],
  ['PYPL', 'PayPal', 'EEUU', 'Tecnología', 'Acción'],
  // ---- EEUU · Consumo discrecional ----
  ['AMZN', 'Amazon', 'EEUU', 'Consumo discrecional', 'Acción'],
  ['TSLA', 'Tesla', 'EEUU', 'Consumo discrecional', 'Acción'],
  ['MCD', "McDonald's", 'EEUU', 'Consumo discrecional', 'Acción'],
  ['NKE', 'Nike', 'EEUU', 'Consumo discrecional', 'Acción'],
  ['SBUX', 'Starbucks', 'EEUU', 'Consumo discrecional', 'Acción'],
  // ---- EEUU · Consumo básico (defensivo) ----
  ['KO', 'Coca-Cola', 'EEUU', 'Consumo básico', 'Acción'],
  ['PEP', 'PepsiCo', 'EEUU', 'Consumo básico', 'Acción'],
  ['WMT', 'Walmart', 'EEUU', 'Consumo básico', 'Acción'],
  ['PG', 'Procter & Gamble', 'EEUU', 'Consumo básico', 'Acción'],
  ['XLP', 'Consumo básico (SPDR)', 'EEUU', 'Consumo básico', 'ETF'],
  // ---- EEUU · Comunicaciones ----
  ['NFLX', 'Netflix', 'EEUU', 'Comunicaciones', 'Acción'],
  ['DIS', 'Disney', 'EEUU', 'Comunicaciones', 'Acción'],
  // ---- EEUU · Financiero ----
  ['JPM', 'JPMorgan Chase', 'EEUU', 'Financiero', 'Acción'],
  ['BAC', 'Bank of America', 'EEUU', 'Financiero', 'Acción'],
  ['C', 'Citigroup', 'EEUU', 'Financiero', 'Acción'],
  ['GS', 'Goldman Sachs', 'EEUU', 'Financiero', 'Acción'],
  ['MS', 'Morgan Stanley', 'EEUU', 'Financiero', 'Acción'],
  ['V', 'Visa', 'EEUU', 'Financiero', 'Acción'],
  ['MA', 'Mastercard', 'EEUU', 'Financiero', 'Acción'],
  ['BRKB', 'Berkshire Hathaway (B)', 'EEUU', 'Financiero', 'Acción'],
  ['XLF', 'Sector Financiero (SPDR)', 'EEUU', 'Financiero', 'ETF'],
  // ---- EEUU · Salud (defensivo) ----
  ['JNJ', 'Johnson & Johnson', 'EEUU', 'Salud', 'Acción'],
  ['PFE', 'Pfizer', 'EEUU', 'Salud', 'Acción'],
  ['MRK', 'Merck', 'EEUU', 'Salud', 'Acción'],
  ['ABBV', 'AbbVie', 'EEUU', 'Salud', 'Acción'],
  ['UNH', 'UnitedHealth', 'EEUU', 'Salud', 'Acción'],
  ['XLV', 'Sector Salud (SPDR)', 'EEUU', 'Salud', 'ETF'],
  // ---- EEUU · Energía ----
  ['XOM', 'Exxon Mobil', 'EEUU', 'Energía', 'Acción'],
  ['CVX', 'Chevron', 'EEUU', 'Energía', 'Acción'],
  ['XLE', 'Sector Energía (SPDR)', 'EEUU', 'Energía', 'ETF'],
  // ---- EEUU · Utilities (defensivo) ----
  ['NEE', 'NextEra Energy (utility)', 'EEUU', 'Utilities', 'Acción'],
  ['DUK', 'Duke Energy (utility)', 'EEUU', 'Utilities', 'Acción'],
  ['XLU', 'Sector Utilities (SPDR)', 'EEUU', 'Utilities', 'ETF'],
  // ---- EEUU · Industrial ----
  ['BA', 'Boeing', 'EEUU', 'Industrial', 'Acción'],
  ['CAT', 'Caterpillar', 'EEUU', 'Industrial', 'Acción'],
  // ---- EEUU · Índices / apalancados ----
  ['SPY', 'S&P 500 (SPDR)', 'EEUU', 'Índice', 'ETF'],
  ['QQQ', 'Nasdaq 100 (Invesco QQQ)', 'EEUU', 'Índice', 'ETF'],
  ['DIA', 'Dow Jones (SPDR)', 'EEUU', 'Índice', 'ETF'],
  ['IWM', 'Russell 2000 (small caps)', 'EEUU', 'Índice', 'ETF'],
  ['XLK', 'Sector Tecnología (SPDR)', 'EEUU', 'Tecnología', 'ETF'],
  ['SPXL', 'S&P 500 x3 (apalancado)', 'EEUU', 'Índice', 'ETF'],
  ['TQQQ', 'Nasdaq 100 x3 (apalancado)', 'EEUU', 'Índice', 'ETF'],
  // ---- Brasil ----
  ['VALE', 'Vale (minería)', 'Brasil', 'Materiales', 'Acción'],
  ['PBR', 'Petrobras', 'Brasil', 'Energía', 'Acción'],
  ['ITUB', 'Itaú Unibanco', 'Brasil', 'Financiero', 'Acción'],
  ['BBD', 'Bradesco', 'Brasil', 'Financiero', 'Acción'],
  ['ABEV', 'Ambev (bebidas)', 'Brasil', 'Consumo básico', 'Acción'],
  ['EWZ', 'Brasil (iShares MSCI Brazil)', 'Brasil', 'Índice', 'ETF'],
  // ---- Argentina ----
  ['GGAL', 'Grupo Financiero Galicia', 'Argentina', 'Financiero', 'Acción'],
  ['YPF', 'YPF (energía)', 'Argentina', 'Energía', 'Acción'],
  ['PAM', 'Pampa Energía', 'Argentina', 'Energía', 'Acción'],
  ['BMA', 'Banco Macro', 'Argentina', 'Financiero', 'Acción'],
  ['SUPV', 'Grupo Supervielle', 'Argentina', 'Financiero', 'Acción'],
  ['CEPU', 'Central Puerto (generación eléctrica)', 'Argentina', 'Utilities', 'Acción'],
  ['TEO', 'Telecom Argentina', 'Argentina', 'Comunicaciones', 'Acción'],
  ['LOMA', 'Loma Negra (cemento)', 'Argentina', 'Materiales', 'Acción'],
  ['CRESY', 'Cresud (agro)', 'Argentina', 'Materiales', 'Acción'],
  ['VIST', 'Vista Energy', 'Argentina', 'Energía', 'Acción'],
  ['ARGT', 'Argentina (Global X MSCI Argentina)', 'Argentina', 'Índice', 'ETF'],
  // ---- Latam regional / México / Chile ----
  ['MELI', 'MercadoLibre (e-commerce Latam)', 'Latam', 'Consumo discrecional', 'Acción'],
  ['NU', 'Nu Holdings (Nubank)', 'Latam', 'Financiero', 'Acción'],
  ['AMX', 'América Móvil (México)', 'México', 'Comunicaciones', 'Acción'],
  ['SQM', 'Soc. Química y Minera (Chile, litio)', 'Chile', 'Materiales', 'Acción'],
  ['ILF', 'Latinoamérica (iShares Latin America 40)', 'Latam', 'Índice', 'ETF'],
  ['EWW', 'México (iShares MSCI Mexico)', 'México', 'Índice', 'ETF'],
  ['ECH', 'Chile (iShares MSCI Chile)', 'Chile', 'Índice', 'ETF'],
  // ---- China / Asia / Emergentes ----
  ['BABA', 'Alibaba', 'China', 'Consumo discrecional', 'Acción'],
  ['JD', 'JD.com', 'China', 'Consumo discrecional', 'Acción'],
  ['BIDU', 'Baidu', 'China', 'Tecnología', 'Acción'],
  ['FXI', 'China large-cap (iShares)', 'China', 'Índice', 'ETF'],
  ['EEM', 'Mercados emergentes (iShares)', 'Global', 'Índice', 'ETF'],
  // ---- Global / Desarrollados ----
  ['VEA', 'Desarrollados ex-EEUU (Vanguard)', 'Global', 'Índice', 'ETF'],
];

export const CEDEAR_UNIVERSE = RAW.map(([t, n, r, s, y]) => ({
  ticker: t, name: n, region: r, sector: s, type: y, ratio: CEDEAR_RATIOS[t] ?? null,
}));

// "Latam" agrupa Brasil, Argentina, México, Chile y los regionales Latam.
const LATAM = new Set(['Brasil', 'Argentina', 'México', 'Chile', 'Latam']);
// "Defensivas" = sectores tradicionalmente defensivos.
const DEFENSIVE = new Set(['Salud', 'Consumo básico', 'Utilities']);

export function filterUniverse({ region, sector, type } = {}) {
  return CEDEAR_UNIVERSE.filter((u) => {
    if (region && region !== 'Todas') {
      if (region === 'Latam') { if (!LATAM.has(u.region)) return false; }
      else if (u.region !== region) return false;
    }
    if (sector && sector !== 'Todos') {
      if (sector === 'Defensivas') { if (!DEFENSIVE.has(u.sector)) return false; }
      else if (u.sector !== sector) return false;
    }
    if (type && type !== 'Todos' && u.type !== type) return false;
    return true;
  });
}

export const UNIVERSE_REGIONS = ['EEUU', 'Latam', 'Brasil', 'Argentina', 'México', 'Chile', 'China', 'Global'];
export const UNIVERSE_SECTORS = ['Defensivas', 'Tecnología', 'Financiero', 'Salud', 'Energía', 'Utilities', 'Consumo básico', 'Consumo discrecional', 'Materiales', 'Industrial', 'Comunicaciones', 'Índice'];
