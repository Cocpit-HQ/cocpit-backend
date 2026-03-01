const redis = require("redis");

// Get Redis URL from env or default
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

const redisClient = redis.createClient({
    url: REDIS_URL,
    socket: {
        // Limit retries to prevent infinite spam if Redis is missing
        reconnectStrategy: (retries) => {
            if (retries > 5) {
                console.warn("⚠️ Redis connection failed. Running without cache.");
                return new Error("Redis connection failed");
            }
            return Math.min(retries * 200, 2000); // Backoff: 200ms -> 2s
        }
    }
});

// Handle errors to prevent process crash
redisClient.on("error", (err) => {
    // Suppress repeated connection errors
    if (err.code === 'ECONNREFUSED' || err.message.includes('ECONNREFUSED')) {
        return;
    }
    console.error("Redis Client Error:", err.message);
});

redisClient.on("connect", () => {
    console.log("✅ Redis Client Connected");
});

redisClient.on("reconnecting", () => {
    // console.log("Redis reconnecting...");
});

// Auto-connect
(async () => {
    try {
        if (!redisClient.isOpen) {
            await redisClient.connect();
        }
    } catch (err) {
        // Initial connection failed
        console.warn("⚠️ Initial Redis connection failed. Running without cache.");
    }
})();

module.exports = redisClient;
