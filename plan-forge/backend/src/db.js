const { Pool } = require("pg");

const connectionString = process.env.DATABASE_URL || "";
const isLocal = /(@|\/\/)(localhost|127\.0\.0\.1|db|postgres)(:|\/)/.test(connectionString);

const pool = new Pool({
  connectionString,
  max: 10,
  idleTimeoutMillis: 30000,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});

pool.on("error", (err) => {
  console.error("[db] idle client error:", err);
});

async function waitForDb(maxAttempts = 30, delayMs = 2000) {
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      await pool.query("SELECT 1");
      console.log(`[db] connected (attempt ${i})`);
      return;
    } catch (e) {
      console.log(`[db] not ready yet (${i}/${maxAttempts}) — ${e.code || e.message}`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error("db never became ready");
}

// Tracks whether pgvector is available. Read by callers
// (embeddings.js / agents.js) to decide whether to retrieve / store
// embeddings or quietly skip RAG.
let HAS_VECTOR = false;

async function ensureSchema() {
  // Try to enable pgvector — needed for the RAG layer. The official
  // `pgvector/pgvector:pg16` image ships with the extension preinstalled;
  // a legacy `postgres:16-alpine` install won't have it, in which case we
  // log a warning and skip the embedding column so the rest of the app
  // still boots.
  try {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS vector;`);
    HAS_VECTOR = true;
  } catch (extErr) {
    console.warn(
      "[db] pgvector extension unavailable — RAG retrieval will be disabled. " +
      "Switch the db image to `pgvector/pgvector:pg16` to enable. Detail: " +
      (extErr.message || extErr)
    );
    HAS_VECTOR = false;
  }

  // Idempotent — in case init.sql didn't run (e.g. mounted volume already existed).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      name VARCHAR(255),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS artifacts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      artifact_type VARCHAR(64) NOT NULL,
      title VARCHAR(255) NOT NULL,
      inputs JSONB NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS parent_id INTEGER
      REFERENCES artifacts(id) ON DELETE CASCADE;
    ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS revision_note TEXT;
    CREATE INDEX IF NOT EXISTS idx_artifacts_user_created
      ON artifacts(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_artifacts_parent
      ON artifacts(parent_id);
    CREATE TABLE IF NOT EXISTS llm_config (
      id SERIAL PRIMARY KEY,
      provider VARCHAR(64) NOT NULL DEFAULT 'claude',
      model VARCHAR(255) NOT NULL DEFAULT 'claude-sonnet-4-20250514',
      api_key VARCHAR(1024) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS tool_connections (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tool_name VARCHAR(64) NOT NULL,
      account_name VARCHAR(255),
      access_token TEXT,
      refresh_token TEXT,
      token_expires_at TIMESTAMPTZ,
      api_key VARCHAR(1024),
      workspace_id VARCHAR(255),
      team_id VARCHAR(255),
      extra_config JSONB,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, tool_name)
    );
    CREATE TABLE IF NOT EXISTS push_history (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      artifact_id INTEGER NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
      tool_name VARCHAR(64) NOT NULL,
      tool_item_id VARCHAR(255),
      tool_item_url VARCHAR(512),
      status VARCHAR(32),
      error_message TEXT,
      pushed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_tool_connections_user
      ON tool_connections(user_id);
    CREATE INDEX IF NOT EXISTS idx_push_history_artifact
      ON push_history(artifact_id);
  `);

  // Add embedding column when pgvector is available. Done as a separate
  // statement so the rest of the schema doesn't blow up if the extension
  // failed to install (e.g. legacy postgres image still in use).
  if (HAS_VECTOR) {
    try {
      await pool.query(
        `ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS embedding vector(384);`
      );
    } catch (colErr) {
      console.warn(
        "[db] could not add artifacts.embedding column — RAG retrieval will be disabled. Detail: " +
        (colErr.message || colErr)
      );
      HAS_VECTOR = false;
    }
  }

  console.log(
    "[db] schema ensured" + (HAS_VECTOR ? " (pgvector active)" : " (pgvector OFF — RAG disabled)")
  );
}

function hasVector() {
  return HAS_VECTOR;
}

async function initDb() {
  await waitForDb();
  await ensureSchema();
}

module.exports = { pool, initDb, hasVector };
