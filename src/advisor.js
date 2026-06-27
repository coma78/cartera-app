// Motor de reglas para sugerir cómo distribuir un monto nuevo entre los
// tickers de la cartera/catálogo, según las preferencias del usuario.
// Es DETERMINISTA y explicable. NO es asesoramiento financiero: produce
// un escenario objetivo para que la persona decida.

const LEVERAGED = new Set(['TQQQ', 'SPXL', 'UPRO', 'SOXL', 'TECL', 'SQQQ', 'TNA', 'FAS']);

function r2(n) { return Math.round(n * 100) / 100; }

// Sesgo por riesgo: pondera ETFs / acciones / apalancados.
function riskFactor(type, ticker, risk) {
  const lev = LEVERAGED.has(ticker);
  if (risk === 'conservador') return lev ? 0.15 : (type === 'ETF' ? 1.5 : 0.9);
  if (risk === 'agresivo') return lev ? 1.6 : (type === 'ETF' ? 0.85 : 1.2);
  return lev ? 0.7 : 1; // moderado
}

// Peso por estrategia de aporte.
function strategyWeight(plPct, strategy) {
  const p = plPct == null ? 0 : plPct;
  if (strategy === 'losers') return 1 + Math.max(0, -p) / 50;   // más a las que cayeron
  if (strategy === 'winners') return 1 + Math.max(0, p) / 50;   // más a las que suben
  return 1; // 'equal' y 'rebalance' -> objetivo equipeso
}

// Cap por ticker: ningún peso supera capT; se redistribuye al resto.
function capPerTicker(weights, capT) {
  const keys = Object.keys(weights);
  for (let it = 0; it < 6; it++) {
    let over = 0; const under = [];
    for (const k of keys) {
      if (weights[k] > capT + 1e-9) { over += weights[k] - capT; weights[k] = capT; }
      else under.push(k);
    }
    if (over <= 1e-9) break;
    const us = under.reduce((a, k) => a + weights[k], 0);
    if (us <= 1e-9) break;
    for (const k of under) weights[k] += over * (weights[k] / us);
  }
  return weights;
}

// Cap por tipo: ningún tipo (Acción/ETF) supera capType del total.
function capPerType(weights, typeOf, capType) {
  const totals = {};
  for (const k in weights) totals[typeOf[k]] = (totals[typeOf[k]] || 0) + weights[k];
  for (const ty in totals) {
    if (totals[ty] > capType + 1e-9) {
      const scale = capType / totals[ty];
      const freed = totals[ty] - capType;
      const others = Object.keys(weights).filter(k => typeOf[k] !== ty);
      const os = others.reduce((a, k) => a + weights[k], 0);
      for (const k in weights) if (typeOf[k] === ty) weights[k] *= scale;
      if (os > 1e-9) for (const k of others) weights[k] += freed * (weights[k] / os);
    }
  }
  return weights;
}

function normalize(weights) {
  const s = Object.values(weights).reduce((a, b) => a + b, 0);
  if (s <= 0) return weights;
  for (const k in weights) weights[k] /= s;
  return weights;
}

