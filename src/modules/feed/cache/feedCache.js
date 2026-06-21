/**
 * Module: Feed Redis Cache Service
 * Sprint Task: Day 1 — Task B1 (B1.1 – B1.8) | Day 2 — Task B5 (candidate pool cache)
 * Owner: Dev B
 * AI-Assisted: Yes (Antigravity)
 * Contracts read: contracts/redis-key-registry.md, contracts/api-contracts.md
 * Last reviewed: 2026-05-24
 *
 * Redis Key Patterns Used (all from redis-key-registry.md — FROZEN):
 *   feed:slice:{user_id}:{cursor}   → String (JSON), TTL 300s
 *   feed:seen:{user_id}             → Set, TTL 86400s
 *   feed:candidates:{user_id}       → String (JSON), TTL 120s
 */

"use strict";

const redis = require("../../../core/cache/redis");

// ─── Key Builders ────────────────────────────────────────────────────────────
// All patterns match redis-key-registry.md exactly. Do NOT create new patterns.

const keys = {
  feedSlice:     (userId, cursor)         => `feed:slice:${userId}:${cursor}`,
  seenSet:       (userId)                 => `feed:seen:${userId}`,
  candidatePool: (userId)                 => `feed:candidates:${userId}`,
  // Day 3 keys (all pre-registered in redis-key-registry.md)
  explorePool:   ()                       => 'feed:explore:pool',
  eventsQueue:   ()                       => 'feed:events:queue',
  impression:    (userId, itemId)         => `feed:impression:${userId}:${itemId}`,
};

// ─── TTLs (from redis-key-registry.md) ───────────────────────────────────────
const TTL = {
  FEED_SLICE:      300,    // 5 minutes
  SEEN_SET:        86400,  // 24 hours
  CANDIDATE_POOL:  120,    // 2 minutes
  EXPLORE_POOL:    300,    // 5 minutes — per redis-key-registry.md
  IMPRESSION_DEDUP: 3600,  // 1 hour  — per redis-key-registry.md
};

// ─── Max Sizes (from redis-key-registry.md) ──────────────────────────────────
const LIMITS = {
  SEEN_SET_MAX: 5000,
  FEED_SLICE_MAX_BYTES: 50 * 1024, // 50 KB
  CANDIDATE_POOL_MAX_BYTES: 200 * 1024, // 200 KB
};

// ─── B1.2 ─────────────────────────────────────────────────────────────────────
/**
 * Store a precomputed feed page slice in Redis.
 * @param {string} userId
 * @param {string} cursor  - Pagination cursor identifying this slice
 * @param {Array}  items   - Array of FeedItem objects
 * @param {number} [ttl=300] - TTL in seconds (default from registry)
 * @returns {Promise<void>}
 */
async function setFeedSlice(userId, cursor, items, ttl = TTL.FEED_SLICE) {
  if (!userId || !cursor) throw new Error("setFeedSlice: userId and cursor are required");
  if (!Array.isArray(items)) throw new Error("setFeedSlice: items must be an array");

  const key = keys.feedSlice(userId, cursor);
  const payload = JSON.stringify(items);

  if (Buffer.byteLength(payload, "utf8") > LIMITS.FEED_SLICE_MAX_BYTES) {
    throw new Error(`setFeedSlice: payload exceeds max size of ${LIMITS.FEED_SLICE_MAX_BYTES} bytes`);
  }

  await redis.set(key, payload, "EX", ttl);
}

// ─── B1.3 ─────────────────────────────────────────────────────────────────────
/**
 * Retrieve a cached feed slice from Redis.
 * @param {string} userId
 * @param {string} cursor
 * @returns {Promise<Array|null>} - Parsed FeedItem array or null on miss
 */
