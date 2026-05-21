# CLAUDE.md

Context file for Claude (and other AI coding assistants) working on this repository.

Read this first before making any changes. Code examples below are concrete — follow the existing patterns rather than introducing new ones.

---

## 1. What this project is

**Plan Forge** is a dockerized web app that generates project-management artifacts (charters, Gantt timelines, RACI matrices, risk registers, retros, etc.) using the Anthropic API, and saves them to a per-user archive.

Users sign up, pick an artifact type from a dropdown, fill in contextual fields, and click generate. The backend calls Claude with a task-specific prompt, saves the generated markdown to Postgres, and returns it for rendering. Past artifacts live in a sidebar and can be reopened, copied, downloaded, or deleted.

**It is not:**
- A project management tool (no tasks, no Kanban, no real scheduling)
- Multi-tenant/team software (no workspaces, no sharing)
- Production-ready (see §10 for what's missing)

It's a single-user productivity tool you run locally or on a private box.

---

## 2. Tech stack

| Layer        | Choice                     | Why                                              |
|--------------|----------------------------|--------------------------------------------------|
| Frontend     | Vanilla HTML/CSS/JS        | No build step. Simple. One file per concern.     |
| Markdown     | `marked` v11               | Fast, permissive, good defaults                  |
| Diagrams     | `mermaid` v10              | For Gantt charts + quadrant charts in output     |
| Syntax HL    | `highlight.js` v11         | Code blocks in output                            |
| Backend      | Node 20 (slim) + Express 4 | Small surface area. **slim, not alpine** — onnxruntime-node needs glibc |
| Auth         | JWT (7-day) + bcryptjs     | Standard stateless auth                          |
| Database     | **PostgreSQL 16 + pgvector** | JSONB for `inputs`, `vector(384)` for embeddings |
| Web server   | nginx (alpine)             | Static + `/api/*` reverse proxy. **100 MB upload, 600 s LLM timeout.** |
| Orchestration| Docker Compose             | Three services: `db` (pgvector), `backend`, `frontend` |
| Agents       | **`@langchain/langgraph`** | 5-node pipeline (Retriever → Planner → Drafter → Critic → Refiner) wrapped around `callLLM()` |
| Embeddings   | **`@xenova/transformers`** running `all-MiniLM-L6-v2` locally | 384-dim, no API key, runs in-process |
| LLM          | Claude API / OpenAI / Gemini / Claude CLI (OAuth) | All four pluggable through `callLLM()` in `server.js` |

No frontend framework. No ORM. No build system. **Keep it that way unless there's a strong reason.**

**Agent layer.** Every `POST /api/artifacts` first tries the 5-stage LangGraph pipeline. On any node error it falls back to the legacy single-call generator so the user never sees a broken request. Toggle with `USE_AGENTS` (default `true`). The RAG retriever pulls top-3 cosine-similar past artifacts (per-user, same-type-first) as in-context examples. See `backend/src/agents.js` and `backend/src/embeddings.js`. Full handoff doc: `docs/PLAN_FORGE_ARCHITECTURE.md` (+ `.docx`).

---

## 3. Repository layout

```
plan-forge/
├─ docker-compose.yml       # 3 services: db, backend, frontend
├─ .env.example             # user copies to .env — holds secrets
├─ README.md                # user-facing setup docs
├─ CLAUDE.md                # this file
│
├─ backend/
│  ├─ Dockerfile            # node:20-alpine + npm install --omit=dev
│  ├─ package.json          # only 5 deps; keep it lean
│  ├─ .dockerignore
│  ├─ db/
│  │  └─ init.sql           # mounted read-only into pg container, runs on first boot ONLY
│  └─ src/
│     ├─ server.js          # express app, all routes, boot sequence
│     ├─ db.js              # pg Pool, waitForDb(), ensureSchema()
│     └─ prompts.js         # PM artifact prompt catalog + system prompt
│
└─ frontend/
   ├─ Dockerfile            # nginx:1.27-alpine + static copy
   ├─ nginx.conf            # /api/* → backend:4000, / → static
   └─ html/
      ├─ index.html         # auth view + app view in one page
      ├─ styles.css         # blueprint aesthetic — see §7
      └─ app.js             # all client logic, self-contained IIFE
```

---

## 4. Architecture

```
Browser (http://localhost:8080)
   │
   ├─  GET /            → nginx → static index.html / styles.css / app.js
   └─  /api/*           → nginx proxy → backend:4000 → postgres:5432
                                     → anthropic.com (from backend only)
```

**Key architectural decisions — don't break these without thinking:**

- **The Anthropic API key lives only in the backend container.** The frontend never sees it. All LLM calls are proxied through `POST /api/artifacts`.
- **Prompts live server-side** in `backend/src/prompts.js`. The client only sends `{artifact_type, inputs}`. This keeps prompts editable without a client redeploy and prevents users tampering with the system prompt.
- **Saves and generation are one call.** `POST /api/artifacts` generates AND persists in one request. No "save draft" flow. If the Anthropic call succeeds, we always save; if it fails, nothing is saved.
- **Auth is stateless.** JWT in `Authorization: Bearer <token>` header. No server-side sessions, no refresh tokens. Token expires after 7 days and the user signs in again.
- **Schema source of truth is `db.js`.** `init.sql` only runs on first-ever boot of the `pgdata` volume. If you change the schema, update BOTH `init.sql` AND the `ensureSchema()` block in `db.js` — the latter runs on every backend boot and is idempotent (`CREATE TABLE IF NOT EXISTS`).

---

## 5. Database schema

```sql
users (
  id             SERIAL PRIMARY KEY,
  email          VARCHAR(255) UNIQUE NOT NULL,   -- always stored lowercased
  password_hash  VARCHAR(255) NOT NULL,           -- bcryptjs, 10 rounds
  name           VARCHAR(255),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
)

artifacts (
  id             SERIAL PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  artifact_type  VARCHAR(64) NOT NULL,            -- must be in VALID_TYPES (prompts.js)
  title          VARCHAR(255) NOT NULL,           -- inferred from inputs, see inferTitle()
  inputs         JSONB NOT NULL,                   -- the form fields the user filled
  content        TEXT NOT NULL,                    -- generated markdown (may include ```mermaid blocks)
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
)

