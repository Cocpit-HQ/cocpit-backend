const { rateLimit } = require('express-rate-limit');

/**
 * Standard Rate Limiter for sensitive company operations
 * (Transfer Ownership, Domain Verification, Invites)
 */
const companyActionLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: {
        message: "Too many requests from this IP, please try again after 15 minutes"
    },
    skip: (req) => process.env.NODE_ENV === 'test',
});

/**
 * Stricter Limiter for OTP generation
 */
const otpGenerationLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    limit: 5,
    message: {
        message: "OTP request limit reached. Please try again in an hour."
    },
    legacyHeaders: false,
});

/**
 * Auth rate limiter — configurable in-memory limiter
 * Used for login, register, and other auth endpoints
 */
const createRateLimit = (options) => {
    const windowMs = options.windowMs || 15 * 60 * 1000;
    const max = options.max || 100;
    const message = options.message || "Too many requests, please try again later.";

    const hits = new Map();

    setInterval(() => {
        const now = Date.now();
        for (const [ip, data] of hits.entries()) {
            if (now > data.resetTime) {
                hits.delete(ip);
            }
        }
    }, windowMs);

    return (req, res, next) => {
        const ip = req.ip;
        const now = Date.now();

        if (!hits.has(ip)) {
            hits.set(ip, { count: 1, resetTime: now + windowMs });
            return next();
        }

        const data = hits.get(ip);

        if (now > data.resetTime) {
            hits.set(ip, { count: 1, resetTime: now + windowMs });
            return next();
        }

        if (data.count >= max) {
            return res.status(429).json({ message });
        }

        data.count++;
        next();
    };
};

module.exports = {
    companyActionLimiter,
    otpGenerationLimiter,
    createRateLimit
};
