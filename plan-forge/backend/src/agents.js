// LangGraph 5-agent pipeline for artifact generation.
//
//   Retriever  →  Planner  →  Drafter  →  Critic  →  Refiner
//      |                                                ^
//      |__ pgvector cosine-similar past artifacts ______|
//                  (top-3 user examples)
//
// Each node calls the configured LLM via the `callLLM` callback the server
// passes in (so we don't duplicate provider/credential handling here).
// State flows top-to-bottom; if any node errors, the caller falls back to
// the legacy single-call generator.
//
// Node responsibilities:
//   Retriever — find the 3 most similar past artifacts (same user, same
//               artifact_type if possible) via pgvector cosine distance.
//               Pure DB; no LLM call.
//   Planner   — produce a short structured outline from inputs + source
//               document + retrieved examples. ~400 tokens.
//   Drafter   — turn the plan into full markdown following the existing
//               INSTRUCTIONS template for that artifact_type. ~2500 tokens.
//   Critic    — review the draft for gaps, factual drift from the source
//               document, and section completeness. Returns a bullet list
//               of issues OR "NO_ISSUES" if the draft is acceptable. ~400 tokens.
//   Refiner   — if Critic flagged issues, rewrite the draft to address
//               them. If Critic returned NO_ISSUES, this is a passthrough.
//               ~2500 tokens.
//
// The Refiner output is what gets saved to the artifacts table.

const { StateGraph, END } = require("@langchain/langgraph");
const { pool, hasVector } = require("./db");
const { embed, toPgVector } = require("./embeddings");

// ============================================================
//   Per-node system prompts
// ============================================================
// These layer on top of the shared SYSTEM_PROMPT from prompts.js — the
// server passes that in as `baseSystem` so we keep one source of truth
// for the "Plan Forge PM persona" while specialising per role.

const PLANNER_SYSTEM = `
You are the PLANNER in a multi-agent pipeline that generates project-management artifacts.

Your job: produce a TIGHT outline (not the full artifact) that the Drafter will expand.
Read the artifact_type, the user inputs, the optional uploaded source document, and the
similar past artifacts (if any) — then output a short structured plan:

# Plan
- Sections to include (with one-line description of each)
- Specific facts/numbers/dates/people from the source document to weave in
- Section-by-section notes on what should be a table, what should be a Mermaid diagram
- Anything in the inputs that contradicts the source document — flag it

Be concrete. Reference exact phrases from the source document. No padding.
Maximum 350 words. Output as markdown.
`.trim();

const DRAFTER_SYSTEM = `
You are the DRAFTER in a multi-agent pipeline that generates project-management artifacts.

Your job: produce the FULL artifact markdown by expanding the Planner's outline.
You receive: the artifact_type instructions (authoritative template), the user inputs,
the optional uploaded source document, the Planner's outline, and similar past artifacts
as style references.

Follow the artifact_type instructions exactly for structure, headings, and required
sections. Prefer facts from the source document over generic assumptions. Use real
Mermaid syntax for any timelines/charts. Use real markdown tables (no ASCII art).

Do NOT include meta-commentary like "here is the draft" or "I have produced…".
Output ONLY the markdown artifact.
`.trim();

const CRITIC_SYSTEM = `
You are the CRITIC in a multi-agent pipeline that generates project-management artifacts.

Your job: review the Drafter's output for problems. Be terse and specific.

Check:
- Did the draft miss any required section from the artifact_type template?
- Are there facts in the source document that the draft ignored or contradicted?
- Are the Mermaid blocks syntactically valid?
- Are the tables coherent (matching column counts, no empty rows)?
- Is anything vague where the inputs gave specifics (names, dates, numbers)?
- Are there hallucinated specifics not supported by inputs or source document?

If the draft is acceptable, output exactly: NO_ISSUES

Otherwise output:
ISSUES:
- <issue 1>
- <issue 2>
...

Maximum 300 words. Be ruthless but fair — false positives waste the Refiner's tokens.
`.trim();

const REFINER_SYSTEM = `
You are the REFINER in a multi-agent pipeline that generates project-management artifacts.

Your job: rewrite the Drafter's output to address the Critic's feedback.
You receive: the original draft, the Critic's issue list, the user inputs, and the
optional source document.

Apply ONLY the Critic's feedback. Do not introduce new sections or restructure
unprompted. Preserve everything the Critic didn't flag.

If the Critic said NO_ISSUES, return the original draft unchanged.

Do NOT include meta-commentary. Output ONLY the final markdown artifact.
`.trim();

