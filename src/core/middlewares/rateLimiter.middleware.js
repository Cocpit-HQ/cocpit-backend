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
    max: 30,             // Bumped to 30 to act as basic DoS protection (business logic handles 3 per 24h)
    standardHeaders: true,
    legacyHeaders: false,

    keyGenerator: (req) => `ai_gen_dos:${req.user?.sub || req.ip}`,

    handler: (req, res) => {
      res.status(429).json({
        message: "Too many requests. Please slow down and try again.",
        retryAfter: 60,
      });
    },
  });
