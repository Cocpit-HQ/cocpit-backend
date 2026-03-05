/**
 * In-memory sliding-window rate limiter for session operations.
 * Keyed by userId:action. No Redis dependency.
 */

const rateLimitStore = new Map();

const LIMITS = {
    'session:claim': { max: 5, windowMs: 60 * 1000 },      // 5 claims/min
    'session:takeover': { max: 3, windowMs: 60 * 1000 },    // 3 takeovers/min
    'organization:message': { max: 30, windowMs: 60 * 1000 },    // 30 msgs/min
    'company:message': { max: 30, windowMs: 60 * 1000 },         // Legacy alias
};

/**
 * Check rate limit for a given key and action.
 * @param {string} userId
 * @param {string} action - one of 'session:claim', 'session:takeover', 'company:message'
 * @returns {{ allowed: boolean, retryAfterMs: number }}
 */
function checkRateLimit(userId, action) {
    const config = LIMITS[action];
    if (!config) return { allowed: true, retryAfterMs: 0 };

    const key = `${userId}:${action}`;
    const now = Date.now();
    const windowStart = now - config.windowMs;

    let entry = rateLimitStore.get(key);
    if (!entry) {
        entry = { timestamps: [] };
        rateLimitStore.set(key, entry);
    }

    // Prune old timestamps
    entry.timestamps = entry.timestamps.filter(t => t > windowStart);

    if (entry.timestamps.length >= config.max) {
        const oldestInWindow = entry.timestamps[0];
        const retryAfterMs = oldestInWindow + config.windowMs - now;
        return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 0) };
    }

    entry.timestamps.push(now);
    return { allowed: true, retryAfterMs: 0 };
}

/**
 * Express middleware factory for rate limiting.
 * @param {string} action - rate limit action key
 * @param {function} [keyExtractor] - optional function to extract key from req (default: req.user.sub)
 */
function sessionRateLimiter(action, keyExtractor) {
    return (req, res, next) => {
        if (process.env.NODE_ENV === 'test') return next();

        const key = keyExtractor ? keyExtractor(req) : req.user?.sub;
        if (!key) return next();

        const result = checkRateLimit(key, action);
        if (!result.allowed) {
            return res.status(429).json({
                message: 'Too many requests. Please try again later.',
                retryAfterMs: result.retryAfterMs
            });
        }
        next();
    };
}

// Periodic cleanup of stale entries (every 5 minutes)
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of rateLimitStore) {
        entry.timestamps = entry.timestamps.filter(t => t > now - 120000); // 2 min max window
        if (entry.timestamps.length === 0) {
            rateLimitStore.delete(key);
        }
    }
}, 5 * 60 * 1000);

module.exports = {
    checkRateLimit,
    sessionRateLimiter,
    LIMITS,
    // Exposed for testing
    _resetStore: () => rateLimitStore.clear()
};
