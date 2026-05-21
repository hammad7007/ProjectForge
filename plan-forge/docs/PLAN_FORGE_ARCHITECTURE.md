---
title: "Plan Forge — Architecture & Engineering Handoff"
subtitle: "Techlogix AI Transformation Initiative · ProjectForge"
author: "Plan Forge Engineering"
date: "21 May 2026"
---

# 1. Executive summary

**Plan Forge** is an internal AI tool built by Techlogix that turns the messy inputs of a real project — Statements of Work, scope notes, half-written Excel plans — into the structured PM artifacts a delivery lead needs to start running a project: a charter, a RACI matrix, a Gantt timeline, a risk register, a retro report, and a growing catalog of other artifacts.

The product runs as a self-hosted web app inside Techlogix infrastructure. Each user signs in, picks an artifact type, drops in (or types) the project context, and clicks **Generate Artifact**. Behind the scenes a five-agent LangGraph pipeline — Retriever, Planner, Drafter, Critic, Refiner — produces the artifact, with a pgvector RAG layer that quietly improves quality as the team generates more artifacts and the model learns the house style.

This document is the engineering handoff for any teammate joining the project. By the end of it you should be able to:

- Describe what the product does and who it is for.
- Sketch the architecture and name each component.
- Walk through what happens between "user clicks Generate" and "artifact appears in archive."
- Run, deploy, and extend the system locally.
- Know where to look (file by file) for any given piece of behavior.

The codebase is deliberately small. The whole backend reads end-to-end in about thirty minutes. If you are stuck, that is usually faster than searching.

---

# 2. What the product is — and what it is not

## 2.1 What it is

A single-tenant **artifact generator** for project managers. Each user has a private archive of artifacts they generated. Artifacts are markdown documents (often with embedded Mermaid diagrams and tables). Users can:

- Upload a project document (PDF, Word, Excel, PowerPoint export, plain text) and have the form fields autofilled by an extraction LLM call.
- Generate one of ~20 PM artifact types from a structured form plus the uploaded document.
- View, revise (LLM-driven rewrite with instructions), copy, download, push to Jira/Asana/Monday/Linear, and delete artifacts.
- Switch UI theme between Cream, Graphite, and Sepia editorial palettes.
- Configure the LLM provider (Claude API key, OpenAI, Gemini, or the local Claude CLI via OAuth).

## 2.2 What it is not

- Not a project-management tool. There are no tasks, no Kanban boards, no real scheduling. Plan Forge **produces** the artifacts a PM uses in other tools; it does not run the project itself.
- Not multi-tenant or team software (yet). There are no workspaces, no shared artifacts, no invites. Every artifact is private to the user that created it.
- Not a fine-tuning platform. Plan Forge does not retrain the underlying LLM. What it does retrain is the **retrieval index**: the more artifacts the user generates, the more similar past artifacts the Retriever surfaces, and the more "the house style of this PM" leaks into future generations. That is the form of learning the system gets.

## 2.3 Why it exists

Project managers at Techlogix routinely lose the first two days of a new engagement transcribing a SOW into a Charter, then a RACI, then a Timeline, then a Risk Register — four artifacts whose content overlaps heavily but whose structure differs enough that hand-translation is genuinely tedious. Plan Forge collapses that into a single drop + a few clicks. Time savings per project are measured in hours, not minutes, and they compound across the firm.

---

# 3. Tech stack at a glance

| Layer | Choice | Why |
|---|---|---|
| Frontend | Vanilla HTML + CSS + JS | No build step. One file per concern. Anyone can read it. |
| Markdown rendering | `marked` v11 | Fast, permissive, good defaults. |
| Diagrams | `mermaid` v10 | Native support for Gantt + quadrant + flowcharts. |
| Syntax highlight | `highlight.js` v11 | Code blocks in generated artifacts. |
| Backend runtime | Node 20 + Express 4 | Small surface area; fast to iterate. |
| Authentication | JWT (7-day) + bcryptjs | Stateless, no session store. |
| Database | PostgreSQL 16 with **pgvector** | Relational integrity for users + artifacts; vector(384) embeddings for RAG retrieval. |
| Agent framework | **LangGraph** (`@langchain/langgraph`) | Five-node stateful graph orchestrating the agents. |
| Embeddings | **`@xenova/transformers`** running `all-MiniLM-L6-v2` locally | 384-dim sentence embeddings. No external API key. Runs inside our container. Same "no extra credentials" pattern as the Claude CLI. |
| LLM providers | Claude API, OpenAI, Gemini, Claude CLI (OAuth) | All four pluggable through a single `callLLM()` shim. |
| Document parsing | `pdf-parse`, `mammoth`, `xlsx` | PDF, DOCX, XLSX/XLS/CSV/TXT/RTF/HTML/JSON/MD. |
| Web server | nginx | Serves static + reverse-proxies `/api/*` to the backend. |
| Orchestration | Docker Compose | Three services: `db`, `backend`, `frontend`. |

