const Redis = require("ioredis");

/**
 * Single place that knows how to reach Redis.
 * - REDIS_URL (Railway: ${{Redis.REDIS_URL}}) wins and carries the password.
 * - Falls back to REDIS_HOST / REDIS_PORT for local dev.
 * - family: 0 lets ioredis resolve IPv6, required for *.railway.internal hosts.
 */
function createRedisClient(options = {}) {
  const base = { family: 0, ...options };
  if (process.env.REDIS_DB) base.db = parseInt(process.env.REDIS_DB, 10); // 0=prod, 1=staging, 2=UAT

  if (process.env.REDIS_URL && process.env.REDIS_URL.trim()) {
    return new Redis(process.env.REDIS_URL.trim(), base);
  }

  return new Redis({
    host: process.env.REDIS_HOST || "localhost",
    port: Number(process.env.REDIS_PORT || 6379),
    ...base,
  });
}

module.exports = createRedisClient;
