FROM node:20-alpine

WORKDIR /app

# Build tools needed for native deps (node-pty). Stays in the final image — small
# enough for this size of project; switch to multi-stage if image size matters.
RUN apk add --no-cache python3 make g++ linux-headers

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
EXPOSE 4000

CMD ["node", "src/server.js"]
