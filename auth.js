const crypto = require('crypto');
const path = require('path');
const bcrypt = require('bcryptjs');
const { pool, normUsername } = require('./db');
const passwords = require('./passwords');

/* "auth_sessions" are login cookies. Interview "sessions" live in db.js / server.js. */
const COOKIE = 'auth_session';
const IDLE_MS = 8 * 60 * 60 * 1000;
const LOCK_AFTER = 5;
const LOCK_MS = 15 * 60 * 1000;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX = 20;
const VIEWS = path.join(__dirname, 'views');

const secret = () => process.env.SESSION_SECRET;
const sign = (v) => crypto.createHmac('sha256', secret()).update(v).digest('base64url');
const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');
const isApi = (req) => req.path.startsWith('/api/');

/* Used when the username does not exist, so a wrong username takes as long as a wrong password. */
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 12);

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch (e) {}
    }
  }
  return out;
}

function readToken(req) {
  const raw = parseCookies(req.headers.cookie)[COOKIE];
  if (!raw) return null;
  const i = raw.lastIndexOf('.');
  if (i < 1) return null;
  const token = raw.slice(0, i);
  const mac = Buffer.from(raw.slice(i + 1));
  const expect = Buffer.from(sign(token));
  return mac.length === expect.length && crypto.timingSafeEqual(mac, expect) ? token : null;
}

