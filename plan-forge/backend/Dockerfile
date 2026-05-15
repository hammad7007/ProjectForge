FROM node:20-alpine

WORKDIR /app

# Install the Claude Code CLI globally so the "claude-cli" provider in
# settings can spawn `claude --print "<prompt>"` as a subprocess.
# Authenticate inside the running container via:
#   docker compose exec backend claude /login
# Token persists at ~/.claude.json on the container's filesystem — mount a
# volume in docker-compose.yml if you want it to survive `docker compose down`.
RUN npm install -g @anthropic-ai/claude-code && claude --version || true

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src

ENV NODE_ENV=production
EXPOSE 4000

CMD ["node", "src/server.js"]
