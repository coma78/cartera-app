// Capa de IA OPCIONAL (Claude). Si no hay ANTHROPIC_API_KEY, no hace nada
// y la app usa la explicación automática del motor de reglas.
// El modelo SOLO explica un plan ya calculado; no cambia los números.

const KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
let _lastError = null;

export function aiEnabled() { return !!KEY; }
export function lastAiError() { return _lastError; }
export function aiModel() { return MODEL; }

// Lista los modelos que la API key puede usar (para diagnóstico).
export async function listModels() {
  if (!KEY) return { ok: false, error: 'sin key' };
  try {
    const res = await fetch('https://api.anthropic.com/v1/models', {
      headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    });
    const text = await res.text();
    if (!res.ok) {
      let m = `HTTP ${res.status}`;
      try { const e = JSON.parse(text); m = `HTTP ${res.status}: ${e.error?.message || ''}`; } catch { /* */ }
      return { ok: false, error: m };
    }
    const d = JSON.parse(text);
    return { ok: true, models: (d.data || []).map(x => x.id) };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Llama a la API de Claude y devuelve el texto, o null (guardando el error).
async function callClaude(prompt, maxTokens = 600) {
  _lastError = null;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const e = JSON.parse(text); msg = `HTTP ${res.status}: ${e.error?.message || text.slice(0, 160)}`; } catch { msg = `HTTP ${res.status}: ${text.slice(0, 160)}`; }
      _lastError = msg; console.warn('[ai]', msg); return null;
    }
    const d = JSON.parse(text);
    return d.content?.[0]?.text || '';
  } catch (e) {
    _lastError = e.message; console.warn('[ai] error:', e.message); return null;
  }
}

// Pide a Claude un puntaje 0-100 por ticker (análisis cualitativo combinado).
// Devuelve { scores:{TICKER:num}, rationale } o null si falla / no hay key.
export async function aiScores(items, { risk, note, signals } = {}) {
  if (!KEY) return null;
  const list = items.map(i => {
    const s = signals && signals[i.ticker];
    const perf = s ? ` [1M ${s.m1 ?? '?'}%, 3M ${s.m3 ?? '?'}%, 6M ${s.m6 ?? '?'}%, 1A ${s.y1 ?? '?'}%]` : '';
    return `${i.ticker} (${i.type})${perf}`;
  }).join('; ');
  const dataNote = signals && Object.keys(signals).length
    ? 'Usá los rendimientos reales entre corchetes (1M/3M/6M/1A) como base del análisis de tendencia.'
    : 'No hay datos de rendimiento; analizá con tu conocimiento general.';
  const prompt =
`Sos un analista de inversiones. Te paso instrumentos (acciones/ETFs vía CEDEARs) con su rendimiento reciente y un perfil.
${dataNote}
Asigná a cada uno un PUNTAJE de 0 a 100 de cuán atractivo es para SUMARLO a la cartera AHORA, combinando: tendencia/momentum, fuerza relativa, y penalizando a las que vienen planas o rezagadas. Perfil de riesgo: ${risk || 'moderado'}. Preferencia del usuario: "${note || '(ninguna)'}".
Instrumentos: ${list}.
Respondé EXCLUSIVAMENTE un JSON válido, sin texto extra, con esta forma:
{"scores":{"TICKER":NUMERO,...},"rationale":"2-3 oraciones en español rioplatense"}.
En el rationale aclará que es un análisis cualitativo basado en conocimiento general (no datos de mercado en vivo) y que no es asesoramiento financiero.`;
  const text = await callClaude(prompt, 700);
  if (text == null) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) { _lastError = 'respuesta de IA no parseable'; return null; }
  try {
    const obj = JSON.parse(m[0]);
    if (!obj || typeof obj.scores !== 'object') { _lastError = 'la IA no devolvió scores'; return null; }
    return { scores: obj.scores, rationale: obj.rationale || '' };
  } catch (e) { _lastError = 'JSON inválido de la IA'; return null; }
}

export async function aiRationale(plan, note) {
  if (!KEY) return null;
  const dist = plan.rows.filter(r => r.cedears > 0)
    .map(r => `${r.ticker}: ${r.cedears} CEDEARs ($${r.buyMoney}), queda en ${r.resultingWeight}%`)
    .join('; ');
  const prompt =
`Sos un asistente que EXPLICA (no modifica) un plan de inversión ya calculado por un motor de reglas.
Preferencias en texto libre del usuario: ${note || '(ninguna)'}.
Datos del plan:
- Perfil: ${plan.prefs.risk}, estrategia: ${plan.prefs.strategy}, tope ${plan.prefs.maxPerTicker}% por ticker, ${plan.prefs.maxPerType}% por tipo.
- Se invierten $${plan.invested} de $${plan.amount} (sobran $${plan.leftover} por redondeo).
- Distribución sugerida: ${dist || 'sin compras'}.
Escribí 3 a 5 oraciones en español rioplatense explicando la lógica del reparto y 1-2 cosas a tener en cuenta dadas las preferencias. NO inventes números distintos a los del plan. Cerrá aclarando que es información, no asesoramiento financiero.`;
  return await callClaude(prompt, 400);
}