No frontend framework. No ORM. No build system. **Keep it that way unless there is a strong reason.**

---

# 4. Repository layout

```
plan-forge/
├─ docker-compose.yml           # 3 services: db, backend, frontend
├─ Dockerfile.deploy            # Single-container build for Fly.io
├─ fly.toml                     # Fly.io deploy config
├─ README.md                    # User-facing setup docs
├─ CLAUDE.md                    # AI-coding-assistant context
│
├─ docs/
│  └─ PLAN_FORGE_ARCHITECTURE.md  # This file
│
├─ design-system/
│  └─ plan-forge/               # Design tokens, color/font specs (source of truth)
│
├─ backend/
│  ├─ Dockerfile                # node:20-slim + npm install --omit=dev
│  ├─ package.json              # langgraph, transformers, claude-code CLI, etc.
│  ├─ db/
│  │  └─ init.sql               # First-boot schema (incl. CREATE EXTENSION vector)
│  └─ src/
│     ├─ server.js              # Express app, all routes, boot sequence
│     ├─ db.js                  # pg Pool + ensureSchema() + hasVector()
│     ├─ prompts.js             # System prompt + INSTRUCTIONS catalog
│     ├─ embeddings.js          # Local Xenova/transformers embedding service
│     ├─ agents.js              # 5-node LangGraph pipeline + retrieval
│     ├─ cli.js                 # Claude Code CLI subprocess wrapper
│     └─ cli-oauth.js           # In-app OAuth flow for Claude CLI provider
│
└─ frontend/
   ├─ Dockerfile                # nginx:1.27-alpine + static copy
   ├─ nginx.conf                # 100 MB upload cap, 600s LLM timeout
   └─ html/
      ├─ index.html             # Auth view + app view in one page
      ├─ styles.css             # Editorial design system, 3 themes
      └─ app.js                 # All client logic, self-contained IIFE
```

---

# 5. High-level architecture

```
                ┌────────────────────────────────────────────────────────────┐
                │                    User's browser                          │
                │  http://localhost:8080  (or http://172.20.3.42:3200 on VM)│
                └─────────────────┬──────────────────────────────────────────┘
                                  │
                          HTTP (JWT in header)
                                  │
                ┌─────────────────▼──────────────────────────────────────────┐
                │                    nginx (frontend)                        │
                │  • Serves static index.html / styles.css / app.js          │
                │  • Reverse-proxies /api/* → backend:4000                   │
                │  • 100 MB client_max_body_size                             │
                │  • 600s proxy_read_timeout for long LLM calls              │
                └─────────────────┬──────────────────────────────────────────┘
                                  │
                          HTTP /api/* (internal Docker network)
                                  │
       ┌──────────────────────────▼──────────────────────────────────────────┐
       │                      Backend (Express, Node 20)                     │
       │                                                                     │
       │   ┌───────────────┐    ┌───────────────┐    ┌─────────────────┐    │
       │   │ Auth          │    │ Artifacts     │    │ Document        │    │
       │   │ /api/auth/*   │    │ /api/artifacts│    │ /api/extract    │    │
       │   │ JWT + bcrypt  │    │ + agents      │    │ pdf/docx/xlsx   │    │
       │   └───────┬───────┘    └───────┬───────┘    └────────┬────────┘    │
       │           │                    │                     │             │
       │           │            ┌───────▼─────────────────────▼────┐        │
       │           │            │        LangGraph 5-agent         │        │
       │           │            │   Retriever → Planner → Drafter  │        │
       │           │            │      → Critic → Refiner          │        │
       │           │            └──────────┬─────────────┬─────────┘        │
       │           │                       │             │                  │
       │           │              ┌────────▼────────┐    │                  │
       │           │              │ Local embedder  │    │                  │
       │           │              │ (Xenova MiniLM) │    │                  │
       │           │              └────────┬────────┘    │                  │
       │           │                       │             │                  │
       │           │                       │       LLM provider call        │
       │           │                       │       (Claude / OpenAI /       │
       │           │                       │        Gemini / Claude CLI)    │
       │           │                       │             │                  │
       │           │                       ▼             ▼                  │
       └───────────┼───────────────────────┼─────────────┼──────────────────┘
                   │                       │             │
                   ▼                       ▼             ▼
       ┌───────────────────┐    ┌──────────────────────┐ ┌───────────────────┐
       │  Postgres 16 +    │    │ pgvector index       │ │  Provider APIs    │
       │  pgvector         │    │ artifacts.embedding  │ │  api.anthropic    │
       │  • users          │    │ (vector(384))        │ │  api.openai       │
       │  • artifacts      │◀───┤ cosine similarity    │ │  gemini API       │
       │  • llm_config     │    │                      │ │  (or local CLI)   │
       │  • tool_connections│   └──────────────────────┘ └───────────────────┘
       └───────────────────┘
```

Each numbered subsystem in the rest of this document corresponds to one of these boxes.

---

# 6. The 5-agent LangGraph pipeline

