# Interview Copilot

Private, login-only app: sessions with a resume and job description, live listening to a
shared Chrome tab, streaming answers from Claude, a saved transcript per session, and an
admin page for accounts and usage.

## Setup

Requires Node.js 20 or newer and a Postgres database (a free Neon project works).
Use Chrome on a laptop or desktop. In Windows PowerShell, use `npm.cmd` instead of `npm`.

1. `npm.cmd install`
2. Copy `.env.example` to `.env` and fill it in (see the table below).
3. `npm.cmd start`, then open http://localhost:3000 and log in with `ADMIN_USER` / `ADMIN_PASSWORD`.

On first start the server creates its tables and the admin account.

## Deploy on Render

The repo includes `render.yaml`, so Render can set everything up from it.

1. Push this repo to GitHub (`.env` is ignored and never uploaded).
2. In Render: **New**, then **Blueprint**, and pick the repo.
3. Render asks for the secret values. Use the same ones as your local `.env`:
   `ANTHROPIC_API_KEY`, `DEEPGRAM_API_KEY`, `DATABASE_URL`, `SESSION_SECRET` (must match, or the
   passwords in the admin CSV become unreadable), `ADMIN_USER`, `ADMIN_PASSWORD`.
4. Deploy. Open the `https://….onrender.com` address and log in.

`render.yaml` already sets `NODE_ENV=production` (Secure cookies over HTTPS), `HOST=0.0.0.0`, and
Node 22. The local app and the hosted app share the same Neon database, so accounts and sessions
are the same in both. The free plan sleeps after 15 minutes idle (the first visit then takes
about a minute); change `plan` to `starter` in `render.yaml` to keep it awake.

### .env variables

| Variable | Required | What it is |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | yes | From console.anthropic.com. |
| `DEEPGRAM_API_KEY` | for listening | From console.deepgram.com (Settings, then API Keys). Typed questions work without it. |
| `DATABASE_URL` | yes | Postgres connection string. In Neon: Dashboard, then Connect. Use `sslmode=verify-full` at the end to avoid a warning from the `pg` library. |
| `SESSION_SECRET` | yes | Signs login cookies. At least 32 random characters. Make one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Changing it logs everyone out and makes stored passwords in the admin CSV unreadable until reset. |
| `ADMIN_USER` | first run | Admin username (3 to 40 letters, numbers, `.`, `-`, `_`). |
| `ADMIN_PASSWORD` | first run | Admin password, at least 10 characters. Only read when the admin is first created; changing it later does nothing. |
| `SESSION_MAX_MINUTES` | no | Listening minutes allowed per session. Default 60. (Account minutes are set per user in the Admin console.) |
| `NODE_ENV` | no | Set to `production` only when served over HTTPS. Makes login cookies Secure. |
| `HOST` | no | Default `127.0.0.1` (this computer only). Set `0.0.0.0` when running behind a hosting proxy. |
| `PORT` | no | Default 3000. |
| `MODEL_SHORT`, `MODEL_LONG` | no | Claude models for short and long answers. |

## Accounts

- There is no sign-up. The admin creates each account in the **Admin console** with a username
  and a temporary password. The person must choose their own password on first login.
- Click your name at the bottom of the sidebar to open **Profile**: your minutes, sessions (with
  minutes and questions per session, and an **Open** link), questions asked, **Change password**,
  and **Log out**. Admins also get an **Admin console** button there.
- 5 wrong passwords lock that username for 15 minutes. Each IP address gets 20 login attempts
  per 15 minutes. Anyone inactive for 8 hours is logged out.
- Each person sees only their own sessions and transcripts.

## Use it live

1. Join your interview in one Chrome tab (Meet, or the web version of Zoom or Teams).
2. Open Interview Copilot in a second Chrome tab and pick the session for that interview.
3. Click **Start listening**. In Chrome's picker, choose the Tab with the interview and
   check **Also share tab audio**.
4. When the interviewer asks a question, the answer appears on its own. Each answer shows
   "First words in N ms" so you can see the real latency.
5. When the interview is over, click the red **End session**. Listening and new questions stop
   for good; the history and **Download .txt** stay available.

Controls:
- **Auto / Short / Long** sets the answer length. Auto picks from the question type.
- **Auto-answer** off means it only shows what it heard, with an **Answer this** button.
- You can still type a question at the bottom at any time.
- Only the tab's audio (the interviewer) is captured. Your own microphone is not.
- Recognition is tuned per session: when a session is created, up to 50 technical terms are taken
  from the job description (e.g. S/4HANA, CPI, iFlow, OData) and sent to Deepgram as keyterms, so
  they are transcribed correctly. Hover over **Start listening** to see them.

Limits (only live listening counts; typed questions are unlimited):
- **Account minutes:** each account has a total allowance of listening minutes (default 100,
  set per person by the admin; it does not reset on its own). A bar under the question box shows
  "20 / 100 min used" and fills as minutes are used. Deleting a session does not give minutes back.
  Admin accounts have unlimited account minutes.
- **Per session:** each session can listen for `SESSION_MAX_MINUTES` (default 60). The admin can
  add minutes to a session.
- Listening stops at whichever runs out first. The live strip warns at 5 minutes left. Typed
  questions keep working after either limit.

## Transcript

Every question and suggested answer is saved as it finishes (a partial answer if it was
interrupted), along with live lines that were heard but not answered. Opening a session
loads its history. **Download .txt** saves it as `<session-name>-<date>.txt`:

```
Session: Acme, SAP BTP Engineer
Date: 2026-09-24
Exported: 2026-09-24 10:45:12

[10:32:05] INTERVIEWER: <question>
[10:32:07] SUGGESTED ANSWER (long): <answer>
```

The transcript holds what the interviewer said (as transcribed) and the answers the app
suggested, not what you actually said. Deleting a session deletes its transcript.

## Admin console

Admins open the **Admin console** (`/admin`) from their Profile page. It can:
- create users (with their account minutes), disable or enable them, reset passwords, and change
  each user's account minutes;
- show each user's last login, session count, questions today and total, and account minutes
  used / limit, with per-session listening minutes and an **Add minutes** button per session;
- download all of this as CSV.

It shows usage counts only: never resume text, job description text, questions, or answers.

The CSV download also has each user's **current password** (the temporary one the admin set, or
the one the user changed it to). The Change password page tells users "Your admin can see this
password." Passwords are stored encrypted with a key derived from `SESSION_SECRET`; if you change
`SESSION_SECRET`, or for accounts created before this feature, the CSV shows
"unknown - reset to see" until that password is next set or reset. Keep the CSV private.

## Notes

- Answers are grounded in the resume. Missing details become placeholders like
  `[add your real number]` instead of invented facts.
- Accounts, sessions (resume and job description), and transcripts are stored in the Postgres
  database in `DATABASE_URL`.
- Audio is streamed to Deepgram for transcription, and transcribed questions plus the
  resume and job description go to Anthropic.
