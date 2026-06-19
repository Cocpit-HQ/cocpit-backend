/**
 * explorationPool.js
 * COCPIT Feed Engine — Exploration Pool
 *
 * Sprint Task: Day 3 — Task A7 (A7.1 – A7.4)
 * Owner: Dev A
 * AI-Assisted: Yes (Antigravity)
 * Contracts read: contracts/redis-key-registry.md (FROZEN),
 *                 contracts/ranking-features.md (FROZEN v1.0.0)
 * Last reviewed: 2026-05-26
 *
 * Maintains a Redis sorted set `feed:explore:pool` (score = raw_engagement)
 * that serves as the global exploration candidate pool.
 *
 * Pool sources (A7.2):
 *   1. Global trending posts outside the requesting user's social graph
 *   2. New creator content (accounts < 30 days old)
 *
 * Redis Key (from redis-key-registry.md — FROZEN):
 *   feed:explore:pool  → Sorted Set (score=engagement)  TTL: 300s
 */

'use strict';

const { v4: uuidv4 } = require('uuid');
const redis = require('../../../core/cache/redis');
const { createCandidateItem, CANDIDATE_SOURCES } = require('../candidates/CandidateItem');

// ---------------------------------------------------------------------------
// Constants (from redis-key-registry.md — FROZEN)
// ---------------------------------------------------------------------------

const EXPLORE_POOL_KEY = 'feed:explore:pool';
const EXPLORE_POOL_TTL = 300;          // 5 minutes — per registry
const SEEN_SET_KEY     = (userId) => `feed:seen:${userId}`;

const POOL_MAX_SIZE    = 200;          // max items stored in the sorted set
const EXPLORE_CAP      = 50;          // max candidates read per ZREVRANGE call
const NEW_CREATOR_DAYS = 30;          // A7.2 — "new creator" threshold

// ---------------------------------------------------------------------------
// Internal: raw engagement formula (same as socialGraphSource / trendingSource)
// ranking-features.md (FROZEN): raw = (likes × 0.6) + (comments × 1.2) + (shares × 1.5)
// ---------------------------------------------------------------------------

function _computeRawEngagement(likeCount, commentCount, shareCount) {
  return (likeCount * 0.6) + (commentCount * 1.2) + (shareCount * 1.5);
}

// ---------------------------------------------------------------------------
// A7.2 — Source 1: Global trending posts outside the user's social graph
// (For refreshExplorationPool — userId is not available here; we build a
//  global pool. Per-user seen filtering happens in getExplorationCandidates.)
// ---------------------------------------------------------------------------

/**
 * _fetchGlobalTrending
 * Posts from the last 7 days with engagement > 0, from authors the
 * "average user" doesn't follow (approximated: broad public posts,
 * high engagement, excluding already-in-trending-set authors).
 *
 * @param {object} pool - pg Pool
 * @returns {Promise<Array>}
 */
