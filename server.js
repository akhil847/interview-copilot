require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const pkg = require('@anthropic-ai/sdk');
const Anthropic = pkg.default || pkg;
const pdfParse = require('pdf-parse/lib/pdf-parse.js');

for (const k of ['DATABASE_URL', 'SESSION_SECRET']) {
  if (!process.env[k]) {
    console.error(`${k} is missing. Add it to your .env file and start again (see README).`);
    process.exit(1);
  }
}
if (process.env.SESSION_SECRET.length < 32) {
  console.error('SESSION_SECRET must be at least 32 characters. See README for how to make one.');
  process.exit(1);
}

const db = require('./db');
const auth = require('./auth');
const admin = require('./admin');
const keyterms = require('./keyterms');
const { pool, ID_RE } = db;

const PORT = process.env.PORT || 3000;
const MODEL_SHORT = process.env.MODEL_SHORT || 'claude-haiku-4-5-20251001';
const MODEL_LONG = process.env.MODEL_LONG || 'claude-sonnet-5';
const HOST = process.env.HOST || '127.0.0.1';
const SESSION_MAX_MINUTES = Number(process.env.SESSION_MAX_MINUTES) > 0 ? Number(process.env.SESSION_MAX_MINUTES) : 60;
const LISTEN_LIMIT_MSG = 'Listening limit reached for this session';
const ACCOUNT_LIMIT_MSG = 'Your account has no listening minutes left. Ask the admin for more.';
const DG_KEY = process.env.DEEPGRAM_API_KEY;
const DG_URL =
  process.env.DEEPGRAM_URL ||
  'wss://api.deepgram.com/v1/listen?' +
    new URLSearchParams({
      model: 'nova-3',
      language: 'en',
      smart_format: 'true',
      interim_results: 'true',
      endpointing: '350',
      utterance_end_ms: '1000',
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '1',
    }).toString();

const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

/* ---------- login: only /login and /api/login are public ---------- */

auth.publicRoutes(app);
app.use(auth.requireLogin);
auth.accountRoutes(app);
admin.routes(app, { maxMinutes: SESSION_MAX_MINUTES });
app.use(express.static(path.join(__dirname, 'public')));

/* ---------- interview sessions (each user sees only their own) ---------- */

const listenLimitSeconds = (s) => Math.round((SESSION_MAX_MINUTES + s.extra_listen_minutes) * 60);

async function readSession(id, userId) {
  if (!ID_RE.test(String(id || ''))) return null;
  const { rows } = await pool.query('SELECT * FROM sessions WHERE id = $1 AND user_id = $2', [id, userId]);
  return rows[0] || null;
}

const sessionJson = (s) => ({
  id: s.id,
  name: s.name,
  resume: s.resume,
  jd: s.jd,
  createdAt: new Date(s.created_at).toISOString(),
  listenedSeconds: s.listened_seconds,
  listenLimitSeconds: listenLimitSeconds(s),
  endedAt: s.ended_at ? new Date(s.ended_at).toISOString() : null,
  keyterms: parseKeyterms(s.keyterms),
});

function parseKeyterms(stored) {
  try { return stored ? JSON.parse(stored) : []; } catch (e) { return []; }
}

const ENDED_MSG = 'This session has ended. Download the transcript, or start a new session.';

/* Technical terms from the JD, sent to Deepgram so they are transcribed correctly.
   Worked out once per session and saved; older sessions get them on first listen. */
async function sessionKeyterms(session) {
  if (session.keyterms) return parseKeyterms(session.keyterms);
  const terms = await keyterms.extract(session.jd, client, MODEL_SHORT);
  await pool.query('UPDATE sessions SET keyterms = $1 WHERE id = $2', [JSON.stringify(terms), session.id]);
  return terms;
}

app.get('/api/config', (req, res) => {
  res.json({ hasKey: Boolean(client), hasDeepgram: Boolean(DG_KEY), modelShort: MODEL_SHORT, modelLong: MODEL_LONG });
});

app.get('/api/sessions', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, created_at, ended_at FROM sessions WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json(rows.map((s) => ({
      id: s.id,
      name: s.name,
      createdAt: new Date(s.created_at).toISOString(),
      ended: Boolean(s.ended_at),
    })));
  } catch (e) { next(e); }
});