INDEX idx_artifacts_user_created ON artifacts(user_id, created_at DESC)
INDEX idx_artifacts_type         ON artifacts(artifact_type)
```

**Why JSONB for `inputs`?** Artifact types have different shapes (project_plan has `team_size`, timeline has `start_date`, etc). We didn't want a column per possible input across all types, and we never query inside `inputs` — we just store, retrieve, and repopulate the form. JSONB gives us validation at insert time and room to evolve.

**There is no migration tool.** If you add a column:
1. Add it to `backend/db/init.sql` (for new installs)
2. Add an `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` in `ensureSchema()` in `db.js` (for existing installs)
3. Backfill manually if needed

---

## 6. API reference

All routes under `/api`. Routes marked 🔒 require `Authorization: Bearer <jwt>`.

| Method | Path                    | Body / Notes                                             |
|--------|-------------------------|----------------------------------------------------------|
| `GET`  | `/api/health`           | `{ok: true, db: "up"}`                                   |
| `POST` | `/api/auth/signup`      | `{email, password, name?}` → `{token, user}`             |
| `POST` | `/api/auth/login`       | `{email, password}` → `{token, user}`                    |
| 🔒 `GET`  | `/api/auth/me`          | Returns current user profile                             |
| 🔒 `GET`  | `/api/artifacts`        | Returns `{artifacts: [{id, artifact_type, title, created_at}]}` (metadata only, ordered newest first, limit 200) |
| 🔒 `GET`  | `/api/artifacts/:id`    | Full artifact incl. `inputs` and `content`               |
| 🔒 `POST` | `/api/artifacts`        | `{artifact_type, title?, inputs}` — generates + saves. Returns full artifact. |
| 🔒 `DELETE` | `/api/artifacts/:id` | Hard delete                                              |

**Authorization rule:** users can only see/modify their own artifacts. Every artifact query is filtered by `user_id = req.user.sub`. Never loosen this.

**Error shape:** All errors return `{error: "string"}` with an appropriate status. Some include `detail`.

---

## 7. Frontend conventions

**Design system source of truth: [`plan-forge/design-system/plan-forge/MASTER.md`](plan-forge/design-system/plan-forge/MASTER.md).** That file is authoritative for colors, typography, spacing, motion, anti-patterns, and the pre-delivery checklist. Read it before changing any visual code. The notes below are a fast summary — when this file and `MASTER.md` disagree, MASTER.md wins.

**Themes:** Three are supported — `light` (default), `dark`, `midnight`. Every color must come from a CSS custom property defined in `styles.css:5-131`, never a hardcoded hex in component styles. Test all three themes before merging visual changes.

**Fonts (Google Fonts, loaded in `index.html`):**
- `DM Serif Display` — display headings (H1/H2 in rendered output, brand wordmark)
- `Work Sans` — UI body, paragraphs in rendered markdown
- `JetBrains Mono` — technical labels, panel heads, code, tables, all metadata

Do not add a fourth font family. If you need another visual register, vary weight or size of an existing family.

**Panel pattern.** Every card uses `.panel` + corner tick-marks:
```html
<div class="panel">
  <span class="tick-bl"></span><span class="tick-br"></span>
  <div class="panel-head">
    <span><span class="fig">01</span> · Title</span>
    <span>meta</span>
  </div>
  <div class="panel-body">…</div>
