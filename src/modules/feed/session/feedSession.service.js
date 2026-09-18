/**
 * Module: Feed Session Service
 * Sprint Task: Day 1 — Task B2 (B2.1 – B2.8)
 * Owner: Dev B
 * AI-Assisted: Yes (Antigravity)
 * Contracts read: contracts/redis-key-registry.md, contracts/api-contracts.md
 * Last reviewed: 2026-05-23
 *
 * Redis Key Patterns Used (all from redis-key-registry.md — FROZEN):
 *   feed:session:{user_id}   → Hash, TTL 1800s (30 min idle)
 *   feed:cursor:{user_id}    → String, TTL 1800s
 *
 * Session shape returned (matches GET /api/feed/session contract):
 *   { session_id, cursor, seen_count, started_at, expires_at }
 */

"use strict";

const { v4: uuidv4 } = require("uuid");
const redis = require("../../../core/cache/redis");

// ─── Key Builders ─────────────────────────────────────────────────────────────
const keys = {
  session: (userId) => `feed:session:${userId}`,
  cursor: (userId) => `feed:cursor:${userId}`,
  seenSet: (userId) => `feed:seen:${userId}`,
};

// ─── TTLs (from redis-key-registry.md) ───────────────────────────────────────
const SESSION_TTL = 1800;   // 30 minutes idle
const CURSOR_TTL  = 1800;   // matches session TTL

// ─── B2.2 ─────────────────────────────────────────────────────────────────────
/**
 * Create a new feed session for a user.
 * If a session already exists, it is replaced.
 * @param {string} userId
 * @param {string} [context="home"] - Feed context: home | explore | startup
 * @returns {Promise<Object>} FeedSession
 */
async function createSession(userId, context = "home") {
  if (!userId) throw new Error("createSession: userId is required");

  const sessionId = uuidv4();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL * 1000);
  const cursor = uuidv4(); // Initial cursor for first page

  const sessionHash = {
    session_id: sessionId,
    user_id: userId,
    cursor,
    context,
    seen_count: "0",
    exploration_enabled: "true",
    started_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    last_active_at: now.toISOString(),
  };

  // Store session as a Hash in Redis (feed:session:{userId})
  const pipeline = redis.pipeline();
  pipeline.hset(keys.session(userId), sessionHash);
  pipeline.expire(keys.session(userId), SESSION_TTL);
  pipeline.set(keys.cursor(userId), cursor, "EX", CURSOR_TTL);
  await pipeline.exec();

  return _formatSession(sessionHash);
}

// ─── B2.3 ─────────────────────────────────────────────────────────────────────
/**
 * Retrieve the current feed session for a user.
 * Returns null if no session exists or if the session has expired.
 * @param {string} userId
 * @returns {Promise<Object|null>} FeedSession or null
 */
async function getSession(userId) {
  if (!userId) throw new Error("getSession: userId is required");

  const raw = await redis.hgetall(keys.session(userId));

  if (!raw || !raw.session_id) return null;

  // B2.7 — Validate expires_at on read
  const expiresAt = new Date(raw.expires_at);
  if (isNaN(expiresAt.getTime()) || expiresAt < new Date()) {
    // Session expired — clean up and return null
    await _deleteSession(userId);
    return null;
  }

  return _formatSession(raw);
}

// ─── B2.4 ─────────────────────────────────────────────────────────────────────
/**
 * Update the pagination cursor for a user's session.
 * Also refreshes the idle TTL (acts as a touch).
 * @param {string} userId
 * @param {string} newCursor
 * @returns {Promise<void>}
 */
async function updateCursor(userId, newCursor) {
  if (!userId) throw new Error("updateCursor: userId is required");
  if (!newCursor) throw new Error("updateCursor: newCursor is required");

  const sessionKey = keys.session(userId);
  const exists = await redis.exists(sessionKey);
  if (!exists) return; // Session gone, no-op

  const now = new Date().toISOString();
  const pipeline = redis.pipeline();
  pipeline.hset(sessionKey, { cursor: newCursor, last_active_at: now });
  pipeline.expire(sessionKey, SESSION_TTL);
  pipeline.set(keys.cursor(userId), newCursor, "EX", CURSOR_TTL);
  await pipeline.exec();
}

// ─── B2.5 ─────────────────────────────────────────────────────────────────────
/**
 * Completely reset a user's feed session.
 * Clears session, cursor, and seen set from Redis.
 * @param {string} userId
 * @returns {Promise<void>}
 */
async function resetSession(userId) {
  if (!userId) throw new Error("resetSession: userId is required");
  await _deleteSession(userId);
}

// ─── B2.6 ─────────────────────────────────────────────────────────────────────
/**
 * Refresh the idle TTL of an active session without changing any data.
 * Should be called on any feed activity to prevent premature expiry.
 * @param {string} userId
 * @returns {Promise<boolean>} true if session existed and was touched, false if no session
 */
// ===========================================================================
// [CLEANUP - FEED REFACTOR] REASON FOR COMMENTING OUT:
// - Status: UNUSED / ORPHANED
// - Technical Reason: touchSession was only invoked by feedController.trackEvent,
//   which was commented out. Feed sessions expire naturally via Redis TTL (1800s)
//   and are updated on every read in getSession().
// - Active Replacement: Session expiry and extension handled automatically by Redis TTL.
// ===========================================================================
/*
async function touchSession(userId) {
  if (!userId) throw new Error("touchSession: userId is required");

  const sessionKey = keys.session(userId);
  const exists = await redis.exists(sessionKey);
  if (!exists) return false;

  const now = new Date().toISOString();
  const pipeline = redis.pipeline();
  pipeline.hset(sessionKey, { last_active_at: now });
  pipeline.expire(sessionKey, SESSION_TTL);
  pipeline.expire(keys.cursor(userId), CURSOR_TTL);
  await pipeline.exec();

  return true;
}
*/

/**
 * Increment the seen_count on the session hash.
 * Called internally when items are served.
 * @param {string} userId
 * @param {number} count - Number of items just served
 * @returns {Promise<void>}
 */
async function incrementSeenCount(userId, count = 0) {
  if (!userId || count <= 0) return;
  await redis.hincrby(keys.session(userId), "seen_count", count);
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Delete all session-related keys for a user.
 * @param {string} userId
 */
async function _deleteSession(userId) {
  const pipeline = redis.pipeline();
  pipeline.del(keys.session(userId));
  pipeline.del(keys.cursor(userId));
  pipeline.del(keys.seenSet(userId));
  await pipeline.exec();
}

/**
 * Format the raw Redis hash into the FeedSession API contract shape.
 * Matches GET /api/feed/session response from api-contracts.md.
 * @param {Object} raw - Raw Redis hash object
 * @returns {Object} FeedSession
 */
function _formatSession(raw) {
  return {
    session_id: raw.session_id,
    cursor: raw.cursor,
    context: raw.context || "home",
    seen_count: parseInt(raw.seen_count, 10) || 0,
    exploration_enabled: raw.exploration_enabled === "true",
    started_at: raw.started_at,
    expires_at: raw.expires_at,
    last_active_at: raw.last_active_at,
  };
}

module.exports = {
  createSession,
  getSession,
  updateCursor,
  resetSession,
  // touchSession, // UNUSED
  incrementSeenCount,
  // Exported for unit tests
  _keys: keys,
  _SESSION_TTL: SESSION_TTL,
};
