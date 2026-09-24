const path = require('path');
const bcrypt = require('bcryptjs');
const { pool, today, normUsername, ID_RE, USERNAME_RE } = require('./db');
const passwords = require('./passwords');

/* Admin console and API. Shows usage counts only: never resume, JD, questions, or answers.
   The CSV download also includes each user's current password (see passwords.js). */

const VIEWS = path.join(__dirname, 'views');
const MAX_ACCOUNT_MINUTES = 100000;
const DEFAULT_ACCOUNT_MINUTES = 100;
const MAX_ADD_MINUTES = 600;

function requireAdmin(req, res, next) {
  if (req.user && req.user.isAdmin) return next();
  if (req.originalUrl.startsWith('/api/')) return res.status(403).json({ error: 'Admins only.' });
  res.status(404).send('Not found');
}

function checkPassword(pw) {
  if (pw.length < 10) return 'The temporary password must be at least 10 characters.';
  if (pw.length > 200) return 'The temporary password is too long.';
  return null;
}

const minutes = (secs) => Math.round((secs / 60) * 10) / 10;

function parseAccountMinutes(v) {
  const n = v == null || v === '' ? DEFAULT_ACCOUNT_MINUTES : Number(v);
  return Number.isInteger(n) && n >= 0 && n <= MAX_ACCOUNT_MINUTES ? n : null;
}
const BAD_MINUTES = `Account minutes must be a whole number from 0 to ${MAX_ACCOUNT_MINUTES}.`;

const UNKNOWN_PASSWORD = 'unknown - reset to see';

/* withPasswords: only for the CSV download. The admin page itself never receives passwords. */
async function usageReport(maxMinutes, { withPasswords = false } = {}) {
  const [users, sessions, usage] = await Promise.all([
    pool.query(
      `SELECT id, username, is_admin, is_active, must_change_password, minutes_limit,
              COALESCE(listened_seconds, 0) AS listened_seconds, locked_until, last_login_at, created_at, password_enc
       FROM users ORDER BY username`
    ),
    pool.query(
      `SELECT id, user_id, name, created_at, listened_seconds, extra_listen_minutes, ended_at
       FROM sessions ORDER BY created_at DESC`
    ),
    pool.query(
      `SELECT user_id, SUM(questions) AS total, SUM(CASE WHEN day = $1 THEN questions ELSE 0 END) AS today
       FROM usage_daily GROUP BY user_id`,
      [today()]
    ),
  ]);
  const usageBy = new Map(usage.rows.map((u) => [u.user_id, u]));
  const now = Date.now();
  return users.rows.map((u) => {
    const own = sessions.rows.filter((s) => s.user_id === u.id);
    const q = usageBy.get(u.id);
    const extra = withPasswords ? { password: passwords.decrypt(u.password_enc) || UNKNOWN_PASSWORD } : {};
    return {
      ...extra,
      id: u.id,
      username: u.username,
      isAdmin: u.is_admin,
      isActive: u.is_active,
      mustChangePassword: u.must_change_password,
      locked: Boolean(u.locked_until && new Date(u.locked_until).getTime() > now),
      minutesLimit: u.is_admin ? null : u.minutes_limit, // null = unlimited (admins)
      minutesUsed: minutes(u.listened_seconds),
      lastLoginAt: u.last_login_at ? new Date(u.last_login_at).toISOString() : null,
      sessionCount: own.length,
      questionsToday: q ? Number(q.today) : 0,
      questionsTotal: q ? Number(q.total) : 0,
      sessions: own.map((s) => ({
        id: s.id,
        name: s.name,
        createdAt: new Date(s.created_at).toISOString(),
        listenedMinutes: minutes(s.listened_seconds),
        limitMinutes: Math.round((maxMinutes + s.extra_listen_minutes) * 10) / 10,
        ended: Boolean(s.ended_at),
      })),
    };
  });
}

