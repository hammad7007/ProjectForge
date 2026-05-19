// Claude CLI subprocess wrapper.
// Lets the backend run `claude --print "<prompt>"` instead of calling the
// Anthropic REST API. The CLI is installed globally in the Dockerfile;
// the user authenticates it once via `docker compose exec backend claude /login`.
// Token persists at /root/.claude.json (mounted on the claude_home volume).

const { spawn } = require("child_process");

const DEFAULT_TIMEOUT_MS = 180_000; // 3 min — large artifacts take time
const DEFAULT_BINARY = "claude";

const AUTH_ERROR_HINTS = [
  "not logged in",
  "/login",
  "please log in",
  "authenticate",
  "invalid api key",
  "unauthorized",
];

function looksLikeAuthError(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return AUTH_ERROR_HINTS.some((h) => lower.includes(h));
}

// Run the Claude CLI with the given prompt and return the text output.
// systemPrompt is folded into the user message because `claude --print`
// doesn't take a separate system flag in non-interactive mode.
function runClaudeCli({ systemPrompt, userMsg, model, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const args = ["--print"];
    if (model) args.push("--model", model);

    const combined = systemPrompt
      ? `${systemPrompt}\n\n---\n\n${userMsg}`
      : userMsg;

    // CRITICAL: strip ANTHROPIC_API_KEY from the subprocess env. The Claude CLI
    // prioritizes that env var over the OAuth token in ~/.claude.json — so if
    // the env var is invalid (or even set at all when the user wants subscription
    // auth), every call fails with "Invalid API key" even though OAuth is fine.
    const subprocEnv = { ...process.env };
    delete subprocEnv.ANTHROPIC_API_KEY;

    const child = spawn(DEFAULT_BINARY, args, {
      env: subprocEnv,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      reject(new Error(`Claude CLI timed out after ${timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`));
    }, timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.stdout.on("data", (b) => { stdout += b.toString(); });
    child.stderr.on("data", (b) => { stderr += b.toString(); });

    child.on("error", (err) => {
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        reject(new Error(
          "Claude CLI not found on PATH inside the backend container. " +
          "Rebuild with: docker compose up -d --build backend"
        ));
      } else {
        reject(err);
      }
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return;
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      const combinedErr = (stderr + stdout).slice(0, 1000);
      if (looksLikeAuthError(combinedErr)) {
        reject(new Error(
          "Claude CLI is not authenticated. Click '🔌 Connect Claude' in the header to sign in with your subscription."
        ));
      } else {
        const detail = (stderr || stdout).slice(0, 400).trim();
        reject(new Error(`Claude CLI exited ${code}${detail ? `: ${detail}` : ""}`));
      }
    });

    // Send the prompt over stdin so we don't run into argv length limits or
    // shell-escaping issues with multi-paragraph prompts.
    child.stdin.write(combined);
    child.stdin.end();
  });
}

// Quick health check: is the binary on PATH and authenticated?
// Runs `claude --print "ping"` with a short timeout — auth issues surface
// as a specific error message; binary-missing surfaces as ENOENT.
async function checkClaudeCli() {
  try {
    const out = await runClaudeCli({
      userMsg: "Reply with the single word: pong",
      timeoutMs: 30_000,
    });
    return {
      installed: true,
      authenticated: true,
      response: out.slice(0, 200),
    };
  } catch (err) {
    const msg = err.message || String(err);
    if (msg.includes("not found on PATH")) {
      return { installed: false, authenticated: false, error: msg };
    }
    if (msg.toLowerCase().includes("not authenticated") || looksLikeAuthError(msg)) {
      return { installed: true, authenticated: false, error: msg };
    }
    return { installed: true, authenticated: false, error: msg };
  }
}

module.exports = { runClaudeCli, checkClaudeCli };
