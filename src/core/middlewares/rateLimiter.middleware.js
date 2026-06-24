"use strict";

const rateLimit = require("express-rate-limit");

/**
 * createAIRateLimiter
 *
 * Returns an express-rate-limit middleware configured specifically for the
 * AI Job Description generation endpoint.
 *
 * Limits: 3 requests per user per 60-second window.
 * Key:    req.user.sub (JWT user ID) — falls back to IP if unauthenticated.
 *
 * Usage:
 *   const { createAIRateLimiter } = require('../../core/middlewares/rateLimiter.middleware');
 *   const aiRateLimiter = createAIRateLimiter();
 *   router.post('/:id/generate', requireAuth, aiRateLimiter, jobController.generateJD);
 */
exports.createAIRateLimiter = () =>
  rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 3,              // max 3 AI JD generations per user per minute
    standardHeaders: true,  // Return rate limit info in RateLimit-* headers
    legacyHeaders: false,   // Disable X-RateLimit-* headers

    // Key by authenticated user ID so limits are per-user, not per-IP
    keyGenerator: (req) => `ai_gen:${req.user?.sub || req.ip}`,

    // Custom response when limit is exceeded
    handler: (req, res) => {
      res.status(429).json({
        message:
          "AI generation limit reached. You can generate up to 3 Job Descriptions per minute. Please wait and try again.",
        retryAfter: 60,
      });
    },
  });