/* Stops spreadsheet apps from running a cell as a formula. */
function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function routes(app, { maxMinutes }) {
  app.get('/admin', requireAdmin, (req, res) => res.sendFile(path.join(VIEWS, 'admin.html')));
  app.use('/api/admin', requireAdmin);

  app.get('/api/admin/users', async (req, res, next) => {
    try {
      res.json({ me: req.user.id, users: await usageReport(maxMinutes) });
    } catch (e) { next(e); }
  });

  app.post('/api/admin/users', async (req, res, next) => {
    try {
      const username = normUsername(req.body.username);
      const password = String(req.body.password || '');
      if (!USERNAME_RE.test(username)) {
        return res.status(400).json({ error: 'Username: 3 to 40 characters, letters, numbers, dot, dash, or underscore.' });
      }
      const bad = checkPassword(password);
      if (bad) return res.status(400).json({ error: bad });
      const accountMinutes = parseAccountMinutes(req.body.minutesLimit);
      if (accountMinutes == null) return res.status(400).json({ error: BAD_MINUTES });
      const exists = await pool.query('SELECT 1 FROM users WHERE username = $1', [username]);
      if (exists.rows.length) return res.status(409).json({ error: `The username "${username}" is already taken.` });
      const hash = await bcrypt.hash(password, 12);
      await pool.query(
        `INSERT INTO users (username, password_hash, password_enc, must_change_password, minutes_limit, listened_seconds)
         VALUES ($1, $2, $3, TRUE, $4, 0)`,
        [username, hash, passwords.encrypt(password), accountMinutes]
      );
      res.json({ ok: true, username });
    } catch (e) { next(e); }
  });

  const userId = (req) => (/^\d+$/.test(req.params.id) ? Number(req.params.id) : null);

  app.post('/api/admin/users/:id/active', async (req, res, next) => {
    try {
      const id = userId(req);
      if (id === req.user.id) return res.status(400).json({ error: 'You cannot disable your own account.' });
      const active = req.body.active === true;
      const r = await pool.query('UPDATE users SET is_active = $1 WHERE id = $2', [active, id]);
      if (!r.rowCount) return res.status(404).json({ error: 'User not found.' });
      if (!active) await pool.query('DELETE FROM auth_sessions WHERE user_id = $1', [id]);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  app.post('/api/admin/users/:id/password', async (req, res, next) => {
    try {
      const id = userId(req);
      if (id === req.user.id) return res.status(400).json({ error: 'Use Change password for your own account.' });
      const password = String(req.body.password || '');
      const bad = checkPassword(password);
      if (bad) return res.status(400).json({ error: bad });
      const hash = await bcrypt.hash(password, 12);
      const r = await pool.query(
        `UPDATE users SET password_hash = $1, password_enc = $2, must_change_password = TRUE, failed_logins = 0, locked_until = NULL
         WHERE id = $3`,
        [hash, passwords.encrypt(password), id]
      );
      if (!r.rowCount) return res.status(404).json({ error: 'User not found.' });
      await pool.query('DELETE FROM auth_sessions WHERE user_id = $1', [id]);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  /* Sets the account's total listening minutes (used minutes are kept). */
  app.post('/api/admin/users/:id/minutes-limit', async (req, res, next) => {
    try {
      if (req.body.minutesLimit == null || req.body.minutesLimit === '') return res.status(400).json({ error: BAD_MINUTES });
      const limit = parseAccountMinutes(req.body.minutesLimit);
      if (limit == null) return res.status(400).json({ error: BAD_MINUTES });
      const r = await pool.query('UPDATE users SET minutes_limit = $1 WHERE id = $2 AND NOT is_admin', [limit, userId(req)]);
      if (!r.rowCount) {
        const found = await pool.query('SELECT is_admin FROM users WHERE id = $1', [userId(req)]);
        if (found.rows[0]) return res.status(400).json({ error: 'Admin accounts have unlimited minutes.' });
        return res.status(404).json({ error: 'User not found.' });
      }
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  app.post('/api/admin/sessions/:id/minutes', async (req, res, next) => {
    try {
      if (!ID_RE.test(req.params.id)) return res.status(404).json({ error: 'Session not found.' });
      const add = Number(req.body.minutes);
      if (!Number.isInteger(add) || add < 1 || add > MAX_ADD_MINUTES) {
        return res.status(400).json({ error: `Add a whole number of minutes from 1 to ${MAX_ADD_MINUTES}.` });
      }
      const r = await pool.query(
        'UPDATE sessions SET extra_listen_minutes = extra_listen_minutes + $1 WHERE id = $2 RETURNING extra_listen_minutes',
        [add, req.params.id]
      );
      if (!r.rowCount) return res.status(404).json({ error: 'Session not found.' });
      res.json({ ok: true, limitMinutes: Math.round((maxMinutes + r.rows[0].extra_listen_minutes) * 10) / 10 });
    } catch (e) { next(e); }
  });

  app.get('/api/admin/usage.csv', async (req, res, next) => {
    try {
      const users = await usageReport(maxMinutes, { withPasswords: true });
      const rows = [[
        'username', 'password', 'status', 'admin', 'last_login_utc', 'sessions', 'questions_today', 'questions_total',
        'account_minutes_used', 'account_minutes_limit', 'session_name', 'session_created_utc',
        'session_listening_minutes', 'session_limit_minutes', 'session_ended',
      ]];
      for (const u of users) {
        const base = [
          u.username, u.password, u.isActive ? 'active' : 'disabled', u.isAdmin ? 'yes' : 'no', u.lastLoginAt || '',
          u.sessionCount, u.questionsToday, u.questionsTotal, u.minutesUsed, u.minutesLimit == null ? 'unlimited' : u.minutesLimit,
        ];
        if (!u.sessions.length) rows.push([...base, '', '', '', '', '']);
        for (const s of u.sessions) {
          rows.push([...base, s.name, s.createdAt, s.listenedMinutes, s.limitMinutes, s.ended ? 'yes' : 'no']);
        }
      }
      res.set({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="interview-copilot-usage-${today()}.csv"`,
        'Cache-Control': 'no-store',
      });
      res.send('﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n'));
    } catch (e) { next(e); }
  });
}

module.exports = { routes };
