# Cocpit backend — single monolith image: Main API + Admin API + Socket.IO + workers
# Build:  docker build -t cocpit-backend .
# Run:    docker run --env-file .env -p 8080:8080 cocpit-backend
FROM node:22-bookworm-slim

# Chromium for Puppeteer (resume PDF rendering) + fonts; tini for clean SIGTERM handling
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-liberation fonts-noto-color-emoji ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=8080 \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NEW_RELIC_LOG=stdout

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --chown=node:node . .
# Local-disk fallback dirs (used only when Cloudinary is not configured, wiped on redeploy)
RUN mkdir -p uploads && chown node:node /app && chown -R node:node /app/uploads

USER node
EXPOSE 8080

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]