// ============================================================
//   Retrieval: top-K similar past artifacts via pgvector cosine
// ============================================================

// Find up-to-K similar past artifacts for a (user, artifact_type, query)
// triple. Used by the Retriever node. Returns [] if pgvector is off, if
// embedding fails, or if the user has no prior artifacts.
async function retrieveSimilar({ userId, artifactType, queryText, k = 3 }) {
  if (!hasVector()) return [];
  let queryVec;
  try {
    queryVec = await embed(queryText);
  } catch (err) {
    console.warn("[agents/retriever] embed failed:", err.message);
    return [];
  }
  const queryLiteral = toPgVector(queryVec);

  try {
    // Prefer same artifact_type — those examples teach the model the format.
    // Fall back to any artifact if there aren't enough of the same type.
    const sameType = await pool.query(
      `SELECT id, title, content, artifact_type,
              1 - (embedding <=> $1::vector) AS similarity
         FROM artifacts
        WHERE user_id = $2
          AND artifact_type = $3
          AND embedding IS NOT NULL
        ORDER BY embedding <=> $1::vector
        LIMIT $4`,
      [queryLiteral, userId, artifactType, k]
    );
    let rows = sameType.rows;
    if (rows.length < k) {
      const need = k - rows.length;
      const seen = new Set(rows.map((r) => r.id));
      const anyType = await pool.query(
        `SELECT id, title, content, artifact_type,
                1 - (embedding <=> $1::vector) AS similarity
           FROM artifacts
          WHERE user_id = $2
            AND embedding IS NOT NULL
          ORDER BY embedding <=> $1::vector
          LIMIT $3`,
        [queryLiteral, userId, need + rows.length]
      );
      for (const r of anyType.rows) {
        if (seen.has(r.id)) continue;
        rows.push(r);
        if (rows.length >= k) break;
      }
    }
    // Drop weak matches (cosine < 0.25 means barely related). Pgvector's
    // `<=>` returns distance, so similarity = 1 - distance.
    return rows.filter((r) => r.similarity >= 0.25).slice(0, k);
  } catch (err) {
    console.warn("[agents/retriever] query failed:", err.message);
    return [];
  }
}

// Compact a retrieved artifact into a short example block.
// Drafts can be huge (10k+ chars) — we cap each example so the cumulative
// prompt stays under control.
function formatExample(row, idx) {
  const body = String(row.content || "").slice(0, 1500);
  return `### Example ${idx + 1} — "${row.title}" (${row.artifact_type}, similarity ${row.similarity.toFixed(2)})\n\n${body}\n`;
}

// ============================================================
//   Graph
// ============================================================

// Build a query string from the user's inputs + uploaded source document
// to use as the retrieval key. Combines the highest-signal fields.
function buildQueryText({ inputs, sourceDocument }) {
  const parts = [];
  if (inputs && typeof inputs === "object") {
    for (const [k, v] of Object.entries(inputs)) {
      if (v == null) continue;
      const s = String(v).trim();
      if (!s) continue;
      parts.push(`${k}: ${s}`);
    }
  }
  if (sourceDocument) parts.push(String(sourceDocument).slice(0, 2000));
  return parts.join("\n").slice(0, 4000) || "untitled";
}

// LangGraph 0.4+ takes a channel-style state schema. Each channel describes
// how that field is reduced when multiple nodes write it; here we use
// last-write-wins since the graph is linear.
const channels = {
  inputs:          { value: (_, y) => y, default: () => ({}) },
  sourceDocument:  { value: (_, y) => y, default: () => null },
  artifactType:    { value: (_, y) => y, default: () => "" },
  methodology:     { value: (_, y) => y, default: () => null },
  userId:          { value: (_, y) => y, default: () => null },
  baseSystem:      { value: (_, y) => y, default: () => "" },
  artifactInstruction: { value: (_, y) => y, default: () => "" },
  examples:        { value: (_, y) => y, default: () => [] },
  plan:            { value: (_, y) => y, default: () => "" },
  draft:           { value: (_, y) => y, default: () => "" },
  critique:        { value: (_, y) => y, default: () => "" },
  final:           { value: (_, y) => y, default: () => "" },
};

