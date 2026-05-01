# Plan Forge

A project-management drafting console. Pick an artifact — project charter, Gantt timeline, risk register, RACI, status report, retro, and more — fill in context, and a Claude-powered backend generates it and saves it to your personal archive.

Dockerized full-stack app: **Node/Express backend**, **PostgreSQL** for storage, **nginx** serving a static frontend. Auth via JWT + bcrypt-hashed passwords.

---

## Quickstart

### 1. Prerequisites

- **Docker** and **Docker Compose** installed
- An **Anthropic API key** — [get one here](https://console.anthropic.com/)

### 2. Configure environment

```bash
cp .env.example .env
```

Open `.env` and fill in:

- `ANTHROPIC_API_KEY` — your real key (starts with `sk-ant-`)
- `JWT_SECRET` — a long random string. Generate one with:
  ```bash
  openssl rand -hex 48
  ```

### 3. Build and run

```bash
docker compose up --build
```

First boot takes ~2 minutes while Postgres initializes and npm installs. You'll see `[plan-forge] backend listening on :4000` when it's ready.

### 4. Open the app

Visit **[http://localhost:8080](http://localhost:8080)**.

1. Click **New Access** — create an account
2. Pick an artifact type from the dropdown
3. Fill in the required fields (marked with `*`)
4. Click **Generate Artifact**
5. It streams in, saves to your archive, and is ready to copy or download

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Browser                                                      │
│     http://localhost:8080                                    │
└────────────────────────┬─────────────────────────────────────┘
                         │
                    ┌────▼─────┐
                    │ frontend │  nginx — serves static HTML/CSS/JS
                    │  :80     │         proxies /api/* → backend
                    └────┬─────┘
                         │ /api/*
                    ┌────▼─────┐
                    │ backend  │  node/express
                    │  :4000   │  auth (JWT + bcrypt)
                    │          │  artifact CRUD
                    │          │  anthropic proxy
                    └────┬─────┘
                         │
                    ┌────▼─────┐           ┌─────────────────┐
                    │    db    │           │ Anthropic API   │
                    │  pg:16   │           │ claude-sonnet-4 │
                    │  :5432   │           └─────────────────┘
                    └──────────┘
```

### Project layout

```
plan-forge/
├─ docker-compose.yml       # orchestrates all three services
├─ .env.example             # copy to .env and fill in secrets
├─ README.md
│
├─ backend/
│  ├─ Dockerfile
│  ├─ package.json
│  ├─ .dockerignore
│  ├─ db/
│  │  └─ init.sql           # runs once on first db boot
│  └─ src/
│     ├─ server.js          # express app, routes, boot
│     ├─ db.js              # pg pool + wait-for-db
│     └─ prompts.js         # PM artifact prompt catalog
│
└─ frontend/
   ├─ Dockerfile
   ├─ nginx.conf            # serves HTML, proxies /api
   └─ html/
      ├─ index.html         # single-page: auth view + app view
      ├─ styles.css         # blueprint aesthetic
      └─ app.js             # auth, archive, generation, rendering
```

### Database schema

```sql
users (
  id, email (unique), password_hash, name, created_at
)

artifacts (
  id, user_id → users,
  artifact_type, title,
  inputs JSONB,    -- the form fields the user filled in
  content TEXT,    -- the generated markdown
  created_at
)
```

---

## Supported artifact types

| Key              | Name                      | Notable output          |
|------------------|---------------------------|-------------------------|
| `project_plan`   | Project Charter           | Exec summary, scope, phases table |
| `timeline`       | Timeline with Milestones  | Mermaid Gantt chart     |
| `wbs`            | Work Breakdown Structure  | Nested hierarchy        |
| `risk_register`  | Risk Register             | L×I scored table        |
| `raci`           | RACI Matrix               | Activity × Role grid    |
| `status_report`  | Weekly Status Report      | 🟢🟡🔴 with KPI snapshot |
| `stakeholder_map`| Stakeholder Analysis      | Mermaid quadrant chart  |
| `sprint_plan`    | Sprint Plan               | Committed stories       |
| `retro`          | Retrospective             | 5 format options        |
| `meeting_agenda` | Meeting Agenda            | Time-boxed slots        |
| `comms_plan`     | Communication Plan        | Audience × channel      |
| `budget`         | Budget Breakdown          | Categorized costs       |

Prompts are stored in `backend/src/prompts.js` — edit there to tune.

---

## API reference

All artifact endpoints require `Authorization: Bearer <jwt>`.

| Method | Path                        | Purpose                              |
|--------|-----------------------------|--------------------------------------|
| `GET`  | `/api/health`               | Readiness check                      |
| `POST` | `/api/auth/signup`          | `{email, password, name}` → `{token, user}` |
| `POST` | `/api/auth/login`           | `{email, password}` → `{token, user}` |
| `GET`  | `/api/auth/me`              | Current user profile                 |
| `GET`  | `/api/artifacts`            | List user's artifacts (metadata)     |
| `GET`  | `/api/artifacts/:id`        | Full artifact + inputs + content     |
| `POST` | `/api/artifacts`            | `{artifact_type, title?, inputs}` → generates + saves |
| `DELETE`| `/api/artifacts/:id`       | Remove                               |

---

## Common tasks

### View logs
```bash
docker compose logs -f backend
docker compose logs -f db
```

### Reset everything (including saved artifacts)
```bash
docker compose down -v
```
The `-v` drops the Postgres volume — all users and artifacts are wiped.

### Shell into the database
```bash
docker compose exec db psql -U planforge -d planforge
```

Then e.g.:
```sql
SELECT id, email, created_at FROM users;
SELECT id, artifact_type, title, created_at FROM artifacts ORDER BY created_at DESC LIMIT 20;
```

### Change the model

Edit `backend/src/server.js`, look for `model: "claude-sonnet-4-20250514"`, swap in the model string you want. Rebuild:
```bash
docker compose up -d --build backend
```

### Expose only on localhost (don't let LAN see it)

In `docker-compose.yml`, change:
```yaml
ports:
  - "8080:80"
```
to:
```yaml
ports:
  - "127.0.0.1:8080:80"
```

---

## Production notes

This is a local-dev setup. Before putting it on the internet:

- **HTTPS** — put nginx or Caddy in front with a real cert
- **Secrets** — don't bake keys into images; use Docker secrets or a secret manager
- **JWT rotation** — the current token lasts 7 days with no refresh; add refresh tokens if you care
- **Rate limiting** — add `express-rate-limit` on `/api/auth/*` and `/api/artifacts POST`
- **Postgres** — the dev password `planforge_dev_pw` is in `docker-compose.yml`. Change it, and move DB credentials into secrets
- **Backups** — `docker compose exec db pg_dump -U planforge planforge > backup.sql`
- **CORS** — currently wide-open; lock it down to your frontend origin
- **Cost controls** — generation calls Anthropic with a real API key; put per-user quotas in the backend if this is multi-tenant

---

## License

Do whatever you want with this. No warranty.
