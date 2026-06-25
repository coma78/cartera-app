// Login con Google (OAuth 2.0 / OpenID Connect) + sesión por cookie firmada.
// Si no hay GOOGLE_CLIENT_ID configurado, el SSO queda desactivado (modo local).
import crypto from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const SESSION_SECRET = process.env.SESSION_SECRET || 'cambia-esto-en-produccion';
const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');
const ALLOWED = (process.env.ALLOWED_EMAILS || 'gascazur@gmail.com')
  .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

export function isEnabled() {
  return !!(CLIENT_ID && CLIENT_SECRET);
}

// ---- cookie de sesión firmada (HMAC) ----
function hmac(data) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
}
function makeToken(email, days = 30) {
  const payload = Buffer.from(JSON.stringify({ email, exp: Date.now() + days * 86400000 })).toString('base64url');
  return `${payload}.${hmac(payload)}`;
}
function verifyToken(tok) {
  if (!tok || !tok.includes('.')) return null;
  const [payload, sig] = tok.split('.');
  if (hmac(payload) !== sig) return null;
  try {
    const obj = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!obj.exp || obj.exp < Date.now()) return null;
    return obj.email;
  } catch { return null; }
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((c) => {
    const i = c.indexOf('='); if (i < 0) return;
    out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}
function setCookie(res, value, maxAgeSec, secure) {
  res.setHeader('Set-Cookie',
    `sid=${value}; HttpOnly; Path=/; Max-Age=${maxAgeSec}; SameSite=Lax${secure ? '; Secure' : ''}`);
}

export function currentUser(req) {
  return verifyToken(parseCookies(req).sid);
}

function redirectUri(req) {
  const base = BASE_URL || `${req.protocol}://${req.get('host')}`;
  return `${base}/auth/callback`;
}
function newClient(req) {
  return new OAuth2Client(CLIENT_ID, CLIENT_SECRET, redirectUri(req));
}

// ---- rutas de auth ----
export function installAuth(app) {
  app.get('/auth/login', (req, res) => {
    const url = newClient(req).generateAuthUrl({
      scope: ['openid', 'email', 'profile'],
      prompt: 'select_account',
    });
    res.redirect(url);
  });

  app.get('/auth/callback', async (req, res) => {
    try {
      const client = newClient(req);
      const { tokens } = await client.getToken(req.query.code);
      const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: CLIENT_ID });
      const email = (ticket.getPayload().email || '').toLowerCase();
      if (!ALLOWED.includes(email)) {
        return res.status(403).send(`Acceso denegado para ${email}. Esta app es privada.`);
      }
      const secure = (BASE_URL || '').startsWith('https') || req.protocol === 'https';
      setCookie(res, makeToken(email), 30 * 86400, secure);
      res.redirect('/');
    } catch (e) {
      res.status(500).send('Error de login: ' + e.message);
    }
  });

  app.get('/auth/logout', (req, res) => {
    setCookie(res, '', 0, false);
    res.redirect('/login.html');
  });

  app.get('/api/me', (req, res) => res.json({ email: currentUser(req), sso: isEnabled() }));
}

// Middleware para /api (devuelve 401 con la URL de login)
export function apiGuard(req, res, next) {
  if (!isEnabled()) return next();
  if (req.path === '/health' || req.path === '/me') return next();
  if (currentUser(req)) return next();
  res.status(401).json({ error: 'login', login: '/auth/login' });
}

// Middleware para la página principal
export function pageGuard(req, res, next) {
  if (!isEnabled() || currentUser(req)) return next();
  res.redirect('/login.html');
}