app.post('/api/sessions', async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim().slice(0, 80);
    const resume = String(req.body.resume || '').trim();
    const jd = String(req.body.jd || '').trim();
    if (!name) return res.status(400).json({ error: 'Give the session a name, like "Acme, Senior Engineer".' });
    if (!resume) return res.status(400).json({ error: 'Add a resume: upload a file or paste the text.' });
    if (!jd) return res.status(400).json({ error: 'Add the job description.' });
    const { rows } = await pool.query(
      'INSERT INTO sessions (id, user_id, name, resume, jd) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [crypto.randomUUID(), req.user.id, name, resume, jd]
    );
    res.json(sessionJson(rows[0]));
    sessionKeyterms(rows[0]).catch((e) => console.error('Could not save keyterms:', e.message));
  } catch (e) { next(e); }
});

app.get('/api/sessions/:id', async (req, res, next) => {
  try {
    const s = await readSession(req.params.id, req.user.id);
    if (!s) return res.status(404).json({ error: 'Session not found.' });
    res.json(sessionJson(s));
  } catch (e) { next(e); }
});

/* Ends a session for good: no more listening or questions. History and download stay. */
app.post('/api/sessions/:id/end', async (req, res, next) => {
  try {
    const s = await readSession(req.params.id, req.user.id);
    if (!s) return res.status(404).json({ error: 'Session not found.' });
    await pool.query('UPDATE sessions SET ended_at = now() WHERE id = $1 AND ended_at IS NULL', [s.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.delete('/api/sessions/:id', async (req, res, next) => {
  try {
    if (!ID_RE.test(req.params.id)) return res.status(404).json({ error: 'Session not found.' });
    const r = await pool.query('DELETE FROM sessions WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Session not found.' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ---------- profile: the logged-in user's own account and usage ---------- */

app.get('/profile', (req, res) => res.sendFile(path.join(__dirname, 'views', 'profile.html')));

app.get('/api/profile', async (req, res, next) => {
  try {
    const uid = req.user.id;
    const [user, sessions, asked, total] = await Promise.all([
      pool.query('SELECT created_at, last_login_at FROM users WHERE id = $1', [uid]),
      pool.query(
        'SELECT id, name, created_at, listened_seconds, extra_listen_minutes, ended_at FROM sessions WHERE user_id = $1 ORDER BY created_at DESC',
        [uid]
      ),
      // Asked questions have a mode; lines only heard (never sent for an answer) do not.
      pool.query('SELECT session_id, COUNT(*) AS n FROM turns WHERE user_id = $1 AND mode IS NOT NULL GROUP BY session_id', [uid]),
      pool.query('SELECT COALESCE(SUM(questions), 0) AS n FROM usage_daily WHERE user_id = $1', [uid]),
    ]);
    const askedBy = new Map(asked.rows.map((r) => [r.session_id, Number(r.n)]));
    const u = user.rows[0];
    res.json({
      username: req.user.username,
      isAdmin: req.user.isAdmin,
      createdAt: new Date(u.created_at).toISOString(),
      lastLoginAt: u.last_login_at ? new Date(u.last_login_at).toISOString() : null,
      usedSeconds: req.user.listenedSeconds,
      limitSeconds: req.user.isAdmin ? null : req.user.minutesLimit * 60,
      questionsTotal: Number(total.rows[0].n),
      sessions: sessions.rows.map((s) => ({
        id: s.id,
        name: s.name,
        createdAt: new Date(s.created_at).toISOString(),
        listenedMinutes: Math.round((s.listened_seconds / 60) * 10) / 10,
        questions: askedBy.get(s.id) || 0,
        ended: Boolean(s.ended_at),
      })),
    });
  } catch (e) { next(e); }
});

/* ---------- saved transcript (turns) ---------- */

const SOURCES = ['live', 'typed'];

async function listTurns(sessionId) {
  const { rows } = await pool.query(
    'SELECT * FROM turns WHERE session_id = $1 ORDER BY asked_at, id',
    [sessionId]
  );
  return rows;
}

app.get('/api/sessions/:id/turns', async (req, res, next) => {
  try {
    const s = await readSession(req.params.id, req.user.id);
    if (!s) return res.status(404).json({ error: 'Session not found.' });
    const rows = await listTurns(s.id);
    res.json(rows.map((t) => ({
      id: t.id,
      askedAt: new Date(t.asked_at).toISOString(),
      source: t.source,
      question: t.question,
      answer: t.answer,
      mode: t.mode,
      firstWordsMs: t.first_words_ms,
    })));
  } catch (e) { next(e); }
});

/* A live line that was heard but not sent for an answer. */
app.post('/api/sessions/:id/heard', async (req, res, next) => {
  try {
    const s = await readSession(req.params.id, req.user.id);
    if (!s) return res.status(404).json({ error: 'Session not found.' });
    if (s.ended_at) return res.status(409).json({ error: ENDED_MSG });
    const question = String(req.body.question || '').trim().slice(0, 3000);
    if (!question) return res.status(400).json({ error: 'Nothing to save.' });
    const { rows } = await pool.query(
      `INSERT INTO turns (session_id, user_id, source, question) VALUES ($1, $2, 'live', $3) RETURNING id`,
      [s.id, req.user.id, question]
    );
    res.json({ id: rows[0].id });
  } catch (e) { next(e); }
});

/* Clock time in the viewer's time zone, e.g. 10:32:05. Falls back to the server's zone. */
function clock(date, tz) {
  const opts = { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' };
  try {
    return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: tz }).format(date);
  } catch (e) {
    return new Intl.DateTimeFormat('en-GB', opts).format(date);
  }
}

function isoDay(date, tz) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(date);
  } catch (e) {
    return new Intl.DateTimeFormat('en-CA').format(date);
  }
}

app.get('/api/sessions/:id/transcript.txt', async (req, res, next) => {
  try {
    const s = await readSession(req.params.id, req.user.id);
    if (!s) return res.status(404).json({ error: 'Session not found.' });
    const tz = String(req.query.tz || '').slice(0, 64) || undefined;
    const created = new Date(s.created_at);
    const now = new Date();
    const lines = [
      `Session: ${s.name}`,
      `Date: ${isoDay(created, tz)}`,
      `Exported: ${isoDay(now, tz)} ${clock(now, tz)}`,
      '',
    ];
    for (const t of await listTurns(s.id)) {
      lines.push(`[${clock(new Date(t.asked_at), tz)}] INTERVIEWER: ${t.question}`);
      if (t.answer) {
        const at = new Date(t.answered_at || t.asked_at);
        lines.push(`[${clock(at, tz)}] SUGGESTED ANSWER (${t.mode || 'short'}): ${t.answer}`);
      }
      lines.push('');
    }
    const safeName = s.name.replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/\s+/g, '-') || 'session';
    const filename = `${safeName}-${isoDay(created, tz)}.txt`;
    res.set({
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    });
    res.send(lines.join('\r\n'));
  } catch (e) { next(e); }
});

/* ---------- resume file -> text ---------- */

app.post('/api/extract', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file received.' });
    const name = (req.file.originalname || '').toLowerCase();
    let text = '';
    if (name.endsWith('.pdf')) {
      text = (await pdfParse(req.file.buffer)).text;
    } else if (name.endsWith('.txt') || name.endsWith('.md')) {
      text = req.file.buffer.toString('utf8');
    } else {
      return res.status(400).json({ error: 'Use a PDF, TXT, or MD file, or paste the text instead.' });
    }
    text = text.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) {
      return res.status(422).json({ error: 'No text found in that file. If it is a scan, paste the text instead.' });
    }
    res.json({ text });
  } catch (e) {
    res.status(500).json({ error: 'Could not read that file. Paste the text instead.' });
  }
});

/* ---------- answering ---------- */

const INSTRUCTIONS = `You are a live interview assistant. The candidate is in an interview right now, reads your answer on screen, and says it in their own words. Write exactly what they would say: first person, natural spoken English, no lead-in like "Great question", no meta commentary.

Rules:
- Base every claim on the RESUME. Never invent employers, projects, tools, titles, dates, or numbers. If the question needs a detail the resume does not contain, use the closest real experience and put a bracketed placeholder such as [add your real number] where a specific is needed.
- Emphasize what the JOB DESCRIPTION prioritizes, using its terms only where they truthfully match the resume.
- Technical questions: be accurate and concrete.
- Scenario or behavioral questions: follow situation, action, result, drawn from real experience in the resume.
- General knowledge questions the resume cannot cover: answer correctly and briefly.
- The question comes from live speech-to-text and may contain transcription errors. Infer the most likely intended question and answer that.`;

const FORMAT = {
  short:
    'FORMAT: SHORT. Reply with 3 to 5 bullet points, each under 15 words, written as speaking cues the candidate can expand on. Total under 70 words. Nothing before or after the bullets.',
  long:
    'FORMAT: LONG. Reply with a complete answer of about 150 to 250 words that takes 60 to 90 seconds to say, in short paragraphs. For scenario or behavioral questions, flow naturally through situation, action, and result without labels.',
};

const LONG_PATTERN =
  /(tell me about (a time|yourself)|walk me through|describe a (time|situation)|how would you (handle|approach|design|deal|prioriti[sz]e)|what would you do|give me an example|scenario|challenge you|conflict|failure|why should we hire|biggest (mistake|weakness))/;

function pickMode(question) {
  const q = question.toLowerCase();
  return LONG_PATTERN.test(q) || q.split(/\s+/).length > 25 ? 'long' : 'short';
}

function friendlyError(e) {
  if (e && e.status === 401) return 'The API key was rejected. Check ANTHROPIC_API_KEY in your .env file.';
  if (e && e.status === 404) return 'Model not found. Check MODEL_SHORT and MODEL_LONG in your .env file.';
  if (e && e.status === 429) return 'Rate limit reached. Wait a moment and ask again.';
  if (e && e.status === 400 && /credit/i.test(e.message || '')) return 'Out of API credits. Add credits in the Anthropic console.';
  return (e && e.message) || 'Something went wrong.';
}

const send = (res, event, data) => {
  if (!res.writableEnded && !res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
};

/* Saves one asked question and whatever answer text arrived (full, partial, or none).
   If it answers a line saved earlier by /heard, that row is filled in instead of adding a new one. */
async function saveTurn(session, userId, turn) {
  const answer = turn.answer || null;
  if (turn.heardId) {
    const r = await pool.query(
      `UPDATE turns SET answer = $1, mode = $2, first_words_ms = $3, answered_at = $4
       WHERE id = $5 AND session_id = $6 AND user_id = $7 AND answer IS NULL`,
      [answer, turn.mode, turn.firstMs, turn.answeredAt, turn.heardId, session.id, userId]
    );
    if (r.rowCount) return;
  }
  await pool.query(
    `INSERT INTO turns (session_id, user_id, asked_at, source, question, answer, mode, first_words_ms, answered_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [session.id, userId, turn.askedAt, turn.source, turn.question, answer, turn.mode, turn.firstMs, turn.answeredAt]
  );
}

app.post('/api/sessions/:id/ask', async (req, res, next) => {
  const askedAt = new Date();
  let session, question;
  try {
    session = await readSession(req.params.id, req.user.id);
    if (!session) return res.status(404).json({ error: 'Session not found.' });
    if (session.ended_at) return res.status(409).json({ error: ENDED_MSG });
    if (!client) return res.status(500).json({ error: 'ANTHROPIC_API_KEY is missing. Add it to your .env file and restart the server.' });

    question = String(req.body.question || '').trim();
    if (!question) return res.status(400).json({ error: 'Type or paste a question first.' });

    await db.countQuestion(req.user.id);
  } catch (e) {
    return next(e);
  }

  const requested = ['short', 'long', 'auto'].includes(req.body.mode) ? req.body.mode : 'auto';
  const mode = requested === 'auto' ? pickMode(question) : requested;
  const model = mode === 'long' ? MODEL_LONG : MODEL_SHORT;

  const messages = [];
  const history = Array.isArray(req.body.history) ? req.body.history.slice(-3) : [];
  for (const h of history) {
    if (h && h.q && h.a) {
      messages.push({ role: 'user', content: String(h.q).slice(0, 1500) });
      messages.push({ role: 'assistant', content: String(h.a).slice(0, 3000) });
    }
  }
  messages.push({ role: 'user', content: question.slice(0, 3000) });

  const system = [
    { type: 'text', text: INSTRUCTIONS },
    {
      type: 'text',
      text: `RESUME:\n${session.resume}\n\nJOB DESCRIPTION:\n${session.jd}`,
      cache_control: { type: 'ephemeral' },
    },
    { type: 'text', text: FORMAT[mode] },
  ];

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  send(res, 'meta', { mode, model });

  const stream = client.messages.stream({
    model,
    max_tokens: mode === 'long' ? 700 : 300,
    system,
    messages,
  });
  const turn = {
    askedAt,
    source: SOURCES.includes(req.body.source) ? req.body.source : 'typed',
    question: question.slice(0, 3000),
    heardId: Number.isInteger(req.body.turnId) ? req.body.turnId : null,
    mode,
    answer: '',
    firstMs: null,
    answeredAt: null,
  };
  res.on('close', () => {
    if (!res.writableEnded) stream.abort();
  });
  stream.on('text', (t) => {
    if (turn.firstMs == null) {
      turn.answeredAt = new Date();
      turn.firstMs = turn.answeredAt - askedAt;
    }
    turn.answer += t;
    send(res, 'delta', { text: t });
  });

  try {
    await stream.finalMessage();
    send(res, 'done', {});
  } catch (e) {
    send(res, 'error', { error: friendlyError(e) });
  }
  try {
    await saveTurn(session, req.user.id, turn);
  } catch (e) {
    console.error('Could not save to transcript:', e.message);
  }
  res.end();
});

app.use((err, req, res, next) => {
  console.error('Request failed:', err.message);
  if (res.headersSent) return res.end();
  res.status(500).json({ error: 'Something went wrong on the server. Try again.' });
});

/* ---------- live speech-to-text: browser audio -> Deepgram, transcripts back ---------- */

const wss = new WebSocket.Server({ noServer: true });

function rejectUpgrade(socket, code, text) {
  socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function sameOrigin(req) {
  try {
    return new URL(req.headers.origin).host === req.headers.host;
  } catch (e) {
    return false;
  }
}

/* /stt needs a valid login and a session owned by that user. */
async function onUpgrade(req, socket, head) {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/stt') return rejectUpgrade(socket, 404, 'Not Found');
    if (!sameOrigin(req)) return rejectUpgrade(socket, 403, 'Forbidden');
    const user = await auth.userFromRequest(req);
    if (!user || user.mustChangePassword) return rejectUpgrade(socket, 401, 'Unauthorized');
    const session = await readSession(url.searchParams.get('session'), user.id);
    if (!session) return rejectUpgrade(socket, 404, 'Not Found');
    // Don't hold up listening for more than 5 s; the simple extractor covers the gap.
    const terms = session.ended_at ? [] : await Promise.race([
      sessionKeyterms(session).catch(() => keyterms.heuristic(session.jd)),
      new Promise((resolve) => setTimeout(() => resolve(keyterms.heuristic(session.jd)), 5000)),
    ]);
    wss.handleUpgrade(req, socket, head, (ws) => handleStt(ws, session, user, terms));
  } catch (e) {
    rejectUpgrade(socket, 500, 'Internal Server Error');
  }
}

/* Listening stops at whichever runs out first: this session's limit or the account's minutes.
   Admin accounts have unlimited account minutes (the per-session limit still applies). */
function handleStt(browser, session, user, terms) {
  const tell = (obj) => {
    if (browser.readyState === WebSocket.OPEN) browser.send(JSON.stringify(obj));
  };
  browser.on('error', () => {});

  if (!DG_KEY) {
    tell({ type: 'error', error: 'DEEPGRAM_API_KEY is missing. Add it to your .env file and restart the server.' });
    return browser.close();
  }
  if (session.ended_at) {
    tell({ type: 'error', error: ENDED_MSG });
    return browser.close();
  }
  const accountLimitOf = (minutesLimit) => (user.isAdmin ? Infinity : minutesLimit * 60);
  const accountLimit = accountLimitOf(user.minutesLimit);
  const limitForClient = (limit) => (limit === Infinity ? null : limit);
  if (user.listenedSeconds >= accountLimit) {
    tell({ type: 'limit', error: ACCOUNT_LIMIT_MSG });
    return browser.close();
  }
  if (session.listened_seconds >= listenLimitSeconds(session)) {
    tell({ type: 'limit', error: LISTEN_LIMIT_MSG });
    return browser.close();
  }
  tell({
    type: 'usage',
    secondsLeft: Math.min(listenLimitSeconds(session) - session.listened_seconds, accountLimit - user.listenedSeconds),
    accountUsedSeconds: user.listenedSeconds,
    accountLimitSeconds: limitForClient(accountLimit),
  });

  // Listening time runs from connect to close and is saved every 5 seconds,
  // to both the session and the account.
  let counted = Date.now();
  async function tally() {
    const secs = Math.floor((Date.now() - counted) / 1000);
    if (secs <= 0) return null;
    counted += secs * 1000;
    const [s, u] = await Promise.all([
      pool.query(
        'UPDATE sessions SET listened_seconds = listened_seconds + $1 WHERE id = $2 RETURNING listened_seconds, extra_listen_minutes, ended_at',
        [secs, session.id]
      ),
      pool.query(
        'UPDATE users SET listened_seconds = COALESCE(listened_seconds, 0) + $1 WHERE id = $2 RETURNING minutes_limit, listened_seconds',
        [secs, user.id]
      ),
    ]);
    return s.rows[0] && u.rows[0] ? { s: s.rows[0], u: u.rows[0] } : null;
  }
  const meter = setInterval(async () => {
    try {
      const row = await tally();
      if (!row) return;
      if (row.s.ended_at) {
        tell({ type: 'error', error: ENDED_MSG });
        return browser.close();
      }
      const sessionLeft = listenLimitSeconds(row.s) - row.s.listened_seconds;
      const accountLimitNow = accountLimitOf(row.u.minutes_limit);
      const accountLeft = accountLimitNow - row.u.listened_seconds;
      tell({
        type: 'usage',
        secondsLeft: Math.max(0, Math.min(sessionLeft, accountLeft)),
        accountUsedSeconds: row.u.listened_seconds,
        accountLimitSeconds: limitForClient(accountLimitNow),
      });
      if (accountLeft <= 0) {
        tell({ type: 'limit', error: ACCOUNT_LIMIT_MSG });
        browser.close();
      } else if (sessionLeft <= 0) {
        tell({ type: 'limit', error: LISTEN_LIMIT_MSG });
        browser.close();
      }
    } catch (e) {}
  }, 5000);

  const dg = new WebSocket(keyterms.withKeyterms(DG_URL, terms), { headers: { Authorization: `Token ${DG_KEY}` } });
  const queue = [];
  let keepAlive = null;

  dg.on('open', () => {
    queue.splice(0).forEach((chunk) => dg.send(chunk));
    keepAlive = setInterval(() => {
      if (dg.readyState === WebSocket.OPEN) dg.send(JSON.stringify({ type: 'KeepAlive' }));
    }, 5000);
  });
  dg.on('message', (data, isBinary) => {
    if (browser.readyState === WebSocket.OPEN) browser.send(isBinary ? data : data.toString());
  });
  dg.on('unexpected-response', (req, res) => {
    tell({
      type: 'error',
      error:
        res.statusCode === 401 || res.statusCode === 403
          ? 'Deepgram rejected the key. Check DEEPGRAM_API_KEY in your .env file.'
          : `Deepgram connection failed (status ${res.statusCode}).`,
    });
    browser.close();
  });
  dg.on('error', () => {});
  dg.on('close', () => {
    clearInterval(keepAlive);
    if (browser.readyState === WebSocket.OPEN) browser.close();
  });

  browser.on('message', (data, isBinary) => {
    if (!isBinary) return;
    if (dg.readyState === WebSocket.OPEN) dg.send(data);
    else if (dg.readyState === WebSocket.CONNECTING) queue.push(data);
  });
  browser.on('close', () => {
    clearInterval(meter);
    clearInterval(keepAlive);
    tally().catch(() => {});
    if (dg.readyState === WebSocket.OPEN) {
      try { dg.send(JSON.stringify({ type: 'CloseStream' })); } catch (e) {}
    }
    try { dg.close(); } catch (e) {}
  });
}

/* ---------- start ---------- */

async function start() {
  await db.init();
  await db.ensureAdmin();
  await auth.cleanup();
  setInterval(() => auth.cleanup().catch(() => {}), 60 * 60 * 1000).unref();

  const server = app.listen(PORT, HOST, () => {
    console.log(`Interview Copilot running at http://localhost:${PORT}`);
    if (!client) console.log('Warning: ANTHROPIC_API_KEY is not set. Add it to .env before asking questions.');
    if (!DG_KEY) console.log('Warning: DEEPGRAM_API_KEY is not set. Live listening needs it. Typing questions still works.');
  });
  server.on('upgrade', onUpgrade);
}

start().catch((e) => {
  console.error('Could not start: ' + e.message);
  process.exit(1);
});
