/**
 * Global Search Routes for COCPIT
 * Mounted at /api/search in app.js
 * Root endpoint: GET /api/search
 */
const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const searchController = require('./search.controller');
const { optionalAuth } = require('../../core/middlewares/auth.middleware');
const { resolveActorContext } = require('../../core/middlewares/actor-context.middleware');

/**
 * Two-tier sliding window rate limiter:
 * - 120 req/min for authenticated users/org actors (avoids NAT collisions for real users)
 * - 60 req/min for guests based on IP
 */
const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: (req) => {
    const isAuth = Boolean(req.actor || req.user);
    return isAuth ? 120 : 60;
  },
  keyGenerator: (req) => {
    const actorKey = req.actor?.id || req.actor?.userId || req.actor?.orgId || req.user?.sub || req.user?.id;
    return actorKey ? `search:auth:${actorKey}` : `search:ip:${req.ip}`;
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      status: 'error',
      message: 'Too many search requests. Please slow down and try again.',
      retryAfter: 60,
    });
  },
});

// Metadata endpoints for search filters (no auth required, public reference data)
router.get('/meta/sectors', searchController.getSectors);

// GET /api/search
router.get('/', optionalAuth, resolveActorContext, searchLimiter, searchController.globalSearch);

module.exports = router;

