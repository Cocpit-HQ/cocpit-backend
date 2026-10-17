#!/bin/sh
# Container entrypoint for Railway — infrastructure only, no app logic.
set -e

# Firebase: the app reads a file path, Railway has no secret files -> materialise it from a variable
if [ -n "$FIREBASE_SERVICE_ACCOUNT_BASE64" ]; then
  echo "$FIREBASE_SERVICE_ACCOUNT_BASE64" | base64 -d > /app/firebase-service-account.json
  export FIREBASE_SERVICE_ACCOUNT_PATH=/app/firebase-service-account.json
  echo "[entrypoint] Firebase service account written to $FIREBASE_SERVICE_ACCOUNT_PATH"
fi

# Embedded Redis (localhost only). Set EMBEDDED_REDIS=false to use an external Redis instead.
if [ "${EMBEDDED_REDIS:-true}" != "false" ]; then
  redis-server --bind 127.0.0.1 --port 6379 --dir /data --appendonly yes --daemonize yes \
    --logfile /data/redis.log --maxmemory "${REDIS_MAXMEMORY:-256mb}" --maxmemory-policy noeviction
  echo "[entrypoint] Embedded Redis started on 127.0.0.1:6379 (data dir /data)"
fi

exec "$@"