This is the heart of the product. Before getting to file paths, the picture:

```
                              ┌─────────────────────────────┐
                              │  POST /api/artifacts        │
                              │  body: { artifact_type,     │
                              │          inputs,            │
                              │          source_document }  │
                              └────────────┬────────────────┘
                                           │
                                           ▼
              ┌─────────────────────────────────────────────────┐
              │  1. RETRIEVER  (DB only, no LLM)                 │
              │     • embed(inputs + source_document)           │
              │     • pgvector cosine-nearest top-3 past        │
              │       artifacts (same user, same type first)    │
              │     • drop matches with similarity < 0.25       │
              └────────────┬────────────────────────────────────┘
                           │  examples[]
                           ▼
              ┌─────────────────────────────────────────────────┐
              │  2. PLANNER  (LLM, ~700 tokens out)              │
              │     • input: artifact_type, inputs,             │
              │       source_document, retrieved examples       │
              │     • output: tight markdown outline (sections, │
              │       which facts to cite, where tables/Mermaid)│
              └────────────┬────────────────────────────────────┘
                           │  plan
                           ▼
              ┌─────────────────────────────────────────────────┐
              │  3. DRAFTER  (LLM, ~3500 tokens out)             │
              │     • input: plan + artifact template +         │
              │       inputs + source_document + examples       │
              │     • output: full markdown artifact            │
              └────────────┬────────────────────────────────────┘
                           │  draft
                           ▼
              ┌─────────────────────────────────────────────────┐
              │  4. CRITIC  (LLM, ~500 tokens out)               │
              │     • reviews draft against template + source   │
              │     • output: either "NO_ISSUES" or a bullet    │
              │       list of concrete issues                   │
              └────────────┬────────────────────────────────────┘
                           │  critique
                           ▼
              ┌─────────────────────────────────────────────────┐
              │  5. REFINER  (LLM if critique != NO_ISSUES,      │
              │     passthrough otherwise)                       │
              │     • applies critic feedback verbatim          │
              │     • preserves everything the critic didn't    │
              │       flag                                       │
              └────────────┬────────────────────────────────────┘
                           │  final markdown
                           ▼
              ┌─────────────────────────────────────────────────┐
              │  6. PERSIST + EMBED (background)                 │
              │     • INSERT INTO artifacts ...                  │
              │     • embedAndStore() updates embedding column  │
              │       so this artifact is retrievable next time │
              └─────────────────────────────────────────────────┘
```

## 6.1 Why five agents and not one

A single Anthropic call produces decent artifacts when the inputs are clean. The single-call path is still in the code; it is the fallback when the agent graph errors. The single call breaks down in three situations a real PM hits constantly:

1. **The user uploads a 50-page SOW.** A single call has to plan, draft, and self-review inside one inference pass. Structure starts drifting around page 3 of the artifact, sections get dropped, and facts from the SOW get paraphrased away.
2. **The user generates the third RACI of the week.** A single call has no memory; the model produces the same generic RACI it would have produced for any project, ignoring the conventions the user established in the previous two.
3. **The user expects a complex artifact (project_plan, full risk_register).** A single call exhausts its output token budget before finishing the last section, leaving the artifact truncated.

The five-agent pipeline addresses each:

1. **Planner + Drafter split.** The Planner sees the full source document but produces ~350 words of outline; the Drafter sees the outline and produces the artifact. The Drafter never has to plan and write in the same pass.
2. **Retriever.** Top-3 nearest past artifacts go into both Planner and Drafter as style references. The user's house style accretes naturally over time.
3. **Critic + Refiner.** The Critic gets one job: list everything the Drafter missed or got wrong. The Refiner gets one job: apply those fixes. When the Critic returns `NO_ISSUES`, the Refiner is a passthrough and the user pays nothing for that stage.

## 6.2 Failure modes and fallback

The agent graph is wrapped in a try/catch in `server.js`. **Any** node failure — provider 5xx, malformed LLM response, timeout, embeddings disk full — triggers a fall-through to the legacy single-call generator. The user always gets an artifact. The only signal of degraded mode is the backend log line `[agents] pipeline failed, falling back to single-call: <reason>`.

This was an explicit product choice: a single broken node must not break generation for the user.

## 6.3 Where to find the code

| File | Role |
|---|---|
| `backend/src/agents.js` | StateGraph definition, all five node functions, retrieval, embedAndStore, backfillEmbeddings. |
| `backend/src/embeddings.js` | Lazy-loaded local sentence-embedding pipeline. |
| `backend/src/server.js` (`POST /api/artifacts`) | The try/catch that runs the pipeline and falls back. |
| `backend/src/prompts.js` | Per-artifact `INSTRUCTIONS` (passed to Drafter + Refiner) and shared `SYSTEM_PROMPT`. |

## 6.4 Tuning knobs

