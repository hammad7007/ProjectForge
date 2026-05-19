const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const xlsx = require("xlsx");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const path = require("path");
const fs = require("fs");

const { pool, initDb } = require("./db");
const { SYSTEM_PROMPT, buildUserPrompt, buildRevisePrompt, buildExtractionPrompt, EXTRACT_FIELDS, VALID_TYPES, VALID_METHODOLOGIES } = require("./prompts");
const { runClaudeCli, checkClaudeCli } = require("./cli");
const { startOAuthFlow, submitOAuthCode } = require("./cli-oauth");

function normalizeMethodology(m) {
  if (typeof m !== "string") return null;
  const t = m.trim();
  return VALID_METHODOLOGIES.includes(t) ? t : null;
}

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PORT = Number(process.env.PORT || 4000);

if (!ANTHROPIC_API_KEY) {
  console.warn("[warn] ANTHROPIC_API_KEY is not set — generation will fail.");
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// File upload middleware
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// ------- helpers -------
function signToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function authRequired(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "missing token" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "invalid or expired token" });
  }
}

function isValidEmail(s) {
  return typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

// ------- health -------
app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, db: "up" });
  } catch {
    res.status(503).json({ ok: false, db: "down" });
  }
});

// ------- auth -------
app.post("/api/auth/signup", async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!isValidEmail(email)) return res.status(400).json({ error: "valid email required" });
  if (!password || password.length < 6)
    return res.status(400).json({ error: "password must be at least 6 characters" });

  try {
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, $2, $3)
       RETURNING id, email, name, created_at`,
      [email.toLowerCase().trim(), hash, (name || "").trim() || null]
    );
    const user = rows[0];
    res.json({ token: signToken(user), user });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "email already registered" });
    console.error("[signup]", err);
    res.status(500).json({ error: "server error" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "email and password required" });

  try {
    const { rows } = await pool.query(
      `SELECT id, email, name, password_hash FROM users WHERE email = $1`,
      [email.toLowerCase().trim()]
    );
    if (!rows.length) return res.status(401).json({ error: "invalid credentials" });
    const user = rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: "invalid credentials" });
    const safeUser = { id: user.id, email: user.email, name: user.name };
    res.json({ token: signToken(safeUser), user: safeUser });
  } catch (err) {
    console.error("[login]", err);
    res.status(500).json({ error: "server error" });
  }
});

app.get("/api/auth/me", authRequired, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, email, name, created_at FROM users WHERE id = $1`,
    [req.user.sub]
  );
  if (!rows.length) return res.status(404).json({ error: "user not found" });
  res.json({ user: rows[0] });
});

// ------- config (LLM settings) -------
app.get("/api/config", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT provider, model FROM llm_config ORDER BY updated_at DESC LIMIT 1`
    );
    if (!rows.length) {
      return res.json({ config: { provider: "claude", model: "claude-sonnet-4-20250514" } });
    }
    res.json({ config: rows[0] });
  } catch (err) {
    console.error("[get config]", err);
    res.status(500).json({ error: "failed to retrieve config" });
  }
});

app.post("/api/config", async (req, res) => {
  const { provider, model, api_key } = req.body || {};

  if (!provider) {
    return res.status(400).json({ error: "provider required" });
  }
  // claude-cli uses subscription OAuth via `claude /login`, no API key needed
  // and accepts an empty model (CLI picks its own default).
  if (provider !== "claude-cli" && !model) {
    return res.status(400).json({ error: "model required" });
  }
  if (provider !== "claude-cli" && !api_key) {
    return res.status(400).json({ error: "api_key required for this provider" });
  }
  const storedKey = provider === "claude-cli" ? "" : api_key;
  const storedModel = provider === "claude-cli" ? (model || "") : model;

  try {
    const { rows } = await pool.query(
      `SELECT id FROM llm_config ORDER BY updated_at DESC LIMIT 1`
    );

    if (rows.length) {
      await pool.query(
        `UPDATE llm_config SET provider = $1, model = $2, api_key = $3, updated_at = NOW()
         WHERE id = $4`,
        [provider, storedModel, storedKey, rows[0].id]
      );
    } else {
      await pool.query(
        `INSERT INTO llm_config (provider, model, api_key) VALUES ($1, $2, $3)`,
        [provider, storedModel, storedKey]
      );
    }

    res.json({ ok: true, config: { provider, model: storedModel } });
  } catch (err) {
    console.error("[save config]", err);
    res.status(500).json({ error: "failed to save config" });
  }
});

app.post("/api/config/test", async (req, res) => {
  const { provider, api_key } = req.body || {};

  if (!provider || !api_key) {
    return res.status(400).json({ error: "provider and api_key required" });
  }

  try {
    if (provider === "claude") {
      const testResp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": api_key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-opus-4-1",
          max_tokens: 10,
          messages: [{ role: "user", content: "test" }],
        }),
      });

      if (testResp.ok) {
        return res.json({ ok: true, message: "Claude API key is valid" });
      } else if (testResp.status === 401) {
        return res.status(400).json({ error: "Invalid Claude API key" });
      } else {
        const text = await testResp.text().catch(() => "");
        return res.status(400).json({ error: `Claude API error: ${testResp.status}` });
      }
    } else if (provider === "openai") {
      const testResp = await fetch("https://api.openai.com/v1/models", {
        headers: { "Authorization": `Bearer ${api_key}` },
      });

      if (testResp.ok) {
        return res.json({ ok: true, message: "OpenAI API key is valid" });
      } else if (testResp.status === 401) {
        return res.status(400).json({ error: "Invalid OpenAI API key" });
      } else {
        return res.status(400).json({ error: `OpenAI API error: ${testResp.status}` });
      }
    } else if (provider === "gemini") {
      const testResp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${api_key}`
      );

      if (testResp.ok) {
        return res.json({ ok: true, message: "Gemini API key is valid" });
      } else if (testResp.status === 400 || testResp.status === 403) {
        return res.status(400).json({ error: "Invalid Gemini API key" });
      } else {
        return res.status(400).json({ error: `Gemini API error: ${testResp.status}` });
      }
    } else {
      return res.status(400).json({ error: "Unknown provider" });
    }
  } catch (err) {
    console.error("[test config]", err);
    res.status(500).json({ error: "failed to test API key" });
  }
});

// Check whether the Claude CLI is installed and authenticated inside the
// backend container. Used by the settings modal when provider=claude-cli.
app.get("/api/config/cli/status", authRequired, async (_req, res) => {
  const status = await checkClaudeCli();
  res.json(status);
});