async function _fetchGlobalTrending(pool) {
  const sql = `
    SELECT
      p.post_id   AS content_id,
      'post'      AS type,
      p.author_id,
      p.created_at,
      (SELECT COUNT(*) FROM post_likes    pl WHERE pl.post_id = p.post_id)::float AS like_count,
      (SELECT COUNT(*) FROM post_comments pc WHERE pc.post_id = p.post_id)::float AS comment_count,
      (SELECT COUNT(*) FROM posts         rp WHERE rp.shared_post_id = p.post_id)::float AS share_count
    FROM posts p
    WHERE p.created_at  > NOW() - INTERVAL '7 days'
      AND p.visibility  = 'public'
      AND (p.is_removed IS FALSE OR p.is_removed IS NULL)
      AND (p.author_org_id IS NULL)
    ORDER BY (
      (SELECT COUNT(*) FROM post_likes    pl WHERE pl.post_id = p.post_id) * 0.6 +
      (SELECT COUNT(*) FROM post_comments pc WHERE pc.post_id = p.post_id) * 1.2 +
      (SELECT COUNT(*) FROM posts         rp WHERE rp.shared_post_id = p.post_id) * 1.5
    ) DESC
    LIMIT 100
  `;

  try {
    const { rows } = await pool.query(sql);
    return rows;
  } catch (err) {
    console.error('[explorationPool] Global trending query failed:', err.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// A7.2 — Source 2: New creator content (accounts < 30 days old)
// ---------------------------------------------------------------------------

/**
 * _fetchNewCreatorContent
 * Posts from new users (account created < NEW_CREATOR_DAYS days ago).
 * These get a baseline engagement score so they appear in the sorted set.
 *
 * @param {object} pool - pg Pool
 * @returns {Promise<Array>}
 */
async function _fetchNewCreatorContent(pool) {
  const sql = `
    SELECT
      p.post_id   AS content_id,
      'post'      AS type,
      p.author_id,
      p.created_at,
      (SELECT COUNT(*) FROM post_likes    pl WHERE pl.post_id = p.post_id)::float AS like_count,
      (SELECT COUNT(*) FROM post_comments pc WHERE pc.post_id = p.post_id)::float AS comment_count,
      (SELECT COUNT(*) FROM posts         rp WHERE rp.shared_post_id = p.post_id)::float AS share_count
    FROM posts p
    JOIN active_users u ON u.user_id = p.author_id
    WHERE u.created_at   > NOW() - INTERVAL '${NEW_CREATOR_DAYS} days'
      AND p.created_at   > NOW() - INTERVAL '7 days'
      AND p.visibility   = 'public'
      AND (p.is_removed IS FALSE OR p.is_removed IS NULL)
    ORDER BY p.created_at DESC
    LIMIT 50
  `;

  try {
    const { rows } = await pool.query(sql);
    return rows;
  } catch (err) {
    console.error('[explorationPool] New creator query failed:', err.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// A7.3 — refreshExplorationPool
// ---------------------------------------------------------------------------

/**
 * refreshExplorationPool
 *
 * Repopulates `feed:explore:pool` Redis sorted set from both pool sources.
 * Called periodically by the feed worker to keep the pool fresh.
 *
 * Strategy:
 *   1. Fetch global trending + new creator rows in parallel
 *   2. Deduplicate by content_id (trending wins on collision)
 *   3. ZADD all to sorted set with raw_engagement as score
 *   4. Trim to POOL_MAX_SIZE, set TTL 300s
 *
 * @param {object} pool - pg Pool (required)
 * @returns {Promise<void>}
 */
async function refreshExplorationPool(pool) {
  if (!pool) {
    console.warn('[explorationPool] refreshExplorationPool: pool required');
    return;
  }

  // ── 1. Fetch both sources in parallel ─────────────────────────────────────
  const [trendingRows, newCreatorRows] = await Promise.all([
    _fetchGlobalTrending(pool),
    _fetchNewCreatorContent(pool),
  ]);

  if (trendingRows.length === 0 && newCreatorRows.length === 0) {
    console.warn('[explorationPool] No rows returned from either source — pool not refreshed');
    return;
  }

  // ── 2. Deduplicate (trending wins) ────────────────────────────────────────
  const seen   = new Set();
  const merged = [];

  for (const row of [...trendingRows, ...newCreatorRows]) {
    if (!seen.has(row.content_id)) {
      seen.add(row.content_id);
      merged.push(row);
    }
  }

  // ── 3. ZADD to Redis sorted set ───────────────────────────────────────────
  try {
    const pipeline = redis.pipeline();

    for (const row of merged.slice(0, POOL_MAX_SIZE)) {
      const score = _computeRawEngagement(
        parseFloat(row.like_count    || 0),
        parseFloat(row.comment_count || 0),
        parseFloat(row.share_count   || 0),
      );
      // Guarantee a minimum score of 0.01 so new creators (0 engagement) appear
      pipeline.zadd(EXPLORE_POOL_KEY, Math.max(score, 0.01), row.content_id);
    }

    // ── 4. Trim + set TTL ─────────────────────────────────────────────────
    pipeline.zremrangebyrank(EXPLORE_POOL_KEY, 0, -(POOL_MAX_SIZE + 1)); // keep top N
    pipeline.expire(EXPLORE_POOL_KEY, EXPLORE_POOL_TTL);

    await pipeline.exec();

    console.info(
      `[explorationPool] Pool refreshed: ${merged.length} items written ` +
      `(trending: ${trendingRows.length}, new-creator: ${newCreatorRows.length})`
    );
  } catch (err) {
    // Non-fatal — pool refresh failure never blocks the feed
    console.error('[explorationPool] Redis write failed during pool refresh:', err.message);
  }
}

// ---------------------------------------------------------------------------
// A7.4 — getExplorationCandidates
// ---------------------------------------------------------------------------

/**
 * getExplorationCandidates
 *
 * Reads the top candidates from `feed:explore:pool`, filters out items
 * the user has already seen (`feed:seen:{userId}`), and returns up to
 * `count` CandidateItem objects.
 *
 * Non-fatal on Redis failure — returns [] to allow feed to degrade gracefully.
 *
 * @param {string} userId - UUID of the requesting user
 * @param {number} count  - Max exploration candidates to return (typically 3)
 * @returns {Promise<Array>} CandidateItem[] with source: 'exploration'
 */
async function getExplorationCandidates(userId, count = 3) {
  if (!userId) {
    console.warn('[explorationPool] getExplorationCandidates: userId required');
    return [];
  }

  try {
    // ── 1. Read top candidates from pool ─────────────────────────────────────
    // Read more than needed so we have buffer after seen-set filtering
    const raw = await redis.zrevrange(EXPLORE_POOL_KEY, 0, EXPLORE_CAP - 1, 'WITHSCORES');
    if (!raw || raw.length === 0) return [];

    // Parse alternating [contentId, score] pairs
    const poolItems = [];
    for (let i = 0; i < raw.length; i += 2) {
      poolItems.push({
        content_id: raw[i],
        score:      parseFloat(raw[i + 1]) || 0,
      });
    }

    // ── 2. Load user's seen set for filtering ────────────────────────────────
    let seenIds = new Set();
    try {
      const seenArr = await redis.smembers(SEEN_SET_KEY(userId));
      seenIds = new Set(seenArr);
    } catch (seenErr) {
      // Non-fatal — if seen set unavailable, serve without filtering
      console.warn('[explorationPool] Could not fetch seen set:', seenErr.message);
    }

    // ── 3. Filter seen + take `count` ────────────────────────────────────────
    const unseen = poolItems
      .filter(item => !seenIds.has(item.content_id))
      .slice(0, count);

    // ── 4. Map to CandidateItem ───────────────────────────────────────────────
    const candidates = unseen.map(item =>
      createCandidateItem({
        itemId:        uuidv4(),
        itemType:      'post',                         // exploration pool is posts only
        source:        CANDIDATE_SOURCES.EXPLORATION,
        contentId:     item.content_id,
        authorId:      null,                           // not stored in sorted set score
        score:         item.score,
        relationshipScore: 0,
        isOpportunity: false,
        metadata:      { from_explore_pool: true },
      })
    );

    return candidates;

  } catch (err) {
    // Non-fatal — exploration failure must not crash the feed
    console.error('[explorationPool] getExplorationCandidates failed:', err.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  refreshExplorationPool,
  getExplorationCandidates,

  // Exported for integration verification
  _EXPLORE_POOL_KEY: EXPLORE_POOL_KEY,
  _EXPLORE_POOL_TTL: EXPLORE_POOL_TTL,
};
