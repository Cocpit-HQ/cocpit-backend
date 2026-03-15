const Redis = require("ioredis");

const redis = new Redis({
  host: process.env.REDIS_HOST || "localhost",
  port: process.env.REDIS_PORT || 6379,
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

let lastErrorLog = 0;
const LOG_THROTTLE = 10000; // Log once every 10 seconds

redis.on("connect", () => {
  console.log("✅ Redis connected");
  lastErrorLog = 0;
});

redis.on("error", (err) => {
  const now = Date.now();
  if (err.code === "ECONNREFUSED") {
    if (now - lastErrorLog > LOG_THROTTLE) {
      console.warn("⚠️ Redis unavailable. Running without cache.");
      lastErrorLog = now;
    }
  } else {
    console.error("❌ Redis error:", err);
  }
});

module.exports = redis;
