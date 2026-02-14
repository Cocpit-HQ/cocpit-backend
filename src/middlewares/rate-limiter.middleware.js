const { rateLimit } = require('express-rate-limit');

/**
 * Standard Rate Limiter for sensitive company operations
 * (Transfer Ownership, Domain Verification, Invites)
 */
const companyActionLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    limit: 10, // Limit each IP to 10 requests per windowMs
    standardHeaders: 'draft-7', // draft-6: `RateLimit-*` headers; draft-7: combined `RateLimit` header
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
    message: {
        message: "Too many requests from this IP, please try again after 15 minutes"
    },
    // For development/mock purposes, we can skip if needed, but production-ready is the goal
    skip: (req) => process.env.NODE_ENV === 'test',
});

/**
 * Stricter Limiter for OTP generation
 */
const otpGenerationLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    limit: 5, // Limit each IP to 5 OTP requests per hour
    message: {
        message: "OTP request limit reached. Please try again in an hour."
    },
    legacyHeaders: false,
});

module.exports = {
    companyActionLimiter,
    otpGenerationLimiter
};
