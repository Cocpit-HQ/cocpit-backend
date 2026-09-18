/**
 * Module: Feed Routes
 * Sprint Task: Day 1 — Task B3 (B3.1, B3.3) — Scaffold only; full logic added Day 4
 * Owner: Dev B
 * AI-Assisted: Yes (Antigravity)
 * Contracts read: contracts/api-contracts.md
 * Last reviewed: 2026-05-23
 *
 * Endpoints (from api-contracts.md — FROZEN):
 *   GET    /api/feed           → getFeed       (60 req/min)
 *   POST   /api/feed/event     → trackEvent    (300 req/min)
 *   GET    /api/feed/session   → getSession    (30 req/min)
 *   DELETE /api/feed/session   → resetSession  (no explicit limit — using fetch limiter)
 *
 * Registered under /api/feed in src/app.js
 */

"use strict";

const express = require("express");
const router = express.Router();

const feedController = require("./feed.controller");
const { requireAuth } = require("../../core/middlewares/auth.middleware");
const { createRateLimit } = require("../../core/middlewares/rateLimit.middleware");

// ─── Rate Limiters (from api-contracts.md) ────────────────────────────────────
const feedFetchLimiter = createRateLimit({
  windowMs: 60 * 1000,  // 1 minute
  max: 60,              // 60 req/min per api-contracts.md
  message: "Feed rate limit exceeded. Please wait before requesting more.",
});

const feedEventLimiter = createRateLimit({
  windowMs: 60 * 1000,  // 1 minute
  max: 300,             // 300 req/min per api-contracts.md
  message: "Event tracking rate limit exceeded.",
});

const feedSessionLimiter = createRateLimit({
  windowMs: 60 * 1000,  // 1 minute
  max: 30,              // 30 req/min per api-contracts.md
  message: "Session rate limit exceeded.",
});

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /api/feed — Fetch next feed page
router.get("/", requireAuth, feedFetchLimiter, feedController.getFeed);

// ===========================================================================
// [CLEANUP - FEED REFACTOR] REASON FOR COMMENTING OUT:
// - Status: UNUSED / DISCONNECTED
// - Technical Reason: Frontend does not track interaction dwell/scroll events via POST /api/feed/event.
// - Active Replacement: Active post interactions (likes, comments, feedback) are tracked through their
//   respective dedicated APIs and POST /api/feed/postfeedback.
// ===========================================================================
// router.post("/event", requireAuth, feedEventLimiter, feedController.trackEvent);

// ===========================================================================
// [CLEANUP - FEED REFACTOR] REASON FOR COMMENTING OUT:
// - Status: UNUSED / REDUNDANT
// - Technical Reason: Feed sessions are created, read, and maintained automatically inside GET /api/feed.
// - Active Replacement: Frontend reads session state (session_id, cursor) directly from the GET / response data.
// ===========================================================================
// router.get("/session", requireAuth, feedSessionLimiter, feedController.getSession);

// DELETE /api/feed/session — Reset feed session
router.delete("/session", requireAuth, feedSessionLimiter, feedController.resetSession);

// ===========================================================================
// [CLEANUP - FEED REFACTOR] REASON FOR COMMENTING OUT:
// - Status: REDUNDANT
// - Technical Reason: POST /api/feed/hide is legacy.
// - Active Replacement: Frontend uses POST /api/feed/postfeedback with { type: 'NOT_INTERESTED' }.
// ===========================================================================
// router.post("/hide", requireAuth, feedEventLimiter, feedController.hidePost);

// POST /api/feed/unhide — Unhide a post and reverse negative recommendations
router.post("/unhide", requireAuth, feedEventLimiter, feedController.unhidePost);

// POST /api/feed/postfeedback — Generic interested/not_interested feedback
router.post("/postfeedback", requireAuth, feedEventLimiter, feedController.submitFeedback);

module.exports = router;
