// In-app driver for `claude setup-token` OAuth flow.
// Spawns the CLI in a pseudo-terminal (because it refuses to print to a non-TTY),
// captures the OAuth URL it prints, waits for its paste prompt, then sends the
// user-supplied code wrapped in bracketed-paste markers so the Ink-based UI
// actually picks it up. The completed token is written by the CLI itself to
// /root/.claude.json on the backend container's filesystem.

const pty = require("node-pty");
const crypto = require("crypto");

const SESSION_TTL_MS = 10 * 60 * 1000;     // abandoned sessions cleaned up after 10 min
const SESSION_REUSE_MAX_AGE_MS = 9 * 60 * 1000; // reuse a pending session if younger than this
const URL_DETECT_TIMEOUT_MS = 20000;
const PROMPT_DETECT_TIMEOUT_MS = 15000;    // how long to wait for "Paste code" prompt after URL
const SUBMIT_TIMEOUT_MS = 60000;
const CHAR_TYPE_DELAY_MS = 35;             // per-char delay when typing the code into the CLI

const sessions = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) {
      try { s.pty.kill(); } catch { /* already dead */ }
      sessions.delete(id);
    }
  }
}, 60000).unref();

function newSessionId() {
  return crypto.randomBytes(8).toString("hex");
}

function stripAnsi(s) {
  return s
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/\[[0-9;]*[A-Za-z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\r/g, "");
}

// The CLI's "Paste code here" prompt accepts the raw value from Anthropic's
// callback. Anthropic returns the code as `CODE#STATE` (or in a URL with the
// state in the fragment / query). The Claude CLI needs BOTH parts together —
// stripping the `#state` half was the root cause of "Invalid code" rejections
// after a successful authorize. Always preserve the full `code#state` form.
function normalizeCode(raw) {
  let s = String(raw || "").trim();
  if (!s) return "";
  // Strip surrounding quotes if any
  s = s.replace(/^["'`]+|["'`]+$/g, "").trim();

  // Try URL parse if it has a scheme
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      const code = u.searchParams.get("code");
      if (code) {
        // state may be in ?state=, in the fragment as #state=, or be the
        // entire fragment after #. Re-assemble code#state if any state exists.
        let state = u.searchParams.get("state") || "";
        if (!state && u.hash) {
          const hashBody = u.hash.replace(/^#/, "");
          try {
            const hashParams = new URLSearchParams(hashBody);
            state = hashParams.get("state") || hashBody || "";
          } catch {
            state = hashBody || "";
          }
        }
        return state ? `${code}#${state}` : code;
      }
    } catch { /* fall through */ }
  }
  // Match `?code=` or `&code=` anywhere (handles no-scheme URLs, or text
  // around a URL fragment). Also pick up `state=` if present.
  const codeMatch = s.match(/[?&]code=([^&\s#]+)/);
  if (codeMatch) {
    let code = codeMatch[1];
    try { code = decodeURIComponent(code); } catch { /* keep as-is */ }
    const stateMatch = s.match(/[?&#]state=([^&\s#]+)/);
    let state = stateMatch ? stateMatch[1] : "";
    if (state) {
      try { state = decodeURIComponent(state); } catch { /* keep as-is */ }
    }
    return state ? `${code}#${state}` : code;
  }
  // Bare `code#state` form — keep as-is. The CLI parses both halves itself.
  if (s.includes("#")) {
    return s;
  }
  // Bare code with percent-encoding (rare but possible)
  if (/%[0-9A-Fa-f]{2}/.test(s)) {
    try { return decodeURIComponent(s); } catch { /* ignore */ }
  }
  return s;
}

async function startOAuthFlow(userId) {
  // Reuse an existing pending session for this user when possible. Each click
  // of Connect would otherwise spawn a new CLI subprocess with a fresh PKCE
  // pair; if the user authorizes in an older browser tab, the code returned
  // wouldn't match the latest session's verifier and Anthropic rejects it as
  // "Invalid code." Idempotent connect avoids this whole class of bug.
  const now = Date.now();
  for (const [existingId, s] of sessions) {
    if (s.userId !== userId) continue;
    if (s.status !== "pending" || !s.url) continue;
    if (now - s.createdAt < SESSION_REUSE_MAX_AGE_MS) {
      return { sessionId: existingId, url: s.url, reused: true };
    }
    // Stale pending session for this user — kill it before spawning a new one.
    try { s.pty.kill(); } catch { /* already dead */ }
    sessions.delete(existingId);
  }

  const sessionId = newSessionId();
  // Strip ANTHROPIC_API_KEY — when set with an invalid value, the CLI errors
  // out early ("Invalid API key") instead of running the OAuth flow.
  const subprocEnv = { ...process.env, TERM: "xterm-256color" };
  delete subprocEnv.ANTHROPIC_API_KEY;

  const child = pty.spawn("claude", ["setup-token"], {
    name: "xterm-256color",
    cols: 1000,
    rows: 30,
    cwd: process.env.HOME || "/root",
    env: subprocEnv,
  });

  const session = {
    pty: child,
    output: "",
    url: null,
    status: "pending",
    createdAt: Date.now(),
    userId: userId || null,
  };
  sessions.set(sessionId, session);

  child.onData((data) => { session.output += data; });
  child.onExit(({ exitCode }) => {
    session.status = exitCode === 0 ? "completed" : "failed";
    session.exitCode = exitCode;
  });

  const urlRegex = /https?:\/\/[^\s)]+/;
  const start = Date.now();

  while (Date.now() - start < URL_DETECT_TIMEOUT_MS) {
    if (session.status !== "pending") {
      const out = stripAnsi(session.output);
      sessions.delete(sessionId);
      throw new Error(`setup-token exited before printing a URL. Output: ${out.slice(0, 500)}`);
    }
    const cleaned = stripAnsi(session.output);
    const match = cleaned.match(urlRegex);
    if (match) {
      const url = match[0];
      const looksComplete = url.includes("client_id=") && url.includes("redirect_uri=");
      if (looksComplete) {
        session.url = url;
        return { sessionId, url, reused: false };
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  try { child.kill(); } catch { /* ignore */ }
  sessions.delete(sessionId);
  throw new Error(
    `OAuth URL not detected within ${URL_DETECT_TIMEOUT_MS}ms. ` +
    `Raw output: ${stripAnsi(session.output).slice(0, 500)}`
  );
}

async function waitForPrompt(session, timeoutMs) {
  // The CLI prints "Paste code here if prompted >" right before it's ready.
  // But the words are drawn one at a time with cursor-positioning escapes
  // ("ESC[1C Paste ESC[1C code ESC[1C here ...") so after stripAnsi the spaces
  // are GONE and we see "Pastecodehereifprompted>". Match the unspaced form.
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (session.status !== "pending") return false;
    const cleaned = stripAnsi(session.output);
    if (/paste\s*code\s*here/i.test(cleaned)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function submitOAuthCode({ sessionId, code }) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("OAuth session not found or expired. Click Connect again.");
  if (session.status !== "pending") {
    sessions.delete(sessionId);
    throw new Error(`Session is ${session.status}, cannot submit code.`);
  }

  const normalized = normalizeCode(code);
  if (!normalized) throw new Error("Empty code");

  // Diagnostic (no secret leakage): log shape only. Tells us at a glance
  // whether we're sending bare code vs code#state, and whether the lengths
  // match what Anthropic expects.
  const hashIdx = normalized.indexOf("#");
  const shape = hashIdx >= 0
    ? `code#state (codeLen=${hashIdx}, stateLen=${normalized.length - hashIdx - 1})`
    : `bare code (len=${normalized.length})`;
  console.log(`[oauth/submit] session=${sessionId.slice(0, 8)} normalized: ${shape}`);

  // Wait for the prompt to actually appear before writing anything.
  const promptReady = await waitForPrompt(session, PROMPT_DETECT_TIMEOUT_MS);
  if (!promptReady) {
    const tail = stripAnsi(session.output).slice(-600);
    sessions.delete(sessionId);
    try { session.pty.kill(); } catch { /* ignore */ }
    throw new Error(
      `Claude CLI never showed the "Paste code" prompt. Output:\n${tail || "(empty)"}`
    );
  }

  // Snapshot output length so we can show only post-submit output if it fails.
  const outBefore = session.output.length;

  // The CLI prompt masks input as `*` chars — it's a key-by-key Ink input,
  // not a paste-aware editor. Bracketed-paste markers corrupt it (escape
  // sequences leak into the code). Type the code one character at a time
  // with small delays, like a real user typing. CHAR_TYPE_DELAY_MS gives the
  // Ink renderer enough time to redraw between keys; 20ms was tight enough
  // that occasional characters could be dropped on a busy container.
  for (const ch of normalized) {
    session.pty.write(ch);
    await new Promise((r) => setTimeout(r, CHAR_TYPE_DELAY_MS));
  }
  await new Promise((r) => setTimeout(r, 200));
  session.pty.write("\r");

  // Patterns that indicate Anthropic rejected the code — surface these
  // immediately rather than waiting for the 60s timeout.
  const lenHint = normalized.length < 30
    ? `You pasted ${normalized.length} chars — that's too short; codes are usually 40+.`
    : `Code sent: ${normalized.length} chars (looks reasonable).`;
  const commonCauses =
    `Most common causes (in order of likelihood):\n` +
    `1. The URL you authorized in the browser was from an EARLIER "Connect with Claude" click — ` +
    `each click generates a new PKCE pair. The browser tab from the previous click is now invalid.\n` +
    `2. The code expired (codes are valid only a couple of minutes).\n` +
    `3. Only PART of the code was copied (try copying the WHOLE URL from the address bar).\n\n` +
    `Fix: click "▸ Connect with Claude" RIGHT NOW for a fresh URL, complete the authorize in the ` +
    `new tab that opens, then immediately come back and paste the URL or code here.`;
  const errorMap = [
    { re: /invalid code.{0,40}full code was copied/i, kind: "invalid_code",
      msg: `Anthropic rejected the code. ${lenHint}\n\n${commonCauses}` },
    { re: /code.{0,20}expired/i, kind: "expired",
      msg: `The authorization code expired (codes are valid only a couple of minutes). ${commonCauses}` },
    { re: /oauth error.{0,200}status code 4\d\d/i, kind: "pkce_mismatch",
      msg: `Anthropic returned 400. ${commonCauses}` },
    { re: /oauth error/i, kind: "generic_oauth",
      msg: `OAuth exchange failed. ${commonCauses}` },
    { re: /authorization.{0,20}failed/i, kind: "auth_failed",
      msg: `Authorization failed. ${commonCauses}` },
  ];

  function detectError(buf) {
    for (const { re, msg } of errorMap) {
      const m = buf.match(re);
      if (m) {
        const idx = buf.indexOf(m[0]);
        const context = buf.slice(Math.max(0, idx - 50), idx + 250).trim();
        return { msg, context };
      }
    }
    return null;
  }

  const start = Date.now();
  let detectedError = null;
  while (Date.now() - start < SUBMIT_TIMEOUT_MS) {
    if (session.status !== "pending") break;
    const sinceSubmitNow = stripAnsi(session.output.slice(outBefore));
    detectedError = detectError(sinceSubmitNow);
    if (detectedError) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  const finalOutput = stripAnsi(session.output).slice(-1500);
  const sinceSubmit = stripAnsi(session.output.slice(outBefore)).slice(-1500);
  const success = session.status === "completed" && !detectedError;
  sessions.delete(sessionId);

  if (detectedError) {
    try { session.pty.kill(); } catch { /* ignore */ }
    throw new Error(`${detectedError.msg}\n\n(CLI said: ${detectedError.context})`);
  }

  if (!success) {
    if (session.status === "pending") {
      try { session.pty.kill(); } catch { /* ignore */ }
      throw new Error(
        `Authentication timed out (${SUBMIT_TIMEOUT_MS / 1000}s). CLI output after submit:\n` +
        (sinceSubmit || "(no output)").slice(-800)
      );
    }
    throw new Error(`Authentication failed (exit ${session.exitCode}). CLI output:\n${finalOutput}`);
  }

  return { success: true, output: finalOutput };
}

module.exports = { startOAuthFlow, submitOAuthCode };
