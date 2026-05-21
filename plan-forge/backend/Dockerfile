# node:20-slim (Debian) instead of alpine — required by
# @xenova/transformers' onnxruntime-node binaries, which ship glibc-only
# and segfault on alpine's musl libc. Image size goes from ~150 MB to
# ~250 MB, which is fine for this project.
FROM node:20-slim

WORKDIR /app

# Build tools needed for native deps (node-pty) + curl for healthchecks.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

# Install the Claude Code CLI globally so the "claude-cli" provider in
# settings can spawn `claude --print "<prompt>"` as a subprocess, and so
# `claude setup-token` is reachable from the in-app OAuth flow.
# Token persists in /root/.claude.json on the claude_home named volume
# (see docker-compose.yml).
RUN npm install -g @anthropic-ai/claude-code && claude --version || true

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src

ENV NODE_ENV=production
# Cache the local sentence-embedding model on the claude_home volume so
# `docker compose up` after a rebuild is near-instant (no re-download).
ENV TRANSFORMERS_CACHE=/root/.cache/transformers
ENV HF_HOME=/root/.cache/huggingface
EXPOSE 4000

CMD ["node", "src/server.js"]
