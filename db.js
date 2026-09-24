const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const passwords = require('./passwords');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const USERNAME_RE = /^[a-z0-9._-]{3,40}$/;
const normUsername = (u) => String(u || '').trim().toLowerCase();

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  must_change_password BOOLEAN NOT NULL DEFAULT TRUE,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  resume TEXT NOT NULL,
  jd TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  listened_seconds INTEGER NOT NULL DEFAULT 0,
  extra_listen_minutes INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS keyterms TEXT;
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS login_events (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  username TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  success BOOLEAN NOT NULL
);
CREATE TABLE IF NOT EXISTS turns (
  id SERIAL PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  asked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source TEXT NOT NULL CHECK (source IN ('live', 'typed')),
  question TEXT NOT NULL,
  answer TEXT,
  mode TEXT,
  first_words_ms INTEGER,
  answered_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS turns_session_idx ON turns (session_id);
CREATE TABLE IF NOT EXISTS usage_daily (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  questions INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS minutes_limit INTEGER NOT NULL DEFAULT 100;
ALTER TABLE users ADD COLUMN IF NOT EXISTS listened_seconds INTEGER;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_enc TEXT;
`;

async function init() {
  await pool.query(SCHEMA);
  // Account listening time is kept on the user (not summed from sessions), so deleting a
  // session does not give minutes back. Existing accounts start from their sessions' totals.
  const { rows } = await pool.query('SELECT id FROM users WHERE listened_seconds IS NULL');
  for (const u of rows) {
    const s = await pool.query('SELECT COALESCE(SUM(listened_seconds), 0) AS total FROM sessions WHERE user_id = $1', [u.id]);
    await pool.query('UPDATE users SET listened_seconds = $1 WHERE id = $2', [Number(s.rows[0].total), u.id]);
  }
  await pool.query('ALTER TABLE users ALTER COLUMN listened_seconds SET DEFAULT 0');
}

/* Creates the admin from ADMIN_USER / ADMIN_PASSWORD the first time. Returns the admin's id. */
async function ensureAdmin() {
  const existing = await pool.query('SELECT id FROM users WHERE is_admin ORDER BY id LIMIT 1');
  if (existing.rows.length) return existing.rows[0].id;
  const username = normUsername(process.env.ADMIN_USER);
  const password = process.env.ADMIN_PASSWORD || '';
  if (!username || !password) {
    throw new Error('No admin account exists yet. Set ADMIN_USER and ADMIN_PASSWORD in .env, then start again.');
  }
  if (!USERNAME_RE.test(username)) {
    throw new Error('ADMIN_USER must be 3 to 40 characters: letters, numbers, dot, dash, or underscore.');
  }
  if (password.length < 10) throw new Error('ADMIN_PASSWORD must be at least 10 characters.');
  const hash = await bcrypt.hash(password, 12);
  const r = await pool.query(
    'INSERT INTO users (username, password_hash, password_enc, is_admin, must_change_password) VALUES ($1, $2, $3, TRUE, FALSE) RETURNING id',
    [username, hash, passwords.encrypt(password)]
  );
  console.log(`Created admin account "${username}".`);
  return r.rows[0].id;
}

/* Local calendar day, for the "questions today" count on the admin page. */
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* Counts one question for the admin's usage table (questions are not limited). */
async function countQuestion(userId) {
  await pool.query(
    `INSERT INTO usage_daily (user_id, day, questions) VALUES ($1, $2, 1)
     ON CONFLICT (user_id, day) DO UPDATE SET questions = usage_daily.questions + 1`,
    [userId, today()]
  );
}

module.exports = { pool, init, ensureAdmin, countQuestion, today, normUsername, ID_RE, USERNAME_RE };