// items: [{ ticker, type, price (acción USD), ratio, currentValue, plPct }]
// prefs: { risk, maxPerTicker(%), maxPerType(%), strategy }
export function computeSuggestion({ amount, items, prefs = {} }) {
  amount = Number(amount);
  if (!(amount > 0)) throw new Error('El monto a invertir debe ser mayor a 0');
  const elig = (items || []).filter(i => i.price > 0 && i.ratio > 0);
  if (!elig.length) throw new Error('No hay tickers elegibles con cotización');

  const risk = prefs.risk || 'moderado';
  const strategy = prefs.strategy || 'rebalance';
  const capT = (Number(prefs.maxPerTicker) > 0 ? Number(prefs.maxPerTicker) : (risk === 'conservador' ? 15 : risk === 'agresivo' ? 40 : 25)) / 100;
  const capType = (Number(prefs.maxPerType) > 0 ? Number(prefs.maxPerType) : (risk === 'conservador' ? 70 : 100)) / 100;

  // Peso de preferencia por ticker (riesgo × estrategia).
  // En 'ai' (puntaje del modelo) o 'momentum' (datos de mercado) la base es
  // un puntaje externo provisto en prefs.scores.
  const usesScores = (strategy === 'ai' || strategy === 'momentum') && prefs.scores;
  const pwAll = {};
  for (const i of elig) {
    const base = usesScores
      ? Math.max(0.0001, Number(prefs.scores[i.ticker]) || 0)
      : strategyWeight(i.plPct, strategy);
    // Factor técnico (RSI/tendencia/MACD) cuando hay indicadores.
    const tf = (prefs.technicals && prefs.technicals[i.ticker]) ? (prefs.technicals[i.ticker].techFactor ?? 1) : 1;
    pwAll[i.ticker] = riskFactor(i.type, i.ticker, risk) * base * tf;
  }

  // Límite de cantidad de tickers: nos quedamos con los más alineados
  let eligUse = elig;
  const maxN = Number(prefs.maxTickers);
  if (maxN > 0 && maxN < elig.length) {
    eligUse = [...elig].sort((a, b) => pwAll[b.ticker] - pwAll[a.ticker]).slice(0, maxN);
  }

  const typeOf = {};
  const priceOf = {};   // precio por CEDEAR
  const curVal = {};
  let V = 0;
  const pw = {};
  for (const i of eligUse) {
    typeOf[i.ticker] = i.type;
    priceOf[i.ticker] = i.price / i.ratio;
    curVal[i.ticker] = Number(i.currentValue) || 0;
    V += curVal[i.ticker];
    pw[i.ticker] = pwAll[i.ticker];
  }

  // Topes "factibles": con pocos tickers/tipos, un tope muy bajo no puede
  // sumar 100%, así que se relaja al mínimo posible (equipeso).
  const N = elig.length;
  const numTypes = new Set(Object.values(typeOf)).size;
  const capTEff = Math.min(1, Math.max(capT, 1 / N));
  const capTypeEff = Math.min(1, Math.max(capType, 1 / numTypes));

  // Pesos objetivo (los caps preservan la suma, no re-normalizamos al final)
  let tw = normalize({ ...pw });
  tw = capPerType(tw, typeOf, capTypeEff);
  tw = capPerTicker(tw, capTEff);

  const future = V + amount;
  // Compra deseada = acercar cada posición a su valor objetivo (sin vender)
  let desired = {};
  for (const t in tw) desired[t] = Math.max(0, tw[t] * future - curVal[t]);
  let dsum = Object.values(desired).reduce((a, b) => a + b, 0);
  if (dsum <= 1e-9) { // ya está sobre-objetivo en todo: repartir por peso
    for (const t in tw) desired[t] = tw[t] * amount;
    dsum = amount;
  }
  const factor = amount / dsum;

  // Convertir a CEDEARs (enteros)
  const rows = [];
  let used = 0;
  for (const i of eligUse) {
    const t = i.ticker;
    const buyMoney = desired[t] * factor;
    const cedears = Math.floor(buyMoney / priceOf[t]);
    const money = r2(cedears * priceOf[t]);
    used += money;
    rows.push({
      ticker: t, type: typeOf[t],
      cedearPrice: r2(priceOf[t]),
      currentValue: r2(curVal[t]),
      currentWeight: V > 0 ? r2((curVal[t] / V) * 100) : 0,
      targetWeight: r2(tw[t] * 100),
      cedears, buyMoney: money,
      resultingValue: r2(curVal[t] + money),
      tech: (prefs.technicals && prefs.technicals[t]) ? prefs.technicals[t] : null,
    });
  }
  const resTotal = V + used;
  for (const row of rows) {
    row.resultingWeight = resTotal > 0 ? r2((row.resultingValue / resTotal) * 100) : 0;
    row.pctOfNew = used > 0 ? r2((row.buyMoney / used) * 100) : 0; // % del aporte nuevo
  }
  rows.sort((a, b) => b.buyMoney - a.buyMoney);

  return {
    amount: r2(amount),
    invested: r2(used),
    leftover: r2(amount - used),
    currentTotal: r2(V),
    resultingTotal: r2(resTotal),
    prefs: { risk, strategy, maxPerTicker: r2(capTEff * 100), maxPerType: r2(capTypeEff * 100) },
    rows: rows.filter(r => r.cedears > 0 || r.targetWeight > 0),
  };
}

// Explicación automática (sin IA) — clara y honesta.
export function templateRationale(plan) {
  const tops = plan.rows.filter(r => r.cedears > 0).slice(0, 3).map(r => `${r.cedears} CEDEARs de ${r.ticker}`);
  const estrat = { rebalance: 'rebalancear hacia un peso parejo', equal: 'igualar pesos', losers: 'reforzar las posiciones que más cayeron', winners: 'reforzar las que mejor vienen', ai: 'maximizar según el análisis del modelo', momentum: 'priorizar momentum (datos de mercado)' }[plan.prefs.strategy] || plan.prefs.strategy;
  return `Con perfil ${plan.prefs.risk} y estrategia de ${estrat}, ` +
    `se distribuyen ${plan.invested} de los ${plan.amount} ingresados (sobran ${plan.leftover} por redondeo a CEDEARs enteros), ` +
    `con un tope de ${plan.prefs.maxPerTicker}% por ticker. Principales aportes: ${tops.join(', ') || 'ninguno'}. ` +
    `Es un escenario informativo, no una recomendación de inversión.`;
}
