// Envio de mail. Soporta dos proveedores (sin librerias extra, via fetch):
//   MAIL_PROVIDER=resend  -> Resend (NO pide telefono; ideal para empezar)
//   MAIL_PROVIDER=brevo   -> Brevo
//
// Resend: registrate en resend.com con tu mail. Para enviarte el reporte
// a vos mismo no necesitas dominio: usa MAIL_FROM_EMAIL=onboarding@resend.dev
// y MAIL_TO_EMAIL = el mismo mail con el que te registraste.

const PROVIDER = (process.env.MAIL_PROVIDER || 'resend').toLowerCase();

const RESEND_KEY = process.env.RESEND_API_KEY || '';
const BREVO_KEY = process.env.BREVO_API_KEY || '';

const FROM_EMAIL = process.env.MAIL_FROM_EMAIL || (PROVIDER === 'resend' ? 'onboarding@resend.dev' : '');
const FROM_NAME = process.env.MAIL_FROM_NAME || 'Cartera Bot';
const TO_EMAIL = process.env.MAIL_TO_EMAIL || '';

export function emailConfigured() {
  if (!TO_EMAIL || !FROM_EMAIL) return false;
  if (PROVIDER === 'brevo') return !!BREVO_KEY;
  return !!RESEND_KEY; // resend por defecto
}

async function sendResend({ subject, html, to }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      to: [to],
      subject,
      html,
    }),
  });
  if (!res.ok) throw new Error(`Resend HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json().catch(() => ({}));
  return { sent: true, messageId: data.id || null };
}

async function sendBrevo({ subject, html, to }) {
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': BREVO_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      sender: { email: FROM_EMAIL, name: FROM_NAME },
      to: [{ email: to }],
      subject,
      htmlContent: html,
    }),
  });
  if (!res.ok) throw new Error(`Brevo HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json().catch(() => ({}));
  return { sent: true, messageId: data.messageId || null };
}

export async function sendEmail({ subject, html, to }) {
  if (!emailConfigured()) {
    const miss = PROVIDER === 'brevo' ? 'BREVO_API_KEY' : 'RESEND_API_KEY';
    return { sent: false, reason: `Mail no configurado (faltan ${miss} / MAIL_FROM_EMAIL / MAIL_TO_EMAIL)` };
  }
  const recipient = to || TO_EMAIL;
  if (PROVIDER === 'brevo') return sendBrevo({ subject, html, to: recipient });
  return sendResend({ subject, html, to: recipient });
}