</div>
```
The `::before` / `::after` pseudo-elements make the top-left/top-right corner ticks; the two `<span>`s explicitly handle the bottom corners. All four together give the blueprint vignette.

**JS style.** `app.js` is a single IIFE with `'use strict'`. No module bundler. Use:
- `const $ = (id) => document.getElementById(id)` — the project's shorthand
- Template literals for HTML — always run user-supplied strings through `escapeHtml()`
- `async/await` with `try/catch` around anything that calls `api()`
- The `api()` helper at the top of `app.js` — attaches the JWT and handles 401 by auto-logging-out. Always route API calls through it.

**Local storage.** Token and user cached under `planforge_token` / `planforge_user`. Don't add other localStorage keys without a reason.

---

## 8. How to add a new artifact type

This is the most common change. Do these 3 edits together or it won't work:

1. **`backend/src/prompts.js`** — add a key to `INSTRUCTIONS`. This is the task-specific prompt that produces the markdown. Follow the existing pattern: section headers, tables or mermaid blocks where useful, concrete not vague.

2. **`frontend/html/app.js`** — add the same key to `SCHEMAS` with its form fields, and add a human-readable name to `TYPE_LABEL` (used by the archive sidebar).

3. **`frontend/html/index.html`** — add an `<option value="your_key">` to `#gen-type`.

That's it. `VALID_TYPES` in `prompts.js` auto-derives from `Object.keys(INSTRUCTIONS)`, and the backend validates against it.

**Field types supported** in `SCHEMAS[type].fields[]`:
- `text` — single line
- `number` — numeric input
- `textarea` — multiline
- `select` with `options: []` — dropdown

Every field needs `{id, label, type}` and optionally `{placeholder, required, options}`. Field `id` becomes the key in the stored `inputs` JSONB.

---

## 9. How to run and debug

```bash
# from-scratch boot (first time, or after down -v)
cp .env.example .env        # fill in ANTHROPIC_API_KEY and JWT_SECRET
docker compose up --build

# iterate on backend (rebuilds only the one service)
docker compose up -d --build backend

# iterate on frontend (static files — fastest)
docker compose up -d --build frontend

# watch logs
docker compose logs -f backend
docker compose logs -f db

# reset database completely (wipes users + artifacts)
docker compose down -v

# psql shell
docker compose exec db psql -U planforge -d planforge

# quick checks
curl http://localhost:8080/api/health
curl -X POST http://localhost:8080/api/auth/signup \
  -H 'Content-Type: application/json' \
  -d '{"email":"test@example.com","password":"test123","name":"Test"}'
```

**If generation fails:** check backend logs. Common causes:
- `ANTHROPIC_API_KEY missing` — the `.env` wasn't loaded. Ensure `.env` lives next to `docker-compose.yml`.
- `anthropic api error: 401` — key is invalid.
- `anthropic api error: 429` — rate limited. Wait, or reduce parallelism.
- Empty response — raise `max_tokens` in `server.js` (currently `2500`).

**If the frontend can't reach the backend:** check `frontend/nginx.conf` — `proxy_pass http://backend:4000` must match the service name in `docker-compose.yml`.

---

## 10. What's deliberately NOT done (do not assume these exist)

This is a dev-grade app. The following are intentionally missing and should not be assumed present:

- **Rate limiting** on any endpoint. A signup/login flood would hammer the DB and Anthropic budget.
- **Email verification** or password reset. Typos in signup email are permanent.
- **Refresh tokens.** The 7-day JWT is all there is. After expiry, re-login.
- **CSRF protection.** Tokens live in localStorage (not cookies), so CSRF is low-risk, but worth keeping in mind before adding cookie-based auth.
- **CORS lockdown.** `cors()` is wide open. Fine for single-origin deployment; tighten if exposed publicly.
- **HTTPS.** Bring your own reverse proxy (Caddy, Traefik, nginx with certbot).
- **Streaming responses.** The LLM call is non-streaming — the user sees the "drafting" animation for 10–20s, then the result lands all at once. Good enough for now.
- **Per-user cost controls / quotas.** A user could generate unlimited artifacts on your API key. Add a quota check before `fetch('anthropic')` if multi-user.
- **Audit log.** Deletions are hard deletes with no record.
- **Backups.** Run `pg_dump` yourself.
- **Multi-tenant workspaces / sharing.** Every artifact is private to its creator.