- **Disable agents:** set `USE_AGENTS=false` in the backend container env. The legacy single-call path runs for every request.
- **Change the embedding model:** edit `MODEL_ID` in `embeddings.js`. The vector column is `vector(384)`; any new model must produce 384-dim vectors, or the column must be re-created (drop column, re-add with new dimension, run `backfillEmbeddings`).
- **Retrieve more or fewer examples:** edit the `k` argument inside the `retriever` node in `agents.js`. Default is 3.
- **Tighten or loosen the relevance floor:** edit the `r.similarity >= 0.25` filter in `retrieveSimilar`. Lower = more eager to attach examples; higher = stricter.

---

# 7. RAG retrieval — how learning happens

Plan Forge does not fine-tune any model. What it does is far cheaper and more controllable: **maintain a per-user index of past artifacts as a vector store**, and inject the K nearest neighbors into the Planner and Drafter prompts.

## 7.1 The lifecycle of one embedding

```
   Artifact saved          ─→   embedAndStore() in agents.js
                                  │
                                  ▼
                    text = title + JSON(inputs)[:1k] + content[:3k]
                                  │
                                  ▼
                    embed(text) → Float32Array(384)
                                  │
                                  ▼
                    UPDATE artifacts SET embedding = $1::vector
                          WHERE id = artifactId
                                  │
                                  ▼
                       (background — never blocks the response)
```

## 7.2 The lifecycle of one retrieval

```
   Next generation       ─→   retriever node in agents.js
                                  │
                                  ▼
                    queryText = inputs + source_document
                                  │
                                  ▼
                    embed(queryText) → Float32Array(384)
                                  │
                                  ▼
                    SELECT id, title, content,
                           1 - (embedding <=> $1::vector) AS sim
                      FROM artifacts
                     WHERE user_id = $u AND artifact_type = $t
                  ORDER BY embedding <=> $1::vector
                     LIMIT 3
                                  │
                                  ▼
                    (if fewer than 3, repeat without
                     the artifact_type filter)
                                  │
                                  ▼
                    drop rows with sim < 0.25
                                  │
                                  ▼
                       examples[] → Planner + Drafter
```

## 7.3 Backfill

The very first time the pgvector image boots and the new schema applies, no artifact has an embedding. On every backend startup, `backfillEmbeddings({ limit: 200 })` runs in the background and fills in the embedding column for the 200 most recent missing artifacts. Subsequent boots only pick up whatever is still missing. The user notices nothing; logs show `[agents] backfilling N artifact embedding(s)…`.

## 7.4 Privacy boundary

All retrieval is **per-user**. `WHERE user_id = $2` is the hard line. A user can never see another user's artifacts surface as examples in their generation, even if they would be highly similar. This is the same authorization rule that gates the regular artifact endpoints — do not loosen it in any new retrieval path.

## 7.5 Why local embeddings (and not OpenAI / Voyage)

The user explicitly asked for an embedding method that follows the same pattern as the Claude CLI provider: **no extra API key, runs inside our container, works offline**. `all-MiniLM-L6-v2` via `@xenova/transformers` fits exactly. The model is ~25 MB, loads once per backend boot, runs in ~50 ms per artifact on CPU, and never makes an external HTTP call.

Trade-off: quality is below OpenAI `text-embedding-3-small`. For our retrieval-of-templates use case it is more than sufficient. If retrieval ever needs to be substantially better, swap in OpenAI embeddings behind the same `embed()` interface in `embeddings.js` and rebuild the vector column at 1536 dims.

---

# 8. Data flow: one generation end-to-end

This is the sequence the user experiences when they click **Generate Artifact** after uploading a SOW.

```
1. Browser                 user fills form, clicks Generate
       │
       │   POST /api/artifacts
       │   Authorization: Bearer <jwt>
       │   body: { artifact_type, inputs, source_document }
       ▼
2. nginx                   forwards to backend:4000
       │
       ▼
3. Express                 authRequired middleware verifies JWT
       │                   reads LLM config from llm_config table
       │
       ▼
4. agents.runAgentPipeline
       │
       ├─ Retriever:        embed(query), SELECT top-3 similar
       │
       ├─ Planner:          callLLM(system + planner prompt + …)
       │                    → 350-word outline
       │
       ├─ Drafter:          callLLM(system + drafter prompt + outline + …)
       │                    → full markdown artifact (~2-3 KB)
       │
       ├─ Critic:           callLLM(system + critic prompt + draft)
       │                    → "NO_ISSUES"  OR  bullet list of issues
       │
       └─ Refiner:          if NO_ISSUES → passthrough
                            else callLLM(system + refiner + draft + critique)
                            → final markdown
       │
       ▼
5. Express                 INSERT INTO artifacts(...) RETURNING ...
       │                   res.json({ artifact })
       │
       │                   (in background)
       │                   embedAndStore({ artifactId, ... })
       │                   UPDATE artifacts SET embedding = ...
       │
       ▼
6. nginx                   streams response to browser
       │
       ▼
7. Browser                 renderOutput(artifact)
                           marked.parse + mermaid render + highlight.js
                           prepend to archive sidebar
                           toast("Artifact saved to archive")
```