// In-app Claude CLI OAuth: start a setup-token flow and return the URL the
// user should open in their browser. The CLI subprocess stays alive in
// memory keyed by sessionId until /submit comes back with the code.
// Connect is idempotent within ~9 min — clicking it twice returns the same
// URL so the user's older browser tab still matches the active PKCE pair.
app.post("/api/config/cli/oauth/start", authRequired, async (req, res) => {
  try {
    const { sessionId, url, reused } = await startOAuthFlow(req.user.sub);
    res.json({ sessionId, url, reused: !!reused });
  } catch (err) {
    console.error("[oauth/start]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Submit the code the user pasted from Anthropic's authorization page.
// On success, also write provider=claude-cli into llm_config so the app
// starts using it immediately.
app.post("/api/config/cli/oauth/submit", authRequired, async (req, res) => {
  const { sessionId, code, model } = req.body || {};
  if (!sessionId || !code) {
    return res.status(400).json({ error: "sessionId and code required" });
  }
  try {
    const result = await submitOAuthCode({ sessionId, code });
    // Auto-save claude-cli as the active provider so the app starts using it.
    const finalModel = (model && String(model).trim()) || "";
    try {
      const { rows } = await pool.query(
        `SELECT id FROM llm_config ORDER BY updated_at DESC LIMIT 1`
      );
      if (rows.length) {
        await pool.query(
          `UPDATE llm_config SET provider = $1, model = $2, api_key = $3, updated_at = NOW() WHERE id = $4`,
          ["claude-cli", finalModel, "", rows[0].id]
        );
      } else {
        await pool.query(
          `INSERT INTO llm_config (provider, model, api_key) VALUES ($1, $2, $3)`,
          ["claude-cli", finalModel, ""]
        );
      }
    } catch (dbErr) {
      console.error("[oauth/submit: save config]", dbErr.message);
      // Auth succeeded, just config persist failed — still a partial win
      return res.json({ success: true, configSaved: false, warning: dbErr.message });
    }
    res.json({ success: true, configSaved: true, output: result.output });
  } catch (err) {
    console.error("[oauth/submit]", err.message);
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/config/restart", async (req, res) => {
  res.json({ ok: true, message: "backend restarting..." });
  setTimeout(() => process.exit(0), 500);
});

// ------- document extraction -------
// Supported upload extensions and a friendly label list for error messages.
const SUPPORTED_UPLOAD_EXTS = new Set([
  ".pdf", ".docx", ".xlsx", ".xls", ".csv", ".txt", ".md", ".rtf", ".json", ".html", ".htm"
]);
const SUPPORTED_UPLOAD_LABEL = "PDF, Word (.docx), Excel (.xlsx/.xls), CSV, TXT, Markdown, RTF, JSON, HTML";

app.post("/api/extract", authRequired, upload.single("file"), async (req, res) => {
  const { artifact_type } = req.body || {};
  const file = req.file;

  if (!file) return res.status(400).json({ error: "no file provided" });
  if (!artifact_type) return res.status(400).json({ error: "artifact_type required" });
  if (!EXTRACT_FIELDS[artifact_type]) {
    return res.status(400).json({ error: `unsupported artifact type: ${artifact_type}` });
  }

  try {
    let rawText = "";
    const ext = path.extname(file.originalname).toLowerCase();

    if (!SUPPORTED_UPLOAD_EXTS.has(ext)) {
      return res.status(415).json({
        error: `unsupported file type "${ext || file.originalname}". Supported: ${SUPPORTED_UPLOAD_LABEL}.`
      });
    }

    if (ext === ".pdf") {
      const data = await pdfParse(file.buffer);
      rawText = data.text;
    } else if (ext === ".docx") {
      const result = await mammoth.extractRawText({ buffer: file.buffer });
      rawText = result.value;
    } else if (ext === ".xlsx" || ext === ".xls") {
      const wb = xlsx.read(file.buffer, { type: "buffer" });
      rawText = wb.SheetNames.map(name => {
        return xlsx.utils.sheet_to_csv(wb.Sheets[name]);
      }).join("\n\n");
    } else if (ext === ".html" || ext === ".htm") {
      // Strip tags so the LLM sees readable prose, not markup noise.
      rawText = file.buffer.toString("utf-8")
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/\s+/g, " ");
    } else if (ext === ".rtf") {
      // Naive RTF stripping — drop control words and braces, keep the text payload.
      rawText = file.buffer.toString("utf-8")
        .replace(/\\par[d]?/g, "\n")
        .replace(/\\'[0-9a-fA-F]{2}/g, " ")
        .replace(/\\[a-zA-Z]+-?\d* ?/g, "")
        .replace(/[{}]/g, "");
    } else {
      // .csv, .txt, .md, .json — UTF-8 text
      rawText = file.buffer.toString("utf-8");
    }

    rawText = rawText.slice(0, 12000);

    if (!rawText.trim()) {
      return res.status(422).json({
        error: `could not extract text from "${file.originalname}" — if this is a scanned/image PDF, OCR isn't supported yet. Try a text-based PDF, Word, Excel, or plain text file.`
      });
    }

    // Get LLM config
    const configRow = await pool.query(
      `SELECT api_key, provider, model FROM llm_config ORDER BY updated_at DESC LIMIT 1`
    );
    const configExists = configRow.rows.length > 0;
    const apiKey = configExists ? configRow.rows[0].api_key : ANTHROPIC_API_KEY;
    const provider = configExists ? configRow.rows[0].provider : "claude";
    const model = configExists ? configRow.rows[0].model : "claude-sonnet-4-20250514";

    if (provider !== "claude-cli" && !apiKey) {
      return res.status(500).json({ error: "LLM API key not configured" });
    }

    // Build extraction prompt from the shared field catalog
    const extractionPrompt = buildExtractionPrompt(artifact_type, rawText);

    // Call LLM based on provider
    let llmResp, llmData, content;

    if (provider === "claude-cli") {
      try {
        content = await runClaudeCli({ userMsg: extractionPrompt, model });
      } catch (err) {
        console.error("[extract] Claude CLI error:", err.message);
        return res.status(500).json({ error: err.message });
      }
    } else if (provider === "claude") {
      llmResp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: model,
          max_tokens: 2000,
          messages: [{ role: "user", content: extractionPrompt }],
        }),
      });

      if (!llmResp.ok) {
        const errText = await llmResp.text();
        console.error("[extract] Claude error:", errText);
        return res.status(500).json({ error: "extraction failed: LLM error" });
      }

      llmData = await llmResp.json();
      content = (llmData.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
    } else if (provider === "openai") {
      llmResp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: model,
          max_tokens: 2000,
          messages: [{ role: "user", content: extractionPrompt }],
        }),
      });

      if (!llmResp.ok) {
        const errText = await llmResp.text();
        console.error("[extract] OpenAI error:", errText);
        return res.status(500).json({ error: "extraction failed: LLM error" });
      }

      llmData = await llmResp.json();
      content = (llmData.choices || [])
        .filter((c) => c.message && c.message.content)
        .map((c) => c.message.content)
        .join("\n")
        .trim();
    } else if (provider === "gemini") {
      llmResp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: extractionPrompt }] }],
            generationConfig: { maxOutputTokens: 2000 },
          }),
        }
      );

      if (!llmResp.ok) {
        const errText = await llmResp.text();
        console.error("[extract] Gemini error:", errText);
        return res.status(500).json({ error: "extraction failed: LLM error" });
      }

      llmData = await llmResp.json();
      content = (llmData.candidates || [])
        .flatMap((c) => (c.content?.parts || []))
        .filter((p) => p.text)
        .map((p) => p.text)
        .join("\n")
        .trim();
    } else {
      return res.status(500).json({ error: `unsupported provider: ${provider}` });
    }

    if (!content) {
      return res.status(422).json({ error: "extraction returned no data" });
    }

    // Strip markdown code fences if the model wrapped its response
    const cleaned = content.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error("[extract] no JSON in response:", cleaned.slice(0, 500));
      return res.status(422).json({ error: "model did not return JSON — please try again" });
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch (parseErr) {
      console.error("[extract] JSON parse error:", parseErr.message, "raw:", jsonMatch[0].slice(0, 500));
      return res.status(422).json({ error: "could not parse extraction response as JSON" });
    }

    // Backwards compat: if the model returned the old flat-fields shape, treat
    // it as relevant=true and use the object as `fields` directly.
    let relevant, mismatchReason, fields;
    if (parsed && typeof parsed === "object" && "relevant" in parsed && "fields" in parsed) {
      relevant = parsed.relevant !== false; // anything truthy or missing → relevant
      mismatchReason = String(parsed.mismatch_reason || "").trim();
      fields = parsed.fields && typeof parsed.fields === "object" ? parsed.fields : {};
    } else {
      relevant = true;
      mismatchReason = "";
      fields = parsed && typeof parsed === "object" ? parsed : {};
    }

    if (!relevant) {
      return res.status(422).json({
        error: "document_mismatch",
        mismatch_reason: mismatchReason || `This document does not appear to fit a "${artifact_type}" artifact.`,
        artifact_type,
        filename: file.originalname,
      });
    }

    // Return the rawText so the frontend can forward it back as source_document
    // when the user clicks Generate — Claude then sees the original document.
    res.json({ fields, source_document: rawText });
  } catch (err) {
    console.error("[extract]", err);
    res.status(500).json({ error: err.message || "extraction failed" });
  }
});

