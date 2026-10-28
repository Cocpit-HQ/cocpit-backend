const Redis = require("ioredis");

let redisOptions;
if (process.env.REDIS_URL) {
  try {
    const u = new URL(process.env.REDIS_URL);
    redisOptions = {
      host: u.hostname || "localhost",
      port: parseInt(u.port || "6379", 10),
      password: u.password || undefined,
      db: parseInt(process.env.REDIS_DB || (u.pathname ? u.pathname.replace("/", "") : "0") || "0", 10),
      ...(u.protocol === "rediss:" ? { tls: {} } : {}),
    };
  } catch {
    redisOptions = {
      host: process.env.REDIS_HOST || "localhost",
      port: parseInt(process.env.REDIS_PORT || "6379", 10),
      db: parseInt(process.env.REDIS_DB || "0", 10),
    };
  }
} else {
  redisOptions = {
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT || "6379", 10),
    db: parseInt(process.env.REDIS_DB || "0", 10),
  };
}

const redis = new Redis({
  ...redisOptions,
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
