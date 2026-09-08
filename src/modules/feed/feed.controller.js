/**
 * Module: Feed API Controller
 * Sprint Task: Day 1 — Task B3 (B3.2) — Scaffold
 *              Day 3 — Task B7 (getFeed wired) + Task A8 (trackEvent wired)
 * Owner: Dev B
 * AI-Assisted: Yes (Antigravity)
 * Contracts read: contracts/api-contracts.md, contracts/redis-key-registry.md
 * Last reviewed: 2026-05-26
 */

"use strict";

const feedSessionService = require("./session/feedSession.service");
const feedService        = require("./feed.service");
const feedAnalytics      = require("./analytics/feedAnalytics.service");
const pool               = require("../../core/db/pool");

// ID-160/D1 — see feed.service.js:buildCacheScopeId. Requests without
// x-actor-type/x-actor-id (mobile clients today) resolve to `undefined`
// here, so scopeId === userId — identical to pre-D1 behavior.
const getOrgActorId = (req) => (req.actor?.type === "ORGANIZATION" ? req.actor.id : undefined);

// ─── GET /api/feed ────────────────────────────────────────────────────────────
/**
 * Returns the next paginated feed slice for the authenticated user.
 * Day 3: Full pipeline wired via feedService.getFeed().
 * Day 4: Added B8.6 request validation (limit range, context enum).
 *
 * Response shape from api-contracts.md:
 *   { ok, data: { items, cursor, has_more, session_id, served_at }, meta }
 */

// B8.6 — Valid context values from api-contracts.md (FROZEN)
const VALID_FEED_CONTEXTS = new Set(['home', 'explore', 'startup']);

exports.getFeed = async (req, res, next) => {
  try {
    const userId = req.user?.sub;
    if (!userId) return res.status(401).json({ ok: false, message: "Unauthenticated" });

    const cursor  = req.query.cursor  || null;
    const context = req.query.context || "home";
    let algorithm = req.query.algorithm !== 'false';
    const rawLimit = req.query.limit;

    // Check global algorithm override
    try {
      const redis = require('../../core/cache/redis');
      const globalEnabled = await redis.get('config:feed_algorithm_enabled');
      if (globalEnabled === 'false') {
        algorithm = false;
      }
    } catch (err) {
      console.warn('Failed to check global feed algorithm config:', err.message);
    }

    // B8.6 — Validate limit (api-contracts.md: default 20, max 50)
    let limit = 20;
    if (rawLimit !== undefined) {
      limit = parseInt(rawLimit, 10);
      if (isNaN(limit) || limit < 1 || limit > 50) {
        return res.status(400).json({
          ok: false,
          message: "limit must be an integer between 1 and 50",
        });
      }
    }

    // B8.6 — Validate context (api-contracts.md: home | explore | startup)
    if (!VALID_FEED_CONTEXTS.has(context)) {
      return res.status(400).json({
        ok: false,
        message: `context must be one of: ${[...VALID_FEED_CONTEXTS].join(', ')}`,
      });
    }

    // B7 — delegate entirely to feed service (cache-first pipeline)
    const response = await feedService.getFeed({
      userId,
      cursor,
      limit,
      pool,
      context,
      orgActorId: getOrgActorId(req),
      algorithm,
    });

    return res.status(200).json(response);
  } catch (err) {
    next(err);
  }
};

// ─── POST /api/feed/event ─────────────────────────────────────────────────────
/**
 * Track a user interaction with a feed item.
 * Day 3: Wired to feedAnalytics.trackEvent() (A8).
 *
 * Required fields from api-contracts.md + event-types.md:
 *   event_type, item_id, item_type, session_id, position, context
 */