// ------- tool connections (integrations) -------
app.get("/api/connections", authRequired, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, tool_name, account_name, is_active, created_at FROM tool_connections WHERE user_id = $1 ORDER BY tool_name`,
      [req.user.sub]
    );
    res.json({ connections: rows });
  } catch (err) {
    console.error("[get connections]", err);
    res.status(500).json({ error: "failed to fetch connections" });
  }
});

app.delete("/api/connections/:id", authRequired, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "invalid id" });

  try {
    const { rowCount } = await pool.query(
      `DELETE FROM tool_connections WHERE id = $1 AND user_id = $2`,
      [id, req.user.sub]
    );
    if (!rowCount) return res.status(404).json({ error: "connection not found" });
    res.json({ ok: true });
  } catch (err) {
    console.error("[delete connection]", err);
    res.status(500).json({ error: "failed to delete connection" });
  }
});

app.get("/api/push-history/:artifactId", authRequired, async (req, res) => {
  const artifactId = Number(req.params.artifactId);
  if (!Number.isInteger(artifactId)) return res.status(400).json({ error: "invalid artifact id" });

  try {
    const { rows } = await pool.query(
      `SELECT ph.* FROM push_history ph
       JOIN artifacts a ON ph.artifact_id = a.id
       WHERE ph.artifact_id = $1 AND a.user_id = $2
       ORDER BY ph.pushed_at DESC LIMIT 50`,
      [artifactId, req.user.sub]
    );
    res.json({ history: rows });
  } catch (err) {
    console.error("[get push history]", err);
    res.status(500).json({ error: "failed to fetch push history" });
  }
});

app.post("/api/push/:artifactId", authRequired, async (req, res) => {
  const artifactId = Number(req.params.artifactId);
  const { tool, customization } = req.body || {};

  if (!Number.isInteger(artifactId)) return res.status(400).json({ error: "invalid artifact id" });
  if (!tool) return res.status(400).json({ error: "tool name required" });

  try {
    // Fetch artifact and connection
    const artResult = await pool.query(
      `SELECT * FROM artifacts WHERE id = $1 AND user_id = $2`,
      [artifactId, req.user.sub]
    );
    if (!artResult.rows.length) return res.status(404).json({ error: "artifact not found" });

    const connResult = await pool.query(
      `SELECT * FROM tool_connections WHERE user_id = $1 AND tool_name = $2 AND is_active = true`,
      [req.user.sub, tool]
    );
    if (!connResult.rows.length) return res.status(400).json({ error: `no active ${tool} connection found` });

    const artifact = artResult.rows[0];
    const connection = connResult.rows[0];

    // Push to tool
    const result = await pushToTool(tool, connection, artifact, customization);

    // Save to history
    await pool.query(
      `INSERT INTO push_history (user_id, artifact_id, tool_name, tool_item_id, tool_item_url, status)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [req.user.sub, artifactId, tool, result.itemId || null, result.itemUrl || null, result.status]
    );

    if (result.status === "success") {
      res.json({ ok: true, message: `Pushed to ${tool}`, ...result });
    } else {
      res.status(400).json({ error: result.error || `Failed to push to ${tool}` });
    }
  } catch (err) {
    console.error("[push artifact]", err);
    res.status(500).json({ error: "push failed" });
  }
});

async function pushToTool(tool, connection, artifact, customization) {
  switch (tool.toLowerCase()) {
    case "jira":
      return await pushToJira(connection, artifact, customization);
    case "asana":
      return await pushToAsana(connection, artifact, customization);
    case "monday":
      return await pushToMonday(connection, artifact, customization);
    case "linear":
      return await pushToLinear(connection, artifact, customization);
    case "notion":
      return await pushToNotion(connection, artifact, customization);
    case "github":
      return await pushToGitHub(connection, artifact, customization);
    case "azure":
      return await pushToAzure(connection, artifact, customization);
    case "trello":
      return await pushToTrello(connection, artifact, customization);
    default:
      return { status: "error", error: `Tool ${tool} not yet implemented` };
  }
}

// Tool-specific push implementations
async function pushToJira(connection, artifact, customization) {
  try {
    const payload = {
      fields: {
        project: { key: connection.extra_config?.projectKey || "PLAN" },
        summary: (customization?.title || artifact.title).slice(0, 255),
        description: artifact.content.slice(0, 32000),
        issuetype: { name: customization?.issueType || "Story" },
        priority: { name: customization?.priority || "Medium" },
        labels: ["plan-forge", ...(customization?.labels || [])]
      }
    };

    const response = await fetch("https://api.atlassian.com/rest/api/3/issues", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${connection.access_token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Jira API error: ${response.status}`);
    }

    const data = await response.json();
    return {
      status: "success",
      itemId: data.id,
      itemUrl: `${connection.extra_config?.jiraUrl}/browse/${data.key}`,
      message: `Created Jira issue ${data.key}`
    };
  } catch (err) {
    return { status: "error", error: err.message };
  }
}

async function pushToAsana(connection, artifact, customization) {
  try {
    const payload = {
      data: {
        name: (customization?.title || artifact.title).slice(0, 1024),
        notes: artifact.content.slice(0, 32000),
        projects: connection.extra_config?.projectId ? [{ id: connection.extra_config.projectId }] : []
      }
    };

    const response = await fetch("https://app.asana.com/api/1.0/tasks", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${connection.access_token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) throw new Error(`Asana API error: ${response.status}`);
    const data = await response.json();

    return {
      status: "success",
      itemId: data.data.gid,
      itemUrl: `https://app.asana.com/0/${data.data.projects[0]?.id || 0}/${data.data.gid}`,
      message: "Created Asana task"
    };
  } catch (err) {
    return { status: "error", error: err.message };
  }
}

async function pushToMonday(connection, artifact, customization) {
  try {
    const query = `mutation {
      create_item(board_id: ${connection.extra_config?.boardId || 0}, item_name: "${artifact.title.slice(0, 100).replace(/"/g, '\\"')}") {
        id
      }
    }`;

    const response = await fetch("https://api.monday.com/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": connection.access_token
      },
      body: JSON.stringify({ query })
    });

    if (!response.ok) throw new Error(`Monday API error: ${response.status}`);
    const data = await response.json();

    if (data.errors) throw new Error(data.errors[0]?.message || "Unknown Monday error");

    return {
      status: "success",
      itemId: data.data.create_item.id,
      message: "Created Monday.com item"
    };
  } catch (err) {
    return { status: "error", error: err.message };
  }
}

