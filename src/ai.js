// Capa de IA OPCIONAL (Claude). Si no hay ANTHROPIC_API_KEY, no hace nada
// y la app usa la explicación automática del motor de reglas.
// El modelo SOLO explica un plan ya calculado; no cambia los números.

const KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-latest';

export function aiEnabled() { return !!KEY; }

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
