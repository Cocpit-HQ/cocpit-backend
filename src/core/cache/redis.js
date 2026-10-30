const Redis = require("ioredis");

const redisUrl = process.env.REDIS_URL || process.env.REDIS_PRIVATE_URL;

const redisOptions = {
  db: parseInt(process.env.REDIS_DB || "0", 10), // 0=prod, 1=staging, 2=UAT
  // Safety measures to avoid connection storms
  maxRetriesPerRequest: 0, // Fail fast instead of queuing up commands when down
  enableOfflineQueue: false, // Don't queue commands when Redis is unavailable
  retryStrategy(times) {
    const delay = Math.min(times * 50, 2000); // Exponential backoff up to 2s
    return delay;
  },
  reconnectOnError(err) {
    const targetError = "READONLY";
    if (err.message.includes(targetError)) {
      return true;
    }
  },
};

const redis = redisUrl
  ? new Redis(redisUrl, redisOptions)
  : new Redis({
      host: process.env.REDIS_HOST || process.env.REDISHOST || "localhost",
      port: parseInt(process.env.REDIS_PORT || process.env.REDISPORT || "6379", 10),
      password: process.env.REDIS_PASSWORD || process.env.REDISPASSWORD || undefined,
      username: process.env.REDIS_USER || process.env.REDISUSER || undefined,
      ...redisOptions,
    });

// Compatibility helper for node-redis setEx
redis.setEx = async (key, seconds, value) => {
  return redis.set(key, value, "EX", seconds);
};

let hasLoggedUnavailable = false;

redis.on("connect", () => {
  console.log("✅ Redis connected");
  hasLoggedUnavailable = false;
});

redis.on("error", (err) => {
  if (err.code === "ECONNREFUSED") {
    if (!hasLoggedUnavailable) {
      console.warn("⚠️ Redis unavailable. Running without cache.");
      hasLoggedUnavailable = true;
    }
  } else {
    console.error("❌ Redis error:", err);
  }
});

module.exports = redis;