async function pushToLinear(connection, artifact, customization) {
  try {
    const query = `mutation {
      issueCreate(input: {
        teamId: "${connection.extra_config?.teamId || ""}"
        title: "${artifact.title.slice(0, 255).replace(/"/g, '\\"')}"
        description: "${artifact.content.slice(0, 5000).replace(/"/g, '\\"').replace(/\n/g, '\\n')}"
      }) {
        issue {
          id
          identifier
          url
        }
      }
    }`;

    const response = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${connection.access_token}`
      },
      body: JSON.stringify({ query })
    });

    if (!response.ok) throw new Error(`Linear API error: ${response.status}`);
    const data = await response.json();

    if (data.errors) throw new Error(data.errors[0]?.message || "Unknown Linear error");

    return {
      status: "success",
      itemId: data.data.issueCreate.issue.id,
      itemUrl: data.data.issueCreate.issue.url,
      message: `Created Linear issue ${data.data.issueCreate.issue.identifier}`
    };
  } catch (err) {
    return { status: "error", error: err.message };
  }
}

async function pushToNotion(connection, artifact, customization) {
  return { status: "error", error: "Notion integration coming soon" };
}

async function pushToGitHub(connection, artifact, customization) {
  return { status: "error", error: "GitHub integration coming soon" };
}

async function pushToAzure(connection, artifact, customization) {
  return { status: "error", error: "Azure DevOps integration coming soon" };
}

async function pushToTrello(connection, artifact, customization) {
  return { status: "error", error: "Trello integration coming soon" };
}

// ------- artifacts -------

// list (only metadata, not full content)
app.get("/api/artifacts", authRequired, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, artifact_type, title, parent_id, revision, created_at
     FROM artifacts
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 200`,
    [req.user.sub]
  );
  res.json({ artifacts: rows });
});

// read full artifact
app.get("/api/artifacts/:id", authRequired, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "invalid id" });

  const { rows } = await pool.query(
    `SELECT id, artifact_type, title, inputs, content, parent_id, revision, revision_note, created_at
     FROM artifacts
     WHERE id = $1 AND user_id = $2`,
    [id, req.user.sub]
  );
  if (!rows.length) return res.status(404).json({ error: "not found" });
  res.json({ artifact: rows[0] });
});

// list all revisions in the same chain (root + descendants), oldest first
app.get("/api/artifacts/:id/revisions", authRequired, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "invalid id" });

  try {
    const { rows: targetRows } = await pool.query(
      `SELECT id, parent_id FROM artifacts WHERE id = $1 AND user_id = $2`,
      [id, req.user.sub]
    );
    if (!targetRows.length) return res.status(404).json({ error: "not found" });

    const rootId = targetRows[0].parent_id || targetRows[0].id;
    const { rows } = await pool.query(
      `SELECT id, artifact_type, title, parent_id, revision, revision_note, created_at
       FROM artifacts
       WHERE user_id = $1 AND (id = $2 OR parent_id = $2)
       ORDER BY revision ASC, created_at ASC`,
      [req.user.sub, rootId]
    );
    res.json({ root_id: rootId, revisions: rows });
  } catch (err) {
    console.error("[list revisions]", err);
    res.status(500).json({ error: "failed to list revisions" });
  }
});

// delete
app.delete("/api/artifacts/:id", authRequired, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "invalid id" });

  const { rowCount } = await pool.query(
    `DELETE FROM artifacts WHERE id = $1 AND user_id = $2`,
    [id, req.user.sub]
  );
  if (!rowCount) return res.status(404).json({ error: "not found" });
  res.json({ ok: true });
});

// Helper function to sanitize filename
function sanitizeFilename(str) {
  return String(str)
    .replace(/[^\w\s-]/g, '')  // Remove special characters
    .replace(/\s+/g, '-')       // Replace spaces with hyphens
    .replace(/-+/g, '-')        // Replace multiple hyphens with single
    .slice(0, 100)              // Limit length
    .toLowerCase();
}

// export artifact in various formats
app.get("/api/artifacts/:id/export", authRequired, async (req, res) => {
  const id = Number(req.params.id);
  const format = (req.query.format || "markdown").toLowerCase();
  const tool = (req.query.tool || "").toLowerCase();

  if (!Number.isInteger(id)) return res.status(400).json({ error: "invalid id" });
  if (!["markdown", "csv", "excel", "pdf", "jira", "msproject", "asana", "azure", "monday", "generic", "trello", "linear", "github", "smartsheet", "wrike", "notion", "confluence", "googlesheets"].includes(format))
    return res.status(400).json({ error: "unsupported format" });

  try {
    const { rows } = await pool.query(
      `SELECT artifact_type, title, inputs, content FROM artifacts WHERE id = $1 AND user_id = $2`,
      [id, req.user.sub]
    );
    if (!rows.length) return res.status(404).json({ error: "not found" });

    const artifact = rows[0];
    const safeName = sanitizeFilename(artifact.title);

    if (format === "markdown") {
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}.md"`);
      res.send(artifact.content);
    } else if (format === "csv") {
      const csv = generateCSV(artifact);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}.csv"`);
      res.send(csv);
    } else if (format === "excel") {
      const buffer = generateExcel(artifact);
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}.xlsx"`);
      res.send(buffer);
    } else if (format === "jira") {
      const csv = generateJiraFormat(artifact);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}-jira.csv"`);
      res.send(csv);
    } else if (format === "msproject") {
      const xml = generateMSProjectFormat(artifact);
      res.setHeader("Content-Type", "application/xml");
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}.xml"`);
      res.send(xml);
    } else if (format === "asana") {
      const csv = generateAsanaFormat(artifact);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}-asana.csv"`);
      res.send(csv);
    } else if (format === "azure") {
      const csv = generateAzureDevOpsFormat(artifact);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}-azure.csv"`);
      res.send(csv);
    } else if (format === "monday") {
      const csv = generateMondayFormat(artifact);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}-monday.csv"`);
      res.send(csv);
    } else if (format === "generic") {
      const buffer = generateGenericPMExcel(artifact);
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}-pm.xlsx"`);
      res.send(buffer);
    } else if (format === "trello") {
      const csv = generateTrelloFormat(artifact);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}-trello.csv"`);
      res.send(csv);
    } else if (format === "linear") {
      const csv = generateLinearFormat(artifact);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}-linear.csv"`);
      res.send(csv);
    } else if (format === "github") {
      const csv = generateGitHubFormat(artifact);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}-github.csv"`);
      res.send(csv);
    } else if (format === "smartsheet") {
      const buffer = generateSmartsheetFormat(artifact);
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}-smartsheet.xlsx"`);
      res.send(buffer);
    } else if (format === "wrike") {
      const csv = generateWrikeFormat(artifact);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}-wrike.csv"`);
      res.send(csv);
    } else if (format === "notion") {
      const html = generateNotionFormat(artifact);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}-notion.html"`);
      res.send(html);
    } else if (format === "confluence") {
      const markup = generateConfluenceFormat(artifact);
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}-confluence.txt"`);
      res.send(markup);
    } else if (format === "googlesheets") {
      const csv = generateGoogleSheetsFormat(artifact);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}-googlesheets.csv"`);
      res.send(csv);
    } else if (format === "pdf") {
      res.status(501).json({ error: "PDF export coming soon" });
    }
  } catch (err) {
    console.error("[export artifact]", err);
    res.status(500).json({ error: "export failed" });
  }
});