Typical end-to-end latency: 60–150 seconds. The bottleneck is the LLM calls. The pre-fix nginx timeout of 120 seconds was the direct cause of the 504 "Gateway Time-out" the user saw after uploading an Excel and clicking Generate; the fix in this version raised it to 600 seconds.

---

# 9. Database schema

```sql
-- pgvector extension (provided by pgvector/pgvector:pg16 image)
CREATE EXTENSION IF NOT EXISTS vector;

users (
  id             SERIAL PRIMARY KEY,
  email          VARCHAR(255) UNIQUE NOT NULL,     -- always stored lowercased
  password_hash  VARCHAR(255) NOT NULL,             -- bcryptjs, 10 rounds
  name           VARCHAR(255),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
)

artifacts (
  id             SERIAL PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  artifact_type  VARCHAR(64) NOT NULL,              -- must be in VALID_TYPES
  title          VARCHAR(255) NOT NULL,
  inputs         JSONB NOT NULL,                     -- raw form fields
  content        TEXT NOT NULL,                      -- generated markdown
  parent_id      INTEGER REFERENCES artifacts(id) ON DELETE CASCADE,
  revision       INTEGER NOT NULL DEFAULT 1,
  revision_note  TEXT,
  embedding      vector(384),                        -- pgvector, populated async
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
INDEX idx_artifacts_user_created ON artifacts(user_id, created_at DESC)
INDEX idx_artifacts_parent       ON artifacts(parent_id)

llm_config (
  id            SERIAL PRIMARY KEY,
  provider      VARCHAR(64)  NOT NULL DEFAULT 'claude',
  model         VARCHAR(255) NOT NULL DEFAULT 'claude-sonnet-4-20250514',
  api_key       VARCHAR(1024) NOT NULL,              -- empty string for claude-cli
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
)

tool_connections (
  id                SERIAL PRIMARY KEY,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool_name         VARCHAR(64) NOT NULL,            -- jira, asana, monday, …
  account_name      VARCHAR(255),
  access_token      TEXT,
  refresh_token     TEXT,
  token_expires_at  TIMESTAMPTZ,
  api_key           VARCHAR(1024),
  workspace_id      VARCHAR(255),
  team_id           VARCHAR(255),
  extra_config      JSONB,
  is_active         BOOLEAN DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, tool_name)
)

push_history (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  artifact_id     INTEGER NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  tool_name       VARCHAR(64) NOT NULL,
  tool_item_id    VARCHAR(255),
  tool_item_url   VARCHAR(512),
  status          VARCHAR(32),
  error_message   TEXT,
  pushed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
```

### Schema source of truth

