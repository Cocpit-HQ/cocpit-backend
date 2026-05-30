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
    const rawLimit = req.query.limit;

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

    // Touch session to keep it alive
    await feedSessionService.touchSession(userId).catch(() => {}); // non-fatal

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

    let session = await feedSessionService.getSession(userId);
    if (!session) {
      session = await feedSessionService.createSession(userId, context);
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

    await feedSessionService.resetSession(userId);

    return res.status(200).json({
      ok:      true,
      message: "Feed session reset",
    });
  } catch (err) {
    next(err);
  }
};