function generateCSV(artifact) {
  const { title, artifact_type, inputs, content } = artifact;
  const lines = [];

  // Add metadata
  lines.push(`"Title","${title.replace(/"/g, '""')}"`);
  lines.push(`"Type","${artifact_type.replace(/"/g, '""')}"`);
  lines.push(`"Generated","${new Date().toISOString()}"`);
  lines.push("");

  // Extract table data from markdown
  const tables = extractTableFromMarkdown(content);

  if (tables.length > 0) {
    // Output each extracted table
    tables.forEach((table, tableIdx) => {
      if (tableIdx > 0) lines.push(""); // Blank line between tables
      table.forEach(row => {
        lines.push(row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(","));
      });
    });
  } else {
    // Fallback: output content as lines
    lines.push("--- Content ---");
    lines.push("");
    const rows = content.split("\n").filter(l => l.trim() && !l.startsWith("#"));
    rows.forEach(row => {
      lines.push(`"${row.replace(/"/g, '""')}"`);
    });
  }

  return lines.join("\n");
}

function generateExcel(artifact) {
  const { title, artifact_type, inputs, content } = artifact;

  const workbook = xlsx.utils.book_new();

  const summarySheet = xlsx.utils.json_to_sheet([
    { Field: "Title", Value: title },
    { Field: "Type", Value: artifact_type },
    { Field: "Generated", Value: new Date().toISOString() }
  ]);
  summarySheet["!cols"] = [{ wch: 20 }, { wch: 40 }];
  xlsx.utils.book_append_sheet(workbook, summarySheet, "Summary");

  const contentLines = content.split("\n").map((line, idx) => ({ "Row #": idx + 1, Content: line }));
  const contentSheet = xlsx.utils.json_to_sheet(contentLines);
  contentSheet["!cols"] = [{ wch: 8 }, { wch: 80 }];
  xlsx.utils.book_append_sheet(workbook, contentSheet, "Content");

  if (Object.keys(inputs || {}).length > 0) {
    const inputsData = Object.entries(inputs).map(([key, value]) => ({
      Field: key,
      Value: String(value).slice(0, 100)
    }));
    const inputsSheet = xlsx.utils.json_to_sheet(inputsData);
    inputsSheet["!cols"] = [{ wch: 25 }, { wch: 60 }];
    xlsx.utils.book_append_sheet(workbook, inputsSheet, "Inputs");
  }

  return xlsx.write(workbook, { type: "buffer" });
}

// Helper function to extract table data from markdown
function extractTableFromMarkdown(content) {
  const lines = content.split("\n");
  const tables = [];
  let currentTable = [];
  let tableHeaders = [];

  for (const line of lines) {
    if (line.includes("|") && !line.includes("---|")) {
      const cells = line.split("|").map(cell => cell.trim()).filter(cell => cell);
      if (cells.length > 0) {
        currentTable.push(cells);
      }
    } else if (currentTable.length > 0 && !line.includes("|")) {
      if (currentTable.length > 0) {
        tables.push(currentTable);
        currentTable = [];
      }
    }
  }

  if (currentTable.length > 0) {
    tables.push(currentTable);
  }

  return tables;
}

