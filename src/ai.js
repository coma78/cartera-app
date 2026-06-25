// Capa de IA OPCIONAL (Claude). Si no hay ANTHROPIC_API_KEY, no hace nada
// y la app usa la explicación automática del motor de reglas.
// El modelo SOLO explica un plan ya calculado; no cambia los números.

const KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-latest';

export function aiEnabled() { return !!KEY; }

// Pide a Claude un puntaje 0-100 por ticker (análisis cualitativo combinado).
// Devuelve { scores:{TICKER:num}, rationale } o null si falla / no hay key.
export async function aiScores(items, { risk, note } = {}) {
  if (!KEY) return null;
  const list = items.map(i => `${i.ticker} (${i.type})`).join(', ');
  const prompt =
`Sos un analista de inversiones. Te paso una lista de instrumentos (acciones/ETFs que se operan vía CEDEARs) y un perfil.
Asigná a cada uno un PUNTAJE de 0 a 100 de cuán atractivo es para SUMARLO a la cartera AHORA, combinando: tendencia/momentum, fuerza relativa (cerca de máximos), y penalizando a las que vienen planas o rezagadas. Perfil de riesgo: ${risk || 'moderado'}. Preferencia del usuario: "${note || '(ninguna)'}".
Instrumentos: ${list}.
Respondé EXCLUSIVAMENTE un JSON válido, sin texto extra, con esta forma:
{"scores":{"TICKER":NUMERO,...},"rationale":"2-3 oraciones en español rioplatense"}.
En el rationale aclará que es un análisis cualitativo basado en conocimiento general (no datos de mercado en vivo) y que no es asesoramiento financiero.`;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 700, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res.ok) { console.warn('[ai] scores HTTP', res.status); return null; }
    const d = await res.json();
    const text = d.content?.[0]?.text || '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const obj = JSON.parse(m[0]);
    if (!obj || typeof obj.scores !== 'object') return null;
    return { scores: obj.scores, rationale: obj.rationale || '' };
  } catch (e) {
    console.warn('[ai] scores error:', e.message);
    return null;
  }
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
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 400, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res.ok) { console.warn('[ai] HTTP', res.status); return null; }
    const d = await res.json();
    return d.content?.[0]?.text || null;
  } catch (e) {
    console.warn('[ai] error:', e.message);
    return null;
  }
}