exports.trackEvent = async (req, res, next) => {
  try {
    const userId = req.user?.sub;
    if (!userId) return res.status(401).json({ ok: false, message: "Unauthenticated" });

    const { event_type, item_id, item_type, session_id, position, context, dwell_ms, slot_type, metadata } = req.body;

    // Basic input validation (API contract)
    if (!event_type || !item_id || !item_type || !session_id || position === undefined || !context) {
      return res.status(400).json({
        ok: false,
        message: "Missing required fields: event_type, item_id, item_type, session_id, position, context",
      });
    }

    // A8 — delegate to analytics service
    const result = await feedAnalytics.trackEvent({
      event_type,
      item_id,
      item_type,
      user_id:    userId,
      session_id,
      position:   parseInt(position, 10),
      context,
      dwell_ms:   dwell_ms ? parseInt(dwell_ms, 10) : null,
      slot_type:  slot_type || null,
      metadata:   metadata  || {},
      timestamp:  new Date().toISOString(),
      pool,
    });

    // Touch session to keep it alive (scoped to the acting org, if any — D1)
    const touchScopeId = feedService.buildCacheScopeId(userId, getOrgActorId(req));
    await feedSessionService.touchSession(touchScopeId).catch(() => {}); // non-fatal

    return res.status(202).json({
      ok:      true,
      message: "Event accepted",
      ...(result.duplicate ? { duplicate: true } : {}),
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/feed/session ────────────────────────────────────────────────────
/**
 * Returns the current feed session state for the authenticated user.
 * Creates a new session if none exists.
 *
 * Response shape from api-contracts.md:
 *   { ok, data: { session_id, cursor, seen_count, started_at, expires_at } }
 */
exports.getSession = async (req, res, next) => {
  try {
    const userId = req.user?.sub;
    if (!userId) return res.status(401).json({ ok: false, message: "Unauthenticated" });

    const context = req.query.context || "home";
    const scopeId = feedService.buildCacheScopeId(userId, getOrgActorId(req));

    let session = await feedSessionService.getSession(scopeId);
    if (!session) {
      session = await feedSessionService.createSession(scopeId, context);
    }

    return res.status(200).json({
      ok: true,
      data: {
        session_id: session.session_id,
        cursor:     session.cursor,
        seen_count: session.seen_count,
        started_at: session.started_at,
        expires_at: session.expires_at,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ─── DELETE /api/feed/session ─────────────────────────────────────────────────
/**
 * Resets the user's feed session (clears seen set + cursor + session hash).
 *
 * Response shape from api-contracts.md:
 *   { ok, message }
 */
exports.resetSession = async (req, res, next) => {
  try {
    const userId = req.user?.sub;
    if (!userId) return res.status(401).json({ ok: false, message: "Unauthenticated" });

    const scopeId = feedService.buildCacheScopeId(userId, getOrgActorId(req));
    await feedSessionService.resetSession(scopeId);

    return res.status(200).json({
      ok:      true,
      message: "Feed session reset",
    });
  } catch (err) {
    next(err);
  }
};

// ─── POST /api/feed/hide ──────────────────────────────────────────────────────
/**
 * Hides a post for the authenticated user and applies negative intent scoring.
 */
exports.hidePost = async (req, res, next) => {
  try {
    const userId = req.user?.sub;
    if (!userId) return res.status(401).json({ ok: false, message: "Unauthenticated" });

    const { item_id, session_id, position } = req.body;

    if (!item_id) {
      return res.status(400).json({ ok: false, message: "Missing required field: item_id" });
    }

    await feedService.hidePost({
      userId,
      postId: item_id,
      sessionId: session_id,
      position: position,
      pool,
      orgActorId: getOrgActorId(req),
    });

    return res.status(200).json({
      ok: true,
      message: "Post hidden successfully"
    });
  } catch (err) {
    next(err);
  }
};

// ─── DELETE /api/feed/hide ────────────────────────────────────────────────────
/**
 * Unhides a post for the authenticated user and reverses negative intent scoring.
 */
exports.unhidePost = async (req, res, next) => {
  try {
    const userId = req.user?.sub;
    if (!userId) return res.status(401).json({ ok: false, message: "Unauthenticated" });

    const { item_id, session_id, position } = req.body;

    if (!item_id) {
      return res.status(400).json({ ok: false, message: "Missing required field: item_id" });
    }

    await feedService.unhidePost({
      userId,
      postId: item_id,
      sessionId: session_id,
      position: position,
      pool,
      orgActorId: getOrgActorId(req),
    });

    return res.status(200).json({
      ok: true,
      message: "Post unhidden successfully"
    });
  } catch (err) {
    next(err);
  }
};

// ─── POST /api/feed/postfeedback ──────────────────────────────────────────────
/**
 * Generic endpoint to submit positive or negative feedback on a post.
 */
exports.submitFeedback = async (req, res, next) => {
  try {
    const userId = req.user?.sub;
    if (!userId) return res.status(401).json({ ok: false, message: "Unauthenticated" });

    const { item_id, type, session_id, position } = req.body;

    if (!item_id || !type) {
      return res.status(400).json({ ok: false, message: "Missing required fields: item_id, type" });
    }

    if (!['INTERESTED', 'NOT_INTERESTED'].includes(type)) {
      return res.status(400).json({ ok: false, message: "Invalid feedback type" });
    }

    await feedService.submitFeedback({
      userId,
      postId: item_id,
      feedbackType: type,
      sessionId: session_id,
      position: position,
      pool,
      orgActorId: getOrgActorId(req),
    });

    return res.status(200).json({
      ok: true,
      message: `Feedback ${type} recorded successfully`
    });
  } catch (err) {
    next(err);
  }
};
