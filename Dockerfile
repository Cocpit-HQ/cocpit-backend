# Cocpit backend — ONE Railway service, no app code changes.
# Runs the existing ecosystem.config.js under pm2-runtime, exactly like the PM2 setup:
#   gateway :8000  (public)  /api/admin -> admin :5001, everything else (+ Socket.IO) -> main :5000
#   main    :5000  (also reachable privately at backend.railway.internal:5000)
#   admin   :5001
# Plus, inside the same container:
#   - Redis on 127.0.0.1:6379 (the app's cache client has no password support, so it can't use
#     Railway's password-protected Redis). Mount a Railway volume at /data to persist it.
#   - Google Chrome stable (resume PDF uses Puppeteer with channel: 'chrome')
#   - Firebase service account written from FIREBASE_SERVICE_ACCOUNT_BASE64 at startup
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg tini redis-server ffmpeg fonts-liberation fonts-noto-color-emoji \
 && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
 && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends google-chrome-stable \
 && apt-get purge -y gnupg && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g pm2@6 --no-audit --no-fund \
 && mkdir -p /data

ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    NEW_RELIC_LOG=stdout

WORKDIR /app

# Full install (not --omit=dev): src/modules/places/places.controller.js uses axios, which is a devDependency
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund && npm cache clean --force

COPY . .
RUN chmod +x docker/entrypoint.sh

EXPOSE 8000
ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker/entrypoint.sh"]
CMD ["pm2-runtime", "ecosystem.config.js"]