// `callLLM` is injected by the caller (server.js exposes it). It returns
// `{ ok, content, error, status, detail }`. We treat any !ok as a graph
// abort so the caller can fall back to the single-call generator.
function makeGraph(callLLM) {
  const graph = new StateGraph({ channels });

  // ---------------- Retriever ----------------
  graph.addNode("retriever", async (state) => {
    if (!state.userId) return { examples: [] };
    const queryText = buildQueryText({
      inputs: state.inputs,
      sourceDocument: state.sourceDocument,
    });
    const rows = await retrieveSimilar({
      userId: state.userId,
      artifactType: state.artifactType,
      queryText,
      k: 3,
    });
    return { examples: rows };
  });

  // ---------------- Planner ----------------
  graph.addNode("planner", async (state) => {
    const examplesBlock = state.examples.length
      ? `\n\nSimilar past artifacts (style + structure reference, do NOT copy verbatim):\n\n${state.examples.map(formatExample).join("\n---\n")}\n`
      : "";
    const sourceBlock = state.sourceDocument
      ? `\n\nSource document (verbatim user-uploaded content — treat as authoritative project context):\n---\n${String(state.sourceDocument).slice(0, 18000)}\n---\n`
      : "";
    const userMsg =
      `Artifact type: ${state.artifactType}\n` +
      (state.methodology ? `Methodology: ${state.methodology}\n` : "") +
      `\nUser inputs (JSON):\n${JSON.stringify(state.inputs, null, 2)}\n` +
      sourceBlock +
      examplesBlock +
      `\n\nProduce the outline now. List every section in the artifact template — do not skip any.`;

    const r = await callLLM({
      systemPrompt: `${state.baseSystem}\n\n${PLANNER_SYSTEM}`,
      userMsg,
      maxTokens: 1500,
    });
    if (!r.ok) throw new Error(`planner failed: ${r.error}`);
    return { plan: r.content };
  });

  // ---------------- Drafter ----------------
  graph.addNode("drafter", async (state) => {
    const examplesBlock = state.examples.length
      ? `\n\nStyle references (similar past artifacts, do NOT copy verbatim):\n\n${state.examples.map(formatExample).join("\n---\n")}\n`
      : "";
    const sourceBlock = state.sourceDocument
      ? `\n\nSource document (authoritative project context, prefer its facts over generic assumptions):\n---\n${String(state.sourceDocument).slice(0, 22000)}\n---\n`
      : "";
    const userMsg =
      `Artifact type: ${state.artifactType}\n` +
      (state.methodology ? `Methodology: ${state.methodology}\n` : "") +
      `\n## Artifact instructions (authoritative template):\n${state.artifactInstruction}\n` +
      `\n## User inputs:\n${JSON.stringify(state.inputs, null, 2)}\n` +
      sourceBlock +
      `\n## Planner outline (follow this structure):\n${state.plan}\n` +
      examplesBlock +
      `\nProduce the full markdown artifact now. Output only markdown.\n` +
      `IMPORTANT — completeness:\n` +
      `* Include EVERY section in the template; do not omit or merge them.\n` +
      `* Preserve EVERY fact, name, number, date, and dependency from the source document and inputs — never paraphrase them away.\n` +
      `* Prefer thoroughness over brevity. Use the full output budget if needed.\n` +
      `* If you start running short, do not truncate sections — keep tables compact but never drop rows that carry data from the source document.`;

    const r = await callLLM({
      systemPrompt: `${state.baseSystem}\n\n${DRAFTER_SYSTEM}`,
      userMsg,
      maxTokens: 8000,
    });
    if (!r.ok) throw new Error(`drafter failed: ${r.error}`);
    return { draft: r.content };
  });

  // ---------------- Critic ----------------
  graph.addNode("critic", async (state) => {
    const sourceBlock = state.sourceDocument
      ? `\n## Source document (compare draft facts against this):\n---\n${String(state.sourceDocument).slice(0, 6000)}\n---\n`
      : "";
    const userMsg =
      `Artifact type: ${state.artifactType}\n` +
      `\n## Artifact template (the draft should follow this):\n${state.artifactInstruction}\n` +
      `\n## User inputs:\n${JSON.stringify(state.inputs, null, 2)}\n` +
      sourceBlock +
      `\n## Draft to review:\n${state.draft}\n` +
      `\nReview now.`;

    const r = await callLLM({
      systemPrompt: `${state.baseSystem}\n\n${CRITIC_SYSTEM}`,
      userMsg,
      maxTokens: 1500,
    });
    if (!r.ok) throw new Error(`critic failed: ${r.error}`);
    return { critique: r.content };
  });

  // ---------------- Refiner ----------------
  graph.addNode("refiner", async (state) => {
    // Fast path: critic was happy, skip the rewrite entirely.
    if (/NO_ISSUES/i.test(state.critique)) {
      return { final: state.draft };
    }
    const sourceBlock = state.sourceDocument
      ? `\n## Source document:\n---\n${String(state.sourceDocument).slice(0, 6000)}\n---\n`
      : "";
    const userMsg =
      `Artifact type: ${state.artifactType}\n` +
      `\n## Artifact template:\n${state.artifactInstruction}\n` +
      `\n## User inputs:\n${JSON.stringify(state.inputs, null, 2)}\n` +
      sourceBlock +
      `\n## Original draft:\n${state.draft}\n` +
      `\n## Critic feedback:\n${state.critique}\n` +
      `\nRewrite the draft addressing the critic feedback. Output only markdown.`;

    const r = await callLLM({
      systemPrompt: `${state.baseSystem}\n\n${REFINER_SYSTEM}`,
      userMsg,
      maxTokens: 8000,
    });
    if (!r.ok) throw new Error(`refiner failed: ${r.error}`);
    return { final: r.content };
  });

  graph.setEntryPoint("retriever");
  graph.addEdge("retriever", "planner");
  graph.addEdge("planner", "drafter");
  graph.addEdge("drafter", "critic");
  graph.addEdge("critic", "refiner");
  graph.addEdge("refiner", END);

  return graph.compile();
}