`backend/src/db.js` `ensureSchema()` runs on every backend boot. It is idempotent (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ADD COLUMN IF NOT EXISTS`) so it doubles as the migration tool. `backend/db/init.sql` runs only on first-ever boot of the `pgdata` volume — it is the optimistic case. If you add a column, add it to **both** files.

### Why JSONB for inputs

Artifact types have different shapes. Project plans have `team_size`. Timelines have `start_date`. Charters have `sponsor`. Instead of a column per possible field, the form payload is stored as JSONB. We never query inside `inputs` — we only store, retrieve, and repopulate the form.

---

# 10. API reference

All routes under `/api`. 🔒 marks routes that require `Authorization: Bearer <jwt>`.

| Method | Path | Body / Notes |
|---|---|---|
| `GET`  | `/api/health` | `{ok: true, db: "up"}` |
| `GET`  | `/api/version` | `{version: "0.8.0"}` |
| `POST` | `/api/auth/signup` | `{email, password, name?}` → `{token, user}` |
| `POST` | `/api/auth/login`  | `{email, password}` → `{token, user}` |
| 🔒 `GET`  | `/api/auth/me` | Current user profile |
| `GET`  | `/api/config` | Active LLM provider/model (no api_key) |
| `POST` | `/api/config` | `{provider, model, api_key}` upserts |
| `POST` | `/api/config/test` | Validates an api_key for a provider |
| 🔒 `GET`  | `/api/config/cli/status` | Claude CLI install + auth status |
| 🔒 `POST` | `/api/config/cli/oauth/start` | Begins in-app OAuth flow |
| 🔒 `POST` | `/api/config/cli/oauth/submit` | Submits the OAuth code |
| 🔒 `POST` | `/api/extract` | multipart upload → autofill fields + source_document |
| 🔒 `GET`  | `/api/artifacts` | List user's artifacts (metadata only, 200 newest) |
| 🔒 `GET`  | `/api/artifacts/:id` | Full artifact incl. `inputs` and `content` |
| 🔒 `POST` | `/api/artifacts` | Run 5-agent pipeline (or single-call fallback) and persist |
| 🔒 `POST` | `/api/artifacts/:id/revise` | LLM rewrite of an existing artifact |
| 🔒 `GET`  | `/api/artifacts/:id/revisions` | All revisions in the same chain |
| 🔒 `DELETE` | `/api/artifacts/:id` | Hard delete (cascades revisions) |
| 🔒 `GET`  | `/api/artifacts/:id/export` | `?format=` markdown / csv / excel / jira / asana / azure / monday / msproject / linear / github / smartsheet / wrike / notion / confluence / googlesheets / trello / generic |
| 🔒 `GET`  | `/api/connections` | Connected PM tools |
| 🔒 `DELETE` | `/api/connections/:id` | Disconnect a tool |
| 🔒 `POST` | `/api/push/:artifactId` | Push artifact to Jira/Asana/Monday/Linear |
| 🔒 `GET`  | `/api/push-history/:artifactId` | Past pushes for an artifact |

### Authorization rule

Every artifact and connection query filters by `user_id = req.user.sub`. There are no admin endpoints. Anyone authenticated can only see their own data. **Do not loosen this in a new endpoint** — that is an IDOR vulnerability.

### Error shape

All errors return `{error: "string"}` with an appropriate HTTP status. Some include `detail` for upstream provider error bodies. Frontend renders `body.error` directly in the UI.

---

# 11. Frontend conventions

The frontend is intentionally simple: one HTML page, one CSS file, one JS IIFE.

**Themes.** Three are supported — `cream` (default light), `graphite` (dark), `sepia` (warm dark). Every color must come from a CSS custom property defined at the top of `styles.css`. Test all three before merging visual changes.

**Fonts.** Inter for headings, body, and labels; JetBrains Mono for technical labels and code. Do not introduce a third family — vary weight and size of Inter instead.

**JS style.** Single IIFE with `'use strict'`. No bundler, no transpiler. The conventions you will see throughout `app.js`:

- `const $ = (id) => document.getElementById(id)` — project shorthand.
- Template literals for HTML; always wrap user-supplied strings in `escapeHtml()`.
- `async/await` with `try/catch` around every `api()` call.
- The `api()` helper at the top of `app.js` attaches the JWT and auto-logs-out on 401.

**Document upload UX.** The upload row sits between the form and the **Generate Artifact** button. The hint span shows the accepted file types (Excel, Word, PDF, TXT, CSV, RTF, JSON, HTML) and the 100 MB cap. On success it switches to "✓ Filled N fields from <filename>". On a relevance mismatch the backend returns `document_mismatch` and the frontend shows a modal asking the user to try a different file.

---

# 12. Document parsing pipeline

When a user uploads a file:

```
Browser
   │   multipart POST /api/extract
   │   form-data: file=<binary>, artifact_type=<key>
   ▼
nginx (client_max_body_size 100m)
   │
   ▼
Backend /api/extract (multer in-memory storage, 100 MB cap)
   │
   ▼
Switch on file extension:
   .pdf   → pdf-parse  → rawText
   .docx  → mammoth    → rawText
   .xlsx/.xls → xlsx   → rawText (CSV of all sheets joined)
   .html/.htm → strip tags → rawText
   .rtf   → strip control words → rawText
   .csv/.txt/.md/.json → utf-8 string → rawText
   anything else → 415 with friendly hint (.mpp → "use File → Save As Excel",
                                            image → "OCR not supported",
                                            .doc → "save as .docx",
                                            etc.)
   │
   ▼
   rawText.slice(0, 12000)   (cap forwarded text)
   │
   ▼
   buildExtractionPrompt(artifact_type, rawText)
   │   asks the LLM to return JSON:
   │   { relevant: true|false, mismatch_reason: "...", fields: {...} }
   │
   ▼
   Call configured LLM provider
   │
   ▼
   If relevant === false → 422 document_mismatch (user sees a modal)
   If parsed.fields      → return { fields, source_document: rawText }
                            (frontend autofills inputs and forwards rawText
                             back as source_document on the next /api/artifacts call)
```

The 12,000-char cap is important — it keeps the source_document round-trip small enough to fit in the JSON body and the downstream LLM prompt. Real SOWs are usually 6–10 KB of text after parsing, so this is rarely a binding constraint.

---

# 13. Configuration & secrets

### Required environment variables

```bash
# Anthropic API key for the default "claude" provider.
# Can be left blank if the user will configure a different provider through
# the Settings modal, OR will connect Claude CLI via OAuth.
ANTHROPIC_API_KEY=sk-ant-...

# JWT signing secret. Change to a long random string in any non-dev deploy.
JWT_SECRET=change-me

# Toggle the 5-agent pipeline. Default ON.
USE_AGENTS=true
```

### Optional environment variables (set in docker-compose.yml)

- `TRANSFORMERS_CACHE` and `HF_HOME` — paths where the local sentence-embedding model is cached. Defaults inside the backend container point at `/root/.cache/*`, which lives on the `claude_home` named volume — so the model survives container rebuilds.
- `DATABASE_URL` — Postgres connection string. Default `postgres://planforge:planforge_dev_pw@db:5432/planforge`.

### LLM provider, set through the Settings modal in the app

The app supports four providers, configured at runtime through the UI and persisted to `llm_config`:

1. **`claude`** — direct Anthropic API. Needs an `sk-ant-…` key.
2. **`openai`** — needs an OpenAI key.
3. **`gemini`** — needs a Google AI key.
4. **`claude-cli`** — uses the Claude Code CLI installed inside the backend container and authenticated via OAuth (`POST /api/config/cli/oauth/start`). No API key is stored.

The Anthropic key in `.env` is only used as a fallback when `llm_config` is empty.

---

# 14. Running it locally

```bash
# 1. Configure environment
cp .env.example .env
# fill in ANTHROPIC_API_KEY (or leave blank and configure a provider through the UI)

# 2. Boot the three services
docker compose up --build

# 3. Browser → http://localhost:8080
#    Sign up with any email/password (data lives in the local pgdata volume)

# 4. Watch logs
docker compose logs -f backend

# 5. Iterate on backend
docker compose up -d --build backend

# 6. Iterate on frontend (static — fastest)
docker compose up -d --build frontend

# 7. Wipe the database and start fresh
docker compose down -v
```

The first time the backend boots after the agent layer is enabled, you will see:

```
[db] schema ensured (pgvector active)
[embeddings] loading model Xenova/all-MiniLM-L6-v2 (~25 MB, cached after first run)…
[embeddings] model ready
[plan-forge] backend listening on :4000
[plan-forge] agents: ON (5-stage LangGraph)
[agents] backfilling N artifact embedding(s)…
[agents] backfill complete (N embedded)
```

Subsequent boots reuse the cached model and skip the download.

---

# 15. Deployment

There are two supported deployment shapes:

1. **Three-container Docker Compose** on a private VM (current production deploy at `http://172.20.3.42:3200/`). `nginx`, `backend`, and `pgvector/pgvector:pg16` each run as their own container, networked by `forgenet`. This is the canonical setup; everything described in this document refers to it.

2. **Single-container Fly.io build** via `Dockerfile.deploy` and `fly.toml`. The frontend's static files are baked into the backend container at build time, served from `backend/public`. The pgvector database is a managed service. Suitable for public demos but loses some of the operational simplicity of Compose.

Either way, the only ports exposed externally are nginx's HTTP port. The backend and database are only reachable from inside the Docker network.

---

# 16. Security & known limitations

These are intentional gaps. **Do not assume any of them are handled** when adding a new feature; if you need them, add them properly.

- **No rate limiting** on any endpoint. A signup/login flood would hammer the DB and Anthropic budget. Add `express-rate-limit` if exposed publicly.
- **No email verification / no password reset.** Typos in signup emails are permanent.
- **No refresh tokens.** The 7-day JWT is all there is.
- **No CSRF protection** (tokens live in localStorage, not cookies — low risk for this architecture).
- **CORS is wide open.** Fine for single-origin Compose; tighten before opening up to the public.
- **No HTTPS at the app layer.** Bring your own reverse proxy (Caddy, Traefik, nginx + certbot) for TLS.
- **No streaming responses.** Generation is non-streaming; the user sees a "drafting" animation for 60–150 seconds, then the artifact lands all at once.
- **No per-user cost controls.** A user could in theory generate unlimited artifacts on the shared API key. Add a per-user quota check before `callLLM()` if you open up.
- **No audit log.** Deletions are hard deletes with no record.
- **No backups.** Run `pg_dump` yourself, on a schedule.

The threat model is **"trusted internal Techlogix users"**. Treat anything beyond that as a real feature request and design it properly.

---

# 17. Roadmap — sensible next moves

Ordered roughly by impact-per-effort.

1. **Streaming responses** through the SSE-capable Anthropic endpoint. The "drafting" animation becomes "watching the artifact write itself," which is a big UX win and reads as much faster.
2. **Project-level grouping.** Add a `projects` table and an optional `project_id` FK on `artifacts`. Users group "Charter + Timeline + RACI for the Liferay upgrade" under one project node in the archive.
3. **Export to .docx / .pdf** via a `pandoc` sidecar container. Closes the loop with the source format the user uploaded.
4. **Methodology-aware retrieval.** Right now retrieval ignores the methodology field. Filtering past artifacts by methodology (PMBOK vs Agile vs PRINCE2) before passing them to the Drafter would sharpen the house-style match further.
5. **Rate limiting** on `/api/auth/*` (10/min) and `/api/artifacts` POST (per-user, e.g. 30/hour).
6. **Refresh tokens.** Short-lived access (15 min) + long-lived refresh stored httpOnly.
7. **Shared workspaces.** `workspaces`, `memberships` tables. Artifacts optionally belong to a workspace. Invite by email.
8. **Artifact diff view.** Side-by-side comparison of two revisions of the same chain. Powerful for the revise flow.

---

# 18. Things that will trip you up

These are the gotchas every newcomer hits at least once. Skim them now.

- **`init.sql` only runs once.** If you `docker compose up` against an existing `pgdata` volume, new DDL in `init.sql` is silently ignored. Put schema changes in `db.js` too.
- **`docker compose down` keeps the volume.** Use `down -v` to wipe.
- **Form field IDs are prefixed `f_`.** `collectInputs()` in `app.js` strips that prefix when building the payload. If you read fields directly elsewhere, remember the prefix.
- **Mermaid must render after `innerHTML` is set.** The `renderMermaid()` call happens after `marked.parse` populates the DOM. Keep that order.
- **The prompts expect markdown, not JSON.** The renderer assumes markdown output. If you switch to JSON output mode, also rebuild the renderer.
- **nginx `proxy_read_timeout` is 600 seconds** in this version. Generation calls with attached SOWs can take 2–3 minutes; this is the upper bound. The previous 120-second value was the cause of the 504 the user reported on XLSX-driven generation.
- **`onnxruntime-node` does not run on alpine.** That is why the backend Dockerfile uses `node:20-slim` (Debian-based). If you ever try to switch back to alpine, embeddings will segfault.
- **Embedding the model takes ~25 MB on first run.** It is cached on the `claude_home` named volume so subsequent boots are instant — but if you ever `docker compose down -v` you will pay that download cost again.

---

# 19. File-by-file cheat sheet

| File | What lives there |
|---|---|
| `docker-compose.yml` | Three service definitions. `db` is pgvector, `backend` is Node 20-slim, `frontend` is nginx. |
| `backend/Dockerfile` | node:20-slim base. Installs Claude Code CLI globally. Caches transformers model at `/root/.cache`. |
| `backend/db/init.sql` | First-boot schema. Includes `CREATE EXTENSION vector`. Keep in sync with `db.js` `ensureSchema()`. |
| `backend/src/server.js` | Entry point. All Express routes, the `callLLM()` shim, the agent dispatch in `POST /api/artifacts`, the boot sequence. |
| `backend/src/db.js` | pg Pool, `waitForDb()`, `ensureSchema()`, `hasVector()`. |
| `backend/src/prompts.js` | `SYSTEM_PROMPT`, `INSTRUCTIONS` dict per artifact type, `EXTRACT_FIELDS` per type, `buildUserPrompt`, `buildRevisePrompt`, `buildExtractionPrompt`. |
| `backend/src/agents.js` | LangGraph 5-node pipeline, retrieval, `embedAndStore`, `backfillEmbeddings`. |
| `backend/src/embeddings.js` | Local Xenova/transformers embedding service. `embed(text) → number[]`. |
| `backend/src/cli.js` | Subprocess wrapper around the Claude Code CLI. |
| `backend/src/cli-oauth.js` | In-app OAuth dance for the Claude CLI provider. |
| `frontend/nginx.conf` | Reverse proxy. 100 MB body, 600 s read timeout. DNS resolver pattern for container rebuild safety. |
| `frontend/html/index.html` | Two top-level divs: `#auth-view` (login/signup) and `#app-view` (main app). |
| `frontend/html/styles.css` | All styles. CSS variables at the top. Section headers throughout. |
| `frontend/html/app.js` | One IIFE: `api()` → `SCHEMAS` → state → auth → form rendering → archive → deploy → output rendering → upload flow → mermaid → boot. |
| `design-system/plan-forge/MASTER.md` | The authoritative design tokens. When this document and `MASTER.md` disagree about visuals, MASTER wins. |

---

# 20. Glossary

- **Artifact** — A markdown document Plan Forge generated for a user (charter, RACI, timeline, risk register, retro, etc.). Stored in the `artifacts` table.
- **Artifact type** — A key in `INSTRUCTIONS` and `EXTRACT_FIELDS` (e.g. `project_plan`, `raci_matrix`). Drives both the generation prompt and the autofill schema.
- **Source document** — The text content of the file the user uploaded. Travels round-trip through `/api/extract` → frontend state → `/api/artifacts source_document`.
- **Revision** — A new artifact row whose `parent_id` points at the original. Produced by `POST /api/artifacts/:id/revise`. Forms a chain via `revision` and `revision_note`.
- **Agent** — One of the five LangGraph nodes: Retriever, Planner, Drafter, Critic, Refiner.
- **Retrieval** — pgvector cosine-similarity lookup of past artifacts to use as in-context examples for the Planner and Drafter.
- **RAG** — Retrieval-Augmented Generation. The pattern of combining retrieval with prompt-based generation. Plan Forge's "learning from generated content" is RAG, not fine-tuning.
- **Embedding** — A 384-dim vector representation of an artifact's text. Stored in `artifacts.embedding`. Produced by `all-MiniLM-L6-v2`.
- **Provider** — A backend LLM service. One of: `claude`, `openai`, `gemini`, `claude-cli`.
- **`USE_AGENTS`** — Env var (default `true`). When `false`, the legacy single-call generator runs for every artifact and the entire agent pipeline is bypassed.

---

*Document version: 1.0 — 21 May 2026. Maintained by the Plan Forge engineering team. Direct any questions to the project channel.*