// Jira format: Enhanced with more fields
function generateJiraFormat(artifact) {
  const { title, artifact_type, inputs, content } = artifact;
  const lines = [];

  // Determine issue type based on artifact type
  let issueType = 'Story';
  if (artifact_type.includes('plan')) issueType = 'Epic';
  if (artifact_type.includes('timeline') || artifact_type.includes('gantt')) issueType = 'Task';
  if (artifact_type.includes('risk')) issueType = 'Bug';

  lines.push('"Issue Type","Summary","Description","Priority","Labels","Sprint","Components","Assignee","Reporter"');

  // Extract first 300 chars as description
  const description = content.replace(/[#*_`|]/g, '').slice(0, 500).replace(/"/g, '""');
  lines.push(`"${issueType}","${title.replace(/"/g, '""')}","${description}","Medium","plan-forge,generated","","","",""`);

  // Extract table data if available
  const tables = extractTableFromMarkdown(content);
  if (tables.length > 0) {
    const firstTable = tables[0];
    // Skip header row if it exists (usually the first row)
    const dataRows = firstTable.slice(1);
    dataRows.forEach((row, idx) => {
      const taskName = row[0] || `Task ${idx + 1}`;
      lines.push(`"Sub-task","${taskName.slice(0, 100).replace(/"/g, '""')}","${row[1] || ''}","Low","plan-forge","","","","""`);
    });
  }

  return lines.join("\n");
}

// MS Project XML format
function generateMSProjectFormat(artifact) {
  const { title, inputs } = artifact;
  const today = new Date().toISOString().split('T')[0];

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<Project xmlns="http://schemas.microsoft.com/project">\n';
  xml += `  <Name>${escapeXml(title)}</Name>\n`;
  xml += '  <Tasks>\n';
  xml += `    <Task>\n`;
  xml += `      <UID>1</UID>\n`;
  xml += `      <ID>1</ID>\n`;
  xml += `      <Name>${escapeXml(title)}</Name>\n`;
  xml += `      <Type>1</Type>\n`;
  xml += `      <IsNull>0</IsNull>\n`;
  xml += `      <CreateDate>${today}</CreateDate>\n`;
  xml += `    </Task>\n`;
  xml += '  </Tasks>\n';
  xml += '</Project>\n';

  return xml;
}

// Asana format: Enhanced with more fields
function generateAsanaFormat(artifact) {
  const { title, inputs, content } = artifact;
  const lines = [];

  lines.push('"Task Name","Assignee","Due Date","Priority","Notes","Dependencies","Start Date","Section"');
  lines.push(`"${title}","","","High","${content.slice(0, 100).replace(/"/g, '""')}","","",""`);

  // Extract table data from markdown
  const tables = extractTableFromMarkdown(content);
  if (tables.length > 0) {
    const firstTable = tables[0];
    const dataRows = firstTable.slice(1);
    dataRows.forEach((row, idx) => {
      const taskName = row[0] || `Task ${idx + 1}`;
      lines.push(`"  └─ ${taskName.slice(0, 80).replace(/"/g, '""')}","","","Medium","${row[1] || ''}","${idx > 0 ? 'Task 1' : ''}","",""`);
    });
  } else if (inputs && inputs.phases) {
    const phases = String(inputs.phases).split('\n').filter(p => p.trim());
    phases.forEach((phase, idx) => {
      lines.push(`"  └─ ${phase.trim()}","","","Medium","Phase ${idx + 1}","${idx > 0 ? 'Task 1' : ''}","",""` );
    });
  }

  return lines.join("\n");
}

// Azure DevOps format: Enhanced with more fields
function generateAzureDevOpsFormat(artifact) {
  const { title, artifact_type, inputs, content } = artifact;
  const lines = [];

  const workItemType = artifact_type === 'project_plan' ? 'Epic' : 'User Story';
  lines.push('"ID","Work Item Type","Title","Description","Priority","Tags","State","Assigned To","Iteration"');
  lines.push(`"","${workItemType}","${title.replace(/"/g, '""')}","${content.slice(0, 300).replace(/"/g, '""')}","2","plan-forge","New","",""` );

  // Extract table data from markdown
  const tables = extractTableFromMarkdown(content);
  if (tables.length > 0) {
    const firstTable = tables[0];
    const dataRows = firstTable.slice(1);
    dataRows.forEach((row, idx) => {
      const itemTitle = row[0] || `Item ${idx + 1}`;
      lines.push(`"","Task","${itemTitle.slice(0, 80).replace(/"/g, '""')}","${row[1] || ''}","3","plan-forge","New","",""` );
    });
  } else if (inputs && inputs.scope) {
    lines.push(`"","Task","${inputs.scope.substring(0, 50).replace(/"/g, '""')}","${inputs.scope.replace(/"/g, '""')}","3","plan-forge","New","",""` );
  }

  return lines.join("\n");
}

// Monday.com format: Enhanced with more fields
function generateMondayFormat(artifact) {
  const { title, inputs, content } = artifact;
  const lines = [];

  lines.push('"Item Name","Status","Owner","Priority","Timeline","Notes","Labels","Assignees"');
  lines.push(`"${title.replace(/"/g, '""')}","Not started","","High","","${content.slice(0, 100).replace(/"/g, '""')}","plan-forge",""` );

  // Extract table data from markdown
  const tables = extractTableFromMarkdown(content);
  if (tables.length > 0) {
    const firstTable = tables[0];
    const dataRows = firstTable.slice(1);
    dataRows.forEach((row, idx) => {
      const itemName = row[0] || `Item ${idx + 1}`;
      lines.push(`"${itemName.slice(0, 80).replace(/"/g, '""')}","Not started","","Medium","","${row[1] || ''}","plan-forge",""` );
    });
  } else if (inputs && inputs.phases) {
    const phases = String(inputs.phases).split('\n').filter(p => p.trim());
    phases.forEach((phase, idx) => {
      lines.push(`"${phase.trim()}","Not started","","Medium","","Phase ${idx + 1}","plan-forge",""` );
    });
  }

  return lines.join("\n");
}

// Generic PM Excel with Gantt-style columns
function generateGenericPMExcel(artifact) {
  const { title, artifact_type, inputs, content } = artifact;

  const workbook = xlsx.utils.book_new();

  const tasksData = [
    { "Task ID": 1, "Task Name": title, "Start Date": "", "End Date": "", "Duration (days)": "", "Owner": "", "Priority": "Medium", "Status": "Planning", "Dependencies": "" }
  ];

  const tasksSheet = xlsx.utils.json_to_sheet(tasksData);
  tasksSheet["!cols"] = [
    { wch: 10 }, { wch: 30 }, { wch: 12 }, { wch: 12 }, { wch: 15 },
    { wch: 15 }, { wch: 10 }, { wch: 15 }, { wch: 15 }
  ];
  xlsx.utils.book_append_sheet(workbook, tasksSheet, "Tasks");

  const resourcesSheet = xlsx.utils.json_to_sheet([
    { "Resource Name": "", "Role": "", "Availability": "100%", "Cost/Day": "" }
  ]);
  resourcesSheet["!cols"] = [{ wch: 20 }, { wch: 20 }, { wch: 15 }, { wch: 15 }];
  xlsx.utils.book_append_sheet(workbook, resourcesSheet, "Resources");

  const summarySheet = xlsx.utils.json_to_sheet([
    { "Project": title },
    { "Type": artifact_type },
    { "Status": "Planning" },
    { "Created": new Date().toISOString() }
  ]);
  xlsx.utils.book_append_sheet(workbook, summarySheet, "Summary");

  return xlsx.write(workbook, { type: "buffer" });
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Trello format: Name, Description, Labels, Due Date
function generateTrelloFormat(artifact) {
  const { title, artifact_type, content } = artifact;
  const lines = [];

  lines.push('"Name","Description","Labels","Due Date"');
  lines.push(`"${title}","${content.slice(0, 200).replace(/"/g, '""')}","plan-forge",""`);

  return lines.join("\n");
}

// Linear format: Enhanced with more fields
function generateLinearFormat(artifact) {
  const { title, content, inputs } = artifact;
  const lines = [];

  lines.push('"Title","Description","Priority","Status","Assignee","Labels","Estimate"');
  lines.push(`"${title.replace(/"/g, '""')}","${content.slice(0, 300).replace(/"/g, '""')}","2","Backlog","","plan-forge",""`);

  // Extract table data from markdown
  const tables = extractTableFromMarkdown(content);
  if (tables.length > 0) {
    const firstTable = tables[0];
    const dataRows = firstTable.slice(1);
    dataRows.forEach((row, idx) => {
      const issueTitle = row[0] || `Issue ${idx + 1}`;
      lines.push(`"${issueTitle.slice(0, 80).replace(/"/g, '""')}","${row[1] || ''}","2","Backlog","","plan-forge",""` );
    });
  } else if (inputs && inputs.phases) {
    const phases = String(inputs.phases).split('\n').filter(p => p.trim());
    phases.forEach((phase, idx) => {
      lines.push(`"${phase.trim()}","${phase.trim()}","2","Backlog","","plan-forge",""` );
    });
  }

  return lines.join("\n");
}

// GitHub Issues format: Title, Body, Labels, Assignee
function generateGitHubFormat(artifact) {
  const { title, content } = artifact;
  const lines = [];

  lines.push('"Title","Body","Labels"');
  lines.push(`"${title.replace(/"/g, '""')}","${content.slice(0, 200).replace(/"/g, '""')}","plan-forge"`);

  // Extract table data from markdown
  const tables = extractTableFromMarkdown(content);
  if (tables.length > 0) {
    const firstTable = tables[0];
    const dataRows = firstTable.slice(1);
    dataRows.forEach((row, idx) => {
      const issueTitle = row[0] || `Issue ${idx + 1}`;
      lines.push(`"${issueTitle.slice(0, 80).replace(/"/g, '""')}","${row[1] || ''}","plan-forge"`);
    });
  }

  return lines.join("\n");
}

// Smartsheet Excel format with proper columns
function generateSmartsheetFormat(artifact) {
  const { title, inputs, content } = artifact;

  const workbook = xlsx.utils.book_new();

  // Extract table data for tasks
  const tables = extractTableFromMarkdown(content);
  const tasksData = [{
    "Task Name": title,
    "Assigned To": "",
    "Due Date": "",
    "Duration": "",
    "Priority": "Medium",
    "Status": "Not Started",
    "% Complete": "0%",
    "Comments": "Exported from Plan Forge"
  }];

  // Add extracted table rows
  if (tables.length > 0) {
    const firstTable = tables[0];
    const dataRows = firstTable.slice(1);
    dataRows.forEach((row, idx) => {
      tasksData.push({
        "Task Name": row[0] || `Task ${idx + 1}`,
        "Assigned To": "",
        "Due Date": "",
        "Duration": "",
        "Priority": "Medium",
        "Status": "Not Started",
        "% Complete": "0%",
        "Comments": row[1] || ""
      });
    });
  }

  const tasksSheet = xlsx.utils.json_to_sheet(tasksData);
  tasksSheet["!cols"] = [
    { wch: 25 }, { wch: 15 }, { wch: 12 }, { wch: 10 },
    { wch: 10 }, { wch: 15 }, { wch: 12 }, { wch: 30 }
  ];
  xlsx.utils.book_append_sheet(workbook, tasksSheet, "Tasks");

  return xlsx.write(workbook, { type: "buffer" });
}

// Trello format: Name, Description, Labels, Due Date
function generateTrelloFormat(artifact) {
  const { title, artifact_type, content } = artifact;
  const lines = [];

  lines.push('"Name","Description","Labels","Due Date"');
  lines.push(`"${title.replace(/"/g, '""')}","${content.slice(0, 200).replace(/"/g, '""')}","plan-forge",""`);

  // Extract table data from markdown
  const tables = extractTableFromMarkdown(content);
  if (tables.length > 0) {
    const firstTable = tables[0];
    const dataRows = firstTable.slice(1);
    dataRows.forEach((row, idx) => {
      const cardName = row[0] || `Card ${idx + 1}`;
      lines.push(`"${cardName.slice(0, 80).replace(/"/g, '""')}","${row[1] || ''}","plan-forge",""`);
    });
  }

  return lines.join("\n");
}

// Wrike format: Enhanced with more fields
function generateWrikeFormat(artifact) {
  const { title, content, inputs } = artifact;
  const lines = [];

  lines.push('"Title","Description","Owner","Start Date","End Date","Priority","Status","Folder"');
  lines.push(`"${title.replace(/"/g, '""')}","${content.slice(0, 300).replace(/"/g, '""')}","","","","High","Active","Projects"`);

  // Extract table data from markdown
  const tables = extractTableFromMarkdown(content);
  if (tables.length > 0) {
    const firstTable = tables[0];
    const dataRows = firstTable.slice(1);
    dataRows.forEach((row, idx) => {
      const taskName = row[0] || `Task ${idx + 1}`;
      lines.push(`"${taskName.slice(0, 80).replace(/"/g, '""')}","${row[1] || ''}","","","","Medium","Active","Projects"` );
    });
  } else if (inputs && inputs.phases) {
    const phases = String(inputs.phases).split('\n').filter(p => p.trim());
    phases.forEach((phase, idx) => {
      lines.push(`"${phase.trim()}","Phase ${idx + 1}","","","","Medium","Active","Projects"` );
    });
  }

  return lines.join("\n");
}

// Notion format: HTML that can be pasted into Notion
function generateNotionFormat(artifact) {
  const { title, content } = artifact;

  let html = '<!DOCTYPE html>\n<html>\n<head><title>' + title + '</title></head>\n<body>\n';
  html += '<h1>' + title + '</h1>\n';
  html += '<h2>Plan Details</h2>\n';
  html += '<p>' + content.replace(/\n/g, '<br/>') + '</p>\n';
  html += '<p><small>Exported from Plan Forge</small></p>\n';
  html += '</body>\n</html>';

  return html;
}

// Confluence markup format
function generateConfluenceFormat(artifact) {
  const { title, content } = artifact;

  let markup = 'h1. ' + title + '\n\n';
  markup += 'h2. Plan Details\n\n';
  markup += content.split('\n').map(line => {
    if (line.startsWith('#')) {
      const level = (line.match(/^#+/)[0].length);
      return 'h' + (level + 1) + '. ' + line.replace(/^#+\s*/, '');
    }
    return line;
  }).join('\n');
  markup += '\n\n_Exported from Plan Forge_\n';

  return markup;
}

// Google Sheets compatible CSV format
function generateGoogleSheetsFormat(artifact) {
  const { title, inputs, content } = artifact;
  const lines = [];

  lines.push('"Project Name","Type","Content","Last Updated"');
  lines.push(`"${title.replace(/"/g, '""')}","Plan","${content.slice(0, 500).replace(/"/g, '""')}","${new Date().toISOString()}"`);

  // Extract table data from markdown
  const tables = extractTableFromMarkdown(content);
  if (tables.length > 0) {
    lines.push("");
    lines.push(",,");
    lines.push('"Item","Details"');
    const firstTable = tables[0];
    const dataRows = firstTable.slice(1);
    dataRows.forEach((row, idx) => {
      lines.push(`"${row[0] || `Item ${idx + 1}`}","${row[1] || ''}"`);
    });
  } else if (inputs && Object.keys(inputs).length > 0) {
    lines.push("");
    lines.push(",,");
    lines.push('"Input Field","Value"');
    Object.entries(inputs).forEach(([key, value]) => {
      lines.push(`"${key}","${String(value).slice(0, 100).replace(/"/g, '""')}"`);
    });
  }

  return lines.join("\n");
}

// Resolve which LLM provider/model/key to use (DB config wins, env fallback).
async function resolveLlmConfig() {
  const { rows } = await pool.query(
    `SELECT provider, model, api_key FROM llm_config ORDER BY updated_at DESC LIMIT 1`
  );
  if (rows.length) {
    return { provider: rows[0].provider, model: rows[0].model, apiKey: rows[0].api_key };
  }
  if (!ANTHROPIC_API_KEY) return null;
  return { provider: "claude", model: "claude-sonnet-4-20250514", apiKey: ANTHROPIC_API_KEY };
}

// Call the configured LLM with a system + user message and return the text content.
// Returns { ok: true, content } or { ok: false, status, error, detail }.
async function callLLM({ provider, model, apiKey, systemPrompt, userMsg, maxTokens = 2500 }) {
  // Claude CLI takes a separate code path — subprocess instead of HTTP.
  if (provider === "claude-cli") {
    try {
      const content = await runClaudeCli({ systemPrompt, userMsg, model });
      if (!content) return { ok: false, status: 502, error: "claude-cli returned empty output" };
      return { ok: true, content };
    } catch (err) {
      return { ok: false, status: 502, error: err.message || "claude-cli failed" };
    }
  }

  let resp;
  try {
    if (provider === "claude") {
      resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          system: systemPrompt,
          messages: [{ role: "user", content: userMsg }],
        }),
      });
    } else if (provider === "openai") {
      resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          temperature: 1,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMsg },
          ],
        }),
      });
    } else if (provider === "gemini") {
      resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: "user", parts: [{ text: userMsg }] }],
            generationConfig: { maxOutputTokens: maxTokens },
          }),
        }
      );
    } else {
      return { ok: false, status: 400, error: `unsupported provider: ${provider}` };
    }
  } catch (err) {
    return { ok: false, status: 502, error: `${provider} api unreachable` };
  }

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    console.error(`[${provider} error]`, resp.status, errText.slice(0, 500));
    return {
      ok: false,
      status: 502,
      error: `${provider} api error: ${resp.status}`,
      detail: errText.slice(0, 500),
    };
  }

  let data;
  try {
    data = await resp.json();
  } catch {
    return { ok: false, status: 502, error: `${provider} returned invalid json` };
  }

  let content = "";
  if (provider === "claude") {
    content = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
  } else if (provider === "openai") {
    content = (data.choices || [])
      .filter((c) => c.message && c.message.content)
      .map((c) => c.message.content)
      .join("\n")
      .trim();
  } else if (provider === "gemini") {
    content = (data.candidates || [])
      .flatMap((c) => (c.content?.parts || []))
      .filter((p) => p.text)
      .map((p) => p.text)
      .join("\n")
      .trim();
  }

  if (!content) return { ok: false, status: 502, error: "empty generation" };
  return { ok: true, content };
}