If a user asks for any of these, treat it as a real feature request and design it properly — don't stub.

---

## 11. Safety & correctness rules

- **Never log passwords or full request bodies** on `/api/auth/*` routes.
- **Never return `password_hash`** from any endpoint. The existing code is careful about this; preserve it.
- **Always filter artifact queries by `user_id`.** Missing this in a new endpoint is an IDOR vulnerability.
- **Always validate `artifact_type`** against `VALID_TYPES` before using it. Prevents prompt injection via unknown types.
- **Always use parameterized queries** (`$1`, `$2`, ...) with `pool.query`. Never template SQL strings.
- **Always `escapeHtml()`** user-supplied strings before putting them in `innerHTML` in `app.js`. Exceptions: generated markdown (already sanitized by `marked`) and controlled values.
- **Don't raise `max_tokens`** carelessly — it's 2500 for a reason (cost + latency). If you truly need more for a specific artifact type, branch on `artifact_type` in `server.js`.

---

## 12. Suggested improvements (if asked)

Ordered roughly by impact vs effort. Each is a self-contained change.

1. **Streaming generation** — swap `fetch` for the Anthropic streaming endpoint, relay SSE through the backend to the frontend. Big UX win.
2. **Artifact versioning** — add `revision` column, `POST /api/artifacts/:id/revise` endpoint that generates a new revision referencing the old one. Enables "refine this" flow.
3. **Project-level grouping** — add `projects` table, optional `project_id` FK on `artifacts`. Lets a user group related artifacts (charter + timeline + RACI for the same initiative).
4. **Export to .docx / .pdf** — add an endpoint that converts the markdown with pandoc in a sidecar container.
5. **Rate limiting** — `express-rate-limit` on `/api/auth/*` (10/min) and `/api/artifacts POST` (per-user, e.g. 30/hour).
6. **Refresh tokens** — short-lived access (15min) + long-lived refresh stored httpOnly. Standard pattern.
7. **Shared workspaces** — `workspaces`, `memberships` tables. Artifacts optionally belong to a workspace. Invite by email.
8. **Methodology toggle** — PMBOK / Agile / PRINCE2 switch that threads terminology into every prompt.

---

## 13. Things that will trip you up

- **`init.sql` only runs once.** If you `docker compose up` with an existing `pgdata` volume, new DDL in `init.sql` is silently ignored. Put schema changes in `db.js` too.
- **`docker compose down` keeps the volume. Use `down -v` to wipe.** Surprising the first time.
- **Form field IDs are prefixed `f_`.** In `app.js`, `collectInputs()` strips that prefix when building the `inputs` payload. If you read fields directly elsewhere, remember the `f_` prefix in the DOM.
- **Mermaid must render AFTER `innerHTML` is set.** The `renderMermaid(outputBody)` call happens after `marked.parse` populates the DOM. If you refactor, keep that order or diagrams won't appear.
- **The prompts expect the model to produce structured markdown, not a JSON object.** Rendering assumes markdown. Don't switch to JSON output mode without rebuilding the renderer.
- **`nginx.conf` `proxy_read_timeout` is 120s.** An Anthropic call that takes longer than that will 504. Bump it if you add reasoning models or longer outputs.

---

## 14. File-by-file cheat sheet

- `docker-compose.yml` — service definitions. `backend` depends on `db` being healthy. `frontend` only depends on `backend` starting.
- `backend/src/server.js` — entrypoint. All routes defined inline. Boots via `initDb().then(() => app.listen(...))`.
- `backend/src/db.js` — pg Pool, retry loop for "db not ready yet", idempotent schema ensure.
- `backend/src/prompts.js` — `SYSTEM_PROMPT` (the PM persona) + `INSTRUCTIONS` dict + `buildUserPrompt(type, inputs)` helper + `VALID_TYPES` export.
- `backend/db/init.sql` — first-boot schema. Keep in sync with `ensureSchema()` in db.js.
- `frontend/nginx.conf` — reverse proxy config. Any new backend path must match the `/api/` prefix.
- `frontend/html/index.html` — two top-level divs: `#auth-view` (login/signup) and `#app-view` (main app). JS toggles `.hidden` between them.
- `frontend/html/styles.css` — all styles. CSS variables at the top. Look for section comments (`==================== AUTH VIEW ====================` etc).
- `frontend/html/app.js` — IIFE with: SCHEMAS → STATE → api() helper → toast() → auth flow → form rendering → archive rendering → deploy() → output rendering → helpers → mermaid init → boot.

---

When in doubt: read the existing code for that layer before adding new patterns. This repo is small enough to read end-to-end in 20 minutes. Do that rather than guessing.
