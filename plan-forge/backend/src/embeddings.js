// Local embedding service for the RAG layer.
//
// Runs `Xenova/all-MiniLM-L6-v2` (384-dim sentence embeddings) inside the
// backend Node process via `@xenova/transformers`. Same "no external API
// key, runs in our container" pattern as the Claude CLI provider.
//
// Lifecycle:
//   1. `getEmbedder()` lazy-loads the pipeline on first call (~25 MB
//      download, cached at $TRANSFORMERS_CACHE which we mount on the
//      `claude_home` volume — so subsequent boots are instant).
//   2. `embed(text)` returns a Float32Array of length 384.
//   3. `toPgVector(vec)` formats a vector for pgvector's `vector(384)`
//      literal: `[0.123, -0.456, ...]`.
//
// If the model fails to load (offline, disk full, ARM CPU without ONNX
// bindings, etc), `embed()` rejects with a clear error and callers should
// log + skip the RAG step — never block generation on embedding success.

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const EMBEDDING_DIM = 384;

let pipelinePromise = null;

async function getEmbedder() {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      // Dynamic import — @xenova/transformers is an ESM module loaded into
      // our CommonJS backend. Doing the import lazily also means we don't
      // pay the load cost on container startup, only on first embed call.
      const { pipeline, env } = await import("@xenova/transformers");

      // Tell transformers to use the local model cache only — never fetch
      // at request time if the model already exists in $TRANSFORMERS_CACHE.
      // Setting `allowRemoteModels = true` (default) keeps the first-run
      // download path open.
      env.allowLocalModels = true;
      env.allowRemoteModels = true;

      console.log(`[embeddings] loading model ${MODEL_ID} (~25 MB, cached after first run)…`);
      const extractor = await pipeline("feature-extraction", MODEL_ID);
      console.log("[embeddings] model ready");
      return extractor;
    })();
  }
  return pipelinePromise;
}

// Reduce a piece of text to a 384-dim vector. Truncates to ~2000 chars
// (the model max-seq-length is 512 tokens ≈ 2000 chars of English; longer
// inputs are truncated by the tokenizer anyway, this just avoids paying
// memory for huge strings).
async function embed(text) {
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("embed: text must be a non-empty string");
  }
  const trimmed = text.slice(0, 4000);
  const extractor = await getEmbedder();
  const output = await extractor(trimmed, { pooling: "mean", normalize: true });
  // output.data is a Float32Array of length 384 (normalized → cosine ≈ dot product)
  return Array.from(output.data);
}

// Format a JS array as pgvector's text literal: `[0.123,-0.456,...]`
// Used in INSERT/UPDATE statements (pg-node has no native vector type).
function toPgVector(vec) {
  if (!Array.isArray(vec) || vec.length !== EMBEDDING_DIM) {
    throw new Error(`toPgVector: expected ${EMBEDDING_DIM}-element array, got ${vec && vec.length}`);
  }
  return "[" + vec.map((n) => Number.isFinite(n) ? n.toString() : "0").join(",") + "]";
}

module.exports = { embed, toPgVector, EMBEDDING_DIM, MODEL_ID };