// revise — generate a new revision of an existing artifact
app.post("/api/artifacts/:id/revise", authRequired, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "invalid id" });

  const { instructions, inputs: inputOverrides, methodology } = req.body || {};
  if (!instructions || typeof instructions !== "string" || !instructions.trim()) {
    return res.status(400).json({ error: "instructions required" });
  }
  const trimmedInstructions = instructions.trim().slice(0, 4000);
  const normMethodology = normalizeMethodology(methodology);

  // Load source artifact (auth-checked)
  let source;
  try {
    const { rows } = await pool.query(
      `SELECT id, user_id, artifact_type, title, inputs, content, parent_id
       FROM artifacts WHERE id = $1 AND user_id = $2`,
      [id, req.user.sub]
    );
    if (!rows.length) return res.status(404).json({ error: "not found" });
    source = rows[0];
  } catch (err) {
    console.error("[revise: load source]", err);
    return res.status(500).json({ error: "failed to load source artifact" });
  }

  if (!VALID_TYPES.includes(source.artifact_type)) {
    return res.status(400).json({ error: "source artifact has unknown type" });
  }

  const rootId = source.parent_id || source.id;
  const inputs =
    inputOverrides && typeof inputOverrides === "object" ? inputOverrides : source.inputs;

  let cfg;
  try {
    cfg = await resolveLlmConfig();
  } catch (err) {
    console.error("[revise: config]", err);
    return res.status(500).json({ error: "failed to fetch config" });
  }
  if (!cfg) return res.status(500).json({ error: "server not configured: no LLM config found" });

  const userMsg = buildRevisePrompt(source.artifact_type, inputs, source.content, trimmedInstructions, normMethodology);
  const result = await callLLM({
    provider: cfg.provider,
    model: cfg.model,
    apiKey: cfg.apiKey,
    systemPrompt: SYSTEM_PROMPT,
    userMsg,
    maxTokens: 2500,
  });

  if (!result.ok) {
    return res.status(result.status || 502).json({
      error: result.error,
      ...(result.detail ? { detail: result.detail } : {}),
    });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO artifacts
         (user_id, artifact_type, title, inputs, content, parent_id, revision, revision_note)
       SELECT $1, $2, $3, $4, $5, $6,
              COALESCE(MAX(revision), 0) + 1,
              $7
       FROM artifacts
       WHERE user_id = $1 AND (id = $6 OR parent_id = $6)
       RETURNING id, artifact_type, title, inputs, content, parent_id, revision, revision_note, created_at`,
      [req.user.sub, source.artifact_type, source.title, inputs, result.content, rootId, trimmedInstructions]
    );
    res.json({ artifact: rows[0] });
  } catch (err) {
    console.error("[revise: save]", err);
    res.status(500).json({ error: "failed to save revision" });
  }
});

// generate + save
app.post("/api/artifacts", authRequired, async (req, res) => {
  const { artifact_type, title, inputs, methodology, source_document } = req.body || {};

  if (!VALID_TYPES.includes(artifact_type))
    return res.status(400).json({ error: "invalid artifact_type" });
  if (!inputs || typeof inputs !== "object")
    return res.status(400).json({ error: "inputs object required" });

  const safeSourceDocument =
    typeof source_document === "string" && source_document.trim()
      ? source_document.slice(0, 12000)
      : null;

  const userMsg = buildUserPrompt(artifact_type, inputs, normalizeMethodology(methodology), safeSourceDocument);

  // fetch config from database
  let configRows, provider, model, apiKey;
  try {
    ({ rows: configRows } = await pool.query(
      `SELECT provider, model, api_key FROM llm_config ORDER BY updated_at DESC LIMIT 1`
    ));

    if (!configRows.length) {
      if (!ANTHROPIC_API_KEY) {
        return res.status(500).json({ error: "server not configured: no LLM config found" });
      }
      provider = "claude";
      model = "claude-sonnet-4-20250514";
      apiKey = ANTHROPIC_API_KEY;
    } else {
      provider = configRows[0].provider;
      model = configRows[0].model;
      apiKey = configRows[0].api_key;
    }
  } catch (err) {
    console.error("[fetch config]", err);
    return res.status(500).json({ error: "failed to fetch config" });
  }

  let llmResp, llmData;
  let cliContent = null;

  if (provider === "claude-cli") {
    try {
      cliContent = await runClaudeCli({ systemPrompt: SYSTEM_PROMPT, userMsg, model });
      if (!cliContent) return res.status(502).json({ error: "claude-cli returned empty output" });
    } catch (err) {
      console.error("[claude-cli error]", err.message);
      return res.status(502).json({ error: err.message });
    }
  } else if (provider === "claude") {
    try {
      llmResp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: model,
          max_tokens: 2500,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: userMsg }],
        }),
      });
    } catch (err) {
      console.error("[anthropic network]", err);
      return res.status(502).json({ error: "anthropic api unreachable" });
    }

    if (!llmResp.ok) {
      const errText = await llmResp.text().catch(() => "");
      console.error("[anthropic error]", llmResp.status, errText.slice(0, 500));
      return res.status(502).json({
        error: `anthropic api error: ${llmResp.status}`,
        detail: errText.slice(0, 500),
      });
    }

    try {
      llmData = await llmResp.json();
    } catch (err) {
      return res.status(502).json({ error: "anthropic returned invalid json" });
    }
  } else if (provider === "openai") {
    try {
      llmResp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: model,
          max_tokens: 2500,
          temperature: 1,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userMsg }
          ],
        }),
      });
    } catch (err) {
      console.error("[openai network]", err);
      return res.status(502).json({ error: "openai api unreachable" });
    }

    if (!llmResp.ok) {
      const errText = await llmResp.text().catch(() => "");
      console.error("[openai error]", llmResp.status, errText.slice(0, 500));
      return res.status(502).json({
        error: `openai api error: ${llmResp.status}`,
        detail: errText.slice(0, 500),
      });
    }

    try {
      llmData = await llmResp.json();
    } catch (err) {
      return res.status(502).json({ error: "openai returned invalid json" });
    }
  } else if (provider === "gemini") {
    try {
      llmResp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
            contents: [{ role: "user", parts: [{ text: userMsg }] }],
            generationConfig: { maxOutputTokens: 2500 },
          }),
        }
      );
    } catch (err) {
      console.error("[gemini network]", err);
      return res.status(502).json({ error: "gemini api unreachable" });
    }

    if (!llmResp.ok) {
      const errText = await llmResp.text().catch(() => "");
      console.error("[gemini error]", llmResp.status, errText.slice(0, 500));
      return res.status(502).json({
        error: `gemini api error: ${llmResp.status}`,
        detail: errText.slice(0, 500),
      });
    }

    try {
      llmData = await llmResp.json();
    } catch (err) {
      return res.status(502).json({ error: "gemini returned invalid json" });
    }
  } else {
    return res.status(400).json({ error: `unsupported provider: ${provider}` });
  }

  let content = "";
  if (provider === "claude-cli") {
    content = cliContent;
  } else if (provider === "claude") {
    content = (llmData.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
  } else if (provider === "openai") {
    content = (llmData.choices || [])
      .filter((c) => c.message && c.message.content)
      .map((c) => c.message.content)
      .join("\n")
      .trim();
  } else if (provider === "gemini") {
    content = (llmData.candidates || [])
      .flatMap((c) => (c.content?.parts || []))
      .filter((p) => p.text)
      .map((p) => p.text)
      .join("\n")
      .trim();
  }

  if (!content) return res.status(502).json({ error: "empty generation" });

  const stamp = new Date().toISOString().slice(0, 10);
  const cleanTitle =
    (title && String(title).trim().slice(0, 250)) ||
    `${artifact_type.replace(/_/g, " ")} — ${stamp}`;

  try {
    const { rows } = await pool.query(
      `INSERT INTO artifacts (user_id, artifact_type, title, inputs, content)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, artifact_type, title, inputs, content, parent_id, revision, revision_note, created_at`,
      [req.user.sub, artifact_type, cleanTitle, inputs, content]
    );
    res.json({ artifact: rows[0] });
  } catch (err) {
    console.error("[save artifact]", err);
    res.status(500).json({ error: "failed to save artifact" });
  }
});

// Single-service deploy: serve the frontend from ../public when bundled.
// Local docker-compose uses nginx in front, so this block is a no-op there.
const PUBLIC_DIR = path.join(__dirname, "..", "public");
if (fs.existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    res.sendFile(path.join(PUBLIC_DIR, "index.html"));
  });
}

// ------- boot -------
initDb()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`[plan-forge] backend listening on :${PORT}`);
    });
  })
  .catch((err) => {
    console.error("[boot] db init failed:", err);
    process.exit(1);
  });