function cookieOptions() {
  return { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/' };
}

/* Returns the logged-in user for a request (HTTP or WebSocket upgrade), or null. */
async function userFromRequest(req) {
  const token = readToken(req);
  if (!token) return null;
  const th = hashToken(token);
  const { rows } = await pool.query(
    `SELECT a.last_seen_at, u.id, u.username, u.is_admin, u.is_active, u.must_change_password,
            u.minutes_limit, COALESCE(u.listened_seconds, 0) AS listened_seconds
     FROM auth_sessions a JOIN users u ON u.id = a.user_id WHERE a.token_hash = $1`,
    [th]
  );
  const r = rows[0];
  if (!r) return null;
  const idle = Date.now() - new Date(r.last_seen_at).getTime();
  if (idle > IDLE_MS || !r.is_active) {
    await pool.query('DELETE FROM auth_sessions WHERE token_hash = $1', [th]);
    return null;
  }
  if (idle > 60 * 1000) await pool.query('UPDATE auth_sessions SET last_seen_at = now() WHERE token_hash = $1', [th]);
  return {
    id: r.id,
    username: r.username,
    isAdmin: r.is_admin,
    mustChangePassword: r.must_change_password,
    minutesLimit: r.minutes_limit,
    listenedSeconds: r.listened_seconds,
    tokenHash: th,
  };
}

/* ---------- login rate limit (per IP, in memory) ---------- */

const attempts = new Map();
function allowAttempt(ip) {
  const now = Date.now();
  let a = attempts.get(ip);
  if (!a || a.reset < now) {
    a = { n: 0, reset: now + RATE_WINDOW_MS };
    attempts.set(ip, a);
  }
  a.n += 1;
  return a.n <= RATE_MAX;
}

async function cleanup() {
  const now = Date.now();
  for (const [ip, a] of attempts) if (a.reset < now) attempts.delete(ip);
  await pool.query('DELETE FROM auth_sessions WHERE last_seen_at < $1', [new Date(now - IDLE_MS)]);
}

const logEvent = (userId, username, success) =>
  pool.query('INSERT INTO login_events (user_id, username, success) VALUES ($1, $2, $3)', [userId, username.slice(0, 80), success]);

/* ---------- routes ---------- */

/* Public routes: the login page and the login endpoint. Register before requireLogin. */
function publicRoutes(app) {
  app.get('/login', async (req, res, next) => {
    try {
      if (await userFromRequest(req)) return res.redirect('/');
      res.sendFile(path.join(VIEWS, 'login.html'));
    } catch (e) { next(e); }
  });

  app.post('/api/login', async (req, res, next) => {
    try {
      if (!allowAttempt(req.ip)) {
        return res.status(429).json({ error: 'Too many login attempts. Wait 15 minutes and try again.' });
      }
      const username = normUsername(req.body.username);
      const password = String(req.body.password || '');
      if (!username || !password) return res.status(400).json({ error: 'Enter your username and password.' });

      const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
      const u = rows[0];
      if (u && u.locked_until && new Date(u.locked_until) > new Date()) {
        await logEvent(u.id, username, false);
        const mins = Math.ceil((new Date(u.locked_until) - Date.now()) / 60000);
        return res.status(423).json({ error: `Too many failed logins. Try again in ${mins} minute${mins === 1 ? '' : 's'}.` });
      }
      const ok = await bcrypt.compare(password, u ? u.password_hash : DUMMY_HASH);
      if (!u || !ok) {
        if (u) {
          await pool.query(
            `UPDATE users SET
               locked_until = CASE WHEN failed_logins + 1 >= $2 THEN $3 ELSE locked_until END,
               failed_logins = CASE WHEN failed_logins + 1 >= $2 THEN 0 ELSE failed_logins + 1 END
             WHERE id = $1`,
            [u.id, LOCK_AFTER, new Date(Date.now() + LOCK_MS)]
          );
        }
        await logEvent(u ? u.id : null, username, false);
        return res.status(401).json({ error: 'Wrong username or password.' });
      }
      if (!u.is_active) {
        await logEvent(u.id, username, false);
        return res.status(403).json({ error: 'This account is disabled. Contact the admin.' });
      }

      await pool.query('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [u.id]);
      await logEvent(u.id, username, true);
      const token = crypto.randomBytes(32).toString('base64url');
      await pool.query('INSERT INTO auth_sessions (token_hash, user_id) VALUES ($1, $2)', [hashToken(token), u.id]);
      res.cookie(COOKIE, `${token}.${sign(token)}`, cookieOptions());
      res.json({ ok: true, mustChangePassword: u.must_change_password });
    } catch (e) { next(e); }
  });
}

/* Everything registered after this needs a login. Pages redirect to /login, APIs return 401. */
const PASSWORD_CHANGE_ALLOWED = new Set([
  'GET /change-password',
  'POST /api/change-password',
  'POST /api/logout',
  'GET /api/me',
]);

async function requireLogin(req, res, next) {
  try {
    const user = await userFromRequest(req);
    if (!user) {
      if (isApi(req)) return res.status(401).json({ error: 'Your login has expired. Log in again.' });
      return res.redirect('/login');
    }
    req.user = user;
    if (user.mustChangePassword && !PASSWORD_CHANGE_ALLOWED.has(`${req.method} ${req.path}`)) {
      if (isApi(req)) return res.status(403).json({ error: 'Change your password first.', mustChangePassword: true });
      return res.redirect('/change-password');
    }
    next();
  } catch (e) { next(e); }
}

/* Routes for logged-in users. Register after requireLogin. */
function accountRoutes(app) {
  app.get('/change-password', (req, res) => res.sendFile(path.join(VIEWS, 'change-password.html')));

  app.get('/api/me', (req, res) => {
    res.json({
      username: req.user.username,
      isAdmin: req.user.isAdmin,
      mustChangePassword: req.user.mustChangePassword,
      accountUsedSeconds: req.user.listenedSeconds,
      accountLimitSeconds: req.user.isAdmin ? null : req.user.minutesLimit * 60, // null = unlimited
    });
  });

  app.post('/api/change-password', async (req, res, next) => {
    try {
      const current = String(req.body.current || '');
      const newPassword = String(req.body.next || '');
      if (newPassword.length < 10) return res.status(400).json({ error: 'The new password must be at least 10 characters.' });
      if (newPassword.length > 200) return res.status(400).json({ error: 'The new password is too long.' });
      if (newPassword === current) return res.status(400).json({ error: 'Choose a password different from the current one.' });
      const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
      if (!rows[0] || !(await bcrypt.compare(current, rows[0].password_hash))) {
        return res.status(400).json({ error: 'The current password is wrong.' });
      }
      const hash = await bcrypt.hash(newPassword, 12);
      // Also kept encrypted for the admin's CSV; the Change password page tells users the admin can see it.
      await pool.query(
        'UPDATE users SET password_hash = $1, password_enc = $2, must_change_password = FALSE WHERE id = $3',
        [hash, passwords.encrypt(newPassword), req.user.id]
      );
      // Sign out every other device that used the old password.
      await pool.query('DELETE FROM auth_sessions WHERE user_id = $1 AND token_hash <> $2', [req.user.id, req.user.tokenHash]);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  app.post('/api/logout', async (req, res, next) => {
    try {
      await pool.query('DELETE FROM auth_sessions WHERE token_hash = $1', [req.user.tokenHash]);
      res.clearCookie(COOKIE, cookieOptions());
      res.json({ ok: true });
    } catch (e) { next(e); }
  });
}

module.exports = { publicRoutes, requireLogin, accountRoutes, userFromRequest, cleanup };