// Run the full pipeline. Returns the final markdown string.
// Throws on any node failure — caller should catch and fall back.
async function runAgentPipeline({
  callLLM,
  userId,
  artifactType,
  inputs,
  methodology,
  sourceDocument,
  baseSystem,
  artifactInstruction,
}) {
  const t0 = Date.now();
  const app = makeGraph(callLLM);
  const result = await app.invoke({
    userId,
    artifactType,
    inputs: inputs || {},
    methodology: methodology || null,
    sourceDocument: sourceDocument || null,
    baseSystem: baseSystem || "",
    artifactInstruction: artifactInstruction || "",
  });
  const ms = Date.now() - t0;
  console.log(
    `[agents] generated ${artifactType} in ${ms}ms ` +
    `(examples=${result.examples?.length || 0}, ` +
    `criticPass=${/NO_ISSUES/i.test(result.critique || "")})`
  );
  if (!result.final || !result.final.trim()) {
    throw new Error("agent pipeline returned empty final output");
  }
  return result.final;
}

// Persist an embedding for a freshly-saved artifact. Best-effort —
// callers run this in the background; failure must not break generation.
async function embedAndStore({ artifactId, title, inputs, content }) {
  if (!hasVector()) return;
  try {
    const text = [
      title,
      inputs ? JSON.stringify(inputs).slice(0, 1000) : "",
      String(content || "").slice(0, 3000),
    ].filter(Boolean).join("\n");
    const vec = await embed(text);
    const literal = toPgVector(vec);
    await pool.query(
      `UPDATE artifacts SET embedding = $1::vector WHERE id = $2`,
      [literal, artifactId]
    );
  } catch (err) {
    console.warn(`[agents/embedAndStore] artifact ${artifactId} failed:`, err.message);
  }
}

// Backfill any artifacts that don't have an embedding yet. Called once on
// startup so prior artifacts become retrievable without a manual migration.
async function backfillEmbeddings({ limit = 200 } = {}) {
  if (!hasVector()) return;
  let processed = 0;
  try {
    const { rows } = await pool.query(
      `SELECT id, title, inputs, content
         FROM artifacts
        WHERE embedding IS NULL
        ORDER BY created_at DESC
        LIMIT $1`,
      [limit]
    );
    if (!rows.length) return;
    console.log(`[agents] backfilling ${rows.length} artifact embedding(s)…`);
    for (const row of rows) {
      // Sequential is fine — each embed is ~50-100ms on CPU.
      // Parallel would spike memory while loading the model concurrently.
      await embedAndStore(row);
      processed++;
    }
    console.log(`[agents] backfill complete (${processed} embedded)`);
  } catch (err) {
    console.warn("[agents/backfill] failed:", err.message);
  }
}

module.exports = { runAgentPipeline, embedAndStore, backfillEmbeddings };