async function getFeedSlice(userId, cursor) {
  if (!userId || !cursor) throw new Error("getFeedSlice: userId and cursor are required");

  const key = keys.feedSlice(userId, cursor);
  const raw = await redis.get(key);

  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ─── B1.4 ─────────────────────────────────────────────────────────────────────
/**
 * Add item IDs to the user's seen set (deduplication set).
 * Enforces max size of 5000 members per registry rules.
 * @param {string}   userId
 * @param {string[]} itemIds - Array of item UUIDs
 * @returns {Promise<void>}
 */
async function addToSeenSet(userId, itemIds) {
  if (!userId) throw new Error("addToSeenSet: userId is required");
  if (!Array.isArray(itemIds) || itemIds.length === 0) return;

  const key = keys.seenSet(userId);

  // Use pipeline for atomicity on multi-key write (per redis-key-registry.md rule 4)
  const pipeline = redis.pipeline();
  pipeline.sadd(key, ...itemIds);
  pipeline.expire(key, TTL.SEEN_SET);
  await pipeline.exec();

  // A9.5 — Trim if over max size.
  // Current strategy: SRANDMEMBER removes random members to stay under SEEN_SET_MAX (5000).
  // This is an intentional Day 4 trade-off: Redis Sets do not support insertion-order
  // traversal. Removing the truly "oldest" items would require migrating this key to a
  // Redis Sorted Set (ZADD with timestamp as score) so ZREMRANGEBYRANK can target the
  // lowest-score (oldest) members.
  //
  // Day 5 improvement path (A9.5 full fix):
  //   1. Change feed:seen:{userId} from Set → Sorted Set
  //   2. Replace SADD → ZADD with Date.now() as score
  //   3. Replace SMEMBERS → ZRANGE / ZREVRANGE
  //   4. Replace SCARD / SRANDMEMBER / SREM → ZCARD / ZREMRANGEBYRANK 0 <excess-1>
  //   Note: key-type migration requires a one-time DEL of existing Set keys or a
  //   rolling migration on first write (key-type check → DEL → ZADD).
  const size = await redis.scard(key);
  if (size > LIMITS.SEEN_SET_MAX) {
    const excess = size - LIMITS.SEEN_SET_MAX;
    const toRemove = await redis.srandmember(key, excess);
    if (toRemove.length > 0) {
      await redis.srem(key, ...toRemove);
    }
  }
}

// ─── B1.5 ─────────────────────────────────────────────────────────────────────
/**
 * Get all item IDs in the user's seen set.
 * @param {string} userId
 * @returns {Promise<string[]>}
 */
async function getSeenSet(userId) {
  if (!userId) throw new Error("getSeenSet: userId is required");

  const key = keys.seenSet(userId);
  return redis.smembers(key);
}

// ─── B1.6 ─────────────────────────────────────────────────────────────────────
/**
 * Delete the user's seen set from Redis.
 * Called on session reset.
 * @param {string} userId
 * @returns {Promise<void>}
 */
async function clearSeenSet(userId) {
  if (!userId) throw new Error("clearSeenSet: userId is required");

  const key = keys.seenSet(userId);
  await redis.del(key);
}


// ─── B1.7: Key pattern verification helper ────────────────────────────────────
/**
 * Returns all Redis key patterns used by this module.
 * Used to verify compliance with redis-key-registry.md during integration checkpoint.
 * @returns {Object}
 */
function getRegisteredKeyPatterns() {
  return {
    feedSlice:     "feed:slice:{user_id}:{cursor}",
    seenSet:       "feed:seen:{user_id}",
    candidatePool: "feed:candidates:{user_id}",
  };
}

// ─── B5: Candidate Pool Cache ─────────────────────────────────────────────────
// Key: feed:candidates:{user_id} | Type: String (JSON) | TTL: 120s | Max: 200 KB
// Registry owner: Dev A (registered) — implementation: Dev B (Day 2 B5)

/**
 * Store the merged candidate pool for a user.
 * Called by candidateGenerator after dedup and merge.
 *
 * @param {string} userId
 * @param {Array}  candidates - Merged, deduplicated CandidateItem[]
 * @returns {Promise<void>}
 */
async function setCandidatePool(userId, candidates, ttl = TTL.CANDIDATE_POOL) {
  if (!userId) throw new Error("setCandidatePool: userId is required");
  if (!Array.isArray(candidates)) throw new Error("setCandidatePool: candidates must be an array");

  const key     = keys.candidatePool(userId);
  const payload = JSON.stringify(candidates);

  if (Buffer.byteLength(payload, "utf8") > LIMITS.CANDIDATE_POOL_MAX_BYTES) {
    throw new Error(
      `setCandidatePool: payload exceeds max size of ${LIMITS.CANDIDATE_POOL_MAX_BYTES} bytes`
    );
  }

  await redis.set(key, payload, "EX", ttl);
}

/**
 * Retrieve the cached candidate pool for a user.
 * Returns null on cache miss — caller must fall back to live generation.
 *
 * @param {string} userId
 * @returns {Promise<Array|null>} Parsed CandidateItem[] or null
 */
async function getCandidatePool(userId) {
  if (!userId) throw new Error("getCandidatePool: userId is required");

  const key = keys.candidatePool(userId);
  const raw = await redis.get(key);

  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  // Feed slice
  setFeedSlice,
  getFeedSlice,
  // Seen set
  addToSeenSet,
  getSeenSet,
  clearSeenSet,
  // Candidate pool (Day 2)
  setCandidatePool,
  getCandidatePool,
  // Registry helper
  getRegisteredKeyPatterns,
  // Internals — exported for unit tests only
  _keys:   keys,
  _TTL:    TTL,
  _LIMITS: LIMITS,
};


