// Envio de mail via Brevo (API transaccional).
// Docs: https://developers.brevo.com/reference/sendtransacemail

const API_KEY = process.env.BREVO_API_KEY || '';
const FROM_EMAIL = process.env.MAIL_FROM_EMAIL || '';
const FROM_NAME = process.env.MAIL_FROM_NAME || 'Cartera Bot';
const TO_EMAIL = process.env.MAIL_TO_EMAIL || '';

export function emailConfigured() {
  return !!(API_KEY && FROM_EMAIL && TO_EMAIL);
}

export async function sendEmail({ subject, html, to }) {
  if (!emailConfigured()) {
    return { sent: false, reason: 'Mail no configurado (faltan BREVO_API_KEY / MAIL_FROM_EMAIL / MAIL_TO_EMAIL)' };
  }
  const recipient = to || TO_EMAIL;

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': API_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      sender: { email: FROM_EMAIL, name: FROM_NAME },
      to: [{ email: recipient }],
      subject,
      htmlContent: html,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Brevo HTTP ${res.status}: ${body}`);
  }
  const data = await res.json().catch(() => ({}));
  return { sent: true, messageId: data.messageId || null };
}
