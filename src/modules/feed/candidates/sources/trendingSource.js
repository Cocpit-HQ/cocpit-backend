/**
 * Module: Trending Candidate Source
 * Sprint Task: Day 2 — Task A4 (A4.1 – A4.4)
 * Owner: Dev A
 * AI-Assisted: Yes (Antigravity)
 * Contracts read: contracts/schemas/candidate.schema.json,
 *                 contracts/redis-key-registry.md, contracts/ranking-features.md
 * Last reviewed: 2026-05-24
 *
 * Redis Keys Used (all from redis-key-registry.md — FROZEN):
 *   feed:trending:global  → Sorted Set (score = raw_engagement), TTL 600s
 */

'use strict';

const { v4: uuidv4 } = require('uuid');
const redis = require('../../../../core/cache/redis');
const { createCandidateItem, CANDIDATE_SOURCES } = require('../CandidateItem');

// ---------------------------------------------------------------------------
// Constants (from redis-key-registry.md — FROZEN)
// ---------------------------------------------------------------------------

const TRENDING_REDIS_KEY = 'feed:trending:global';
const TRENDING_TTL_SECONDS = 600;   // 10 minutes — per registry
const TRENDING_CAP = 30;            // A4.4 — max 30 trending candidates
const TRENDING_DB_WINDOW_HOURS = 24;// A4.1 — last 24h

// ---------------------------------------------------------------------------
// Internal: compute raw_engagement (same formula as social graph source)
// ranking-features.md: raw = (likes × 0.6) + (comments × 1.2) + (shares × 1.5)
// ---------------------------------------------------------------------------
function _computeRawEngagement(likeCount, commentCount, shareCount) {
  return (likeCount * 0.6) + (commentCount * 1.2) + (shareCount * 1.5);
}

// ---------------------------------------------------------------------------
// A4.1 — DB query: top engagement posts in last 24h
// ---------------------------------------------------------------------------
async function _fetchTrendingFromDb(pool) {
  const sql = `
    SELECT
      p.post_id   AS content_id,
      'post'      AS type,
      p.author_id,
      p.created_at,
      p.shared_post_id,
      p.content,
      (SELECT COUNT(*) FROM active_post_likes    pl WHERE pl.post_id = p.post_id)::float AS like_count,
      (SELECT COUNT(*) FROM active_post_comments pc WHERE pc.post_id = p.post_id)::float AS comment_count,
      ((SELECT COUNT(DISTINCT rp.author_id) FROM posts rp WHERE rp.shared_post_id = p.post_id AND rp.is_active = TRUE) + (SELECT COUNT(DISTINCT s.sender_id) FROM shares s WHERE s.entity_id = p.post_id::text AND s.entity_type = 'post'))::float AS share_count,
      (SELECT COUNT(*) FROM reports       r  WHERE r.target_type = 'POST' AND r.target_id = p.post_id AND r.created_at > NOW() - INTERVAL '24 hours')::float AS report_count
    FROM posts p
    WHERE p.created_at  > NOW() - INTERVAL '${TRENDING_DB_WINDOW_HOURS} hours'
      AND p.visibility  = 'public'
      AND (p.is_removed IS FALSE OR p.is_removed IS NULL)
      AND p.is_active = TRUE
      AND p.is_community_article IS NOT TRUE
    ORDER BY (
      (SELECT COUNT(*) FROM active_post_likes    pl WHERE pl.post_id = p.post_id) * 0.6 +
      (SELECT COUNT(*) FROM active_post_comments pc WHERE pc.post_id = p.post_id) * 1.2 +
      ((SELECT COUNT(DISTINCT rp.author_id) FROM posts rp WHERE rp.shared_post_id = p.post_id AND rp.is_active = TRUE) + (SELECT COUNT(DISTINCT s.sender_id) FROM shares s WHERE s.entity_id = p.post_id::text AND s.entity_type = 'post')) * 1.5
    ) DESC
    LIMIT 50
  `;

  const { rows } = await pool.query(sql);
  return rows;
}

// ---------------------------------------------------------------------------
// A4.2 — Populate Redis sorted set from DB rows (TTL 600s)
// ---------------------------------------------------------------------------
async function _populateRedisCache(rows) {
  if (!rows || rows.length === 0) return;

  try {
    const pipeline = redis.pipeline();
    for (const row of rows) {
      const score = _computeRawEngagement(
        parseFloat(row.like_count    || 0),
        parseFloat(row.comment_count || 0),
        parseFloat(row.share_count   || 0),
      );
      // ZADD feed:trending:global <score> <content_id>
      pipeline.zadd(TRENDING_REDIS_KEY, score, row.content_id);
    }
    pipeline.expire(TRENDING_REDIS_KEY, TRENDING_TTL_SECONDS);
    await pipeline.exec();
  } catch (err) {
    console.warn('[trendingSource] Redis populate failed (non-fatal):', err.message);
  }
}

// ---------------------------------------------------------------------------
// Internal: read from Redis sorted set, returns raw rows [{content_id, score}]
// Returns null if Redis is unavailable or key is missing
// ---------------------------------------------------------------------------
async function _readFromRedis() {
  try {
    // ZREVRANGE with WITHSCORES returns [member, score, member, score, ...]
    const result = await redis.zrevrange(TRENDING_REDIS_KEY, 0, TRENDING_CAP - 1, 'WITHSCORES');
    if (!result || result.length === 0) return null;

    // Parse alternating [id, score] pairs
    const rows = [];
    for (let i = 0; i < result.length; i += 2) {
      rows.push({
        content_id: result[i],
        score:      parseFloat(result[i + 1]) || 0,
      });
    }
    return rows;
  } catch (err) {
    console.warn('[trendingSource] Redis read failed (non-fatal):', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Internal: map a row → CandidateItem for trending source
// ---------------------------------------------------------------------------
function _mapRowToCandidate(row) {
  const rawEngagement = typeof row.score === 'number'
    ? row.score
    : _computeRawEngagement(
        parseFloat(row.like_count    || 0),
        parseFloat(row.comment_count || 0),
        parseFloat(row.share_count   || 0),
      );

  return createCandidateItem({
    itemId:            uuidv4(),
    itemType:          row.type || 'post',
    source:            CANDIDATE_SOURCES.TRENDING_GLOBAL,
    contentId:         row.content_id,
    authorId:          row.author_id || null,
    createdAt:         row.created_at
                         ? (row.created_at instanceof Date
                             ? row.created_at.toISOString()
                             : row.created_at)
                         : new Date().toISOString(),
    score:             rawEngagement,
    relationshipScore: 0,     // No relationship implied by trending
    isOpportunity:     false,
    metadata: {
      like_count:    parseFloat(row.like_count    || 0),
      comment_count: parseFloat(row.comment_count || 0),
      share_count:   parseFloat(row.share_count   || 0),
      report_count:  parseFloat(row.report_count  || 0),
      sharedPostId:  row.shared_post_id,
      content:       row.content,
    },
  });
}

// ---------------------------------------------------------------------------
// A4 — getTrendingCandidates (public API)
// ---------------------------------------------------------------------------

/**
 * getTrendingCandidates
 *
 * Returns up to 30 trending candidates not already found in the social graph.
 * Priority: Redis sorted set → DB query → empty fallback.
 *
 * @param {object}  params
 * @param {string}  params.userId          - Requesting user's UUID (reserved for niche trending)
 * @param {number}  params.limit           - Max candidates
 * @param {object}  params.pool            - pg Pool (read-only)
 * @param {Set}     [params.socialGraphIds]- Set of contentIds from social graph source (for dedup)
 * @returns {Promise<Array>}               - CandidateItem[]
 */
async function getTrendingCandidates({ userId, limit, pool, socialGraphIds = new Set(), blockedIds = new Set() }) {
  try {
    void userId; // reserved for niche trending in future

    let candidates = [];

    // ── Step 1: Try Redis cache ───────────────────────────────────────────────
    const redisRows = await _readFromRedis();

    if (redisRows && redisRows.length > 0) {
      // Cache hit — map and filter
      candidates = redisRows
        .filter(row => !socialGraphIds.has(row.content_id))  // A4.3 dedup
        .filter(row => !blockedIds.has(row.author_id) && !blockedIds.has(row.author_org_id))
        .slice(0, TRENDING_CAP)
        .map(row => _mapRowToCandidate(row));

      return candidates;
    }

    // ── Step 2: Redis miss — query DB ────────────────────────────────────────
    if (!pool) {
      console.warn('[trendingSource] pool not provided and Redis miss — returning []');
      return [];
    }

    let dbRows = [];
    try {
      dbRows = await _fetchTrendingFromDb(pool);
    } catch (err) {
      console.error('[trendingSource] DB query failed:', err.message);
      return []; // A4 fallback — never crashes the feed
    }

    // ── Step 3: Populate Redis for next requests (A4.2) ──────────────────────
    await _populateRedisCache(dbRows);

    // ── Step 4: Filter against social graph, cap at 30, map to CandidateItem ─
    candidates = dbRows
      .filter(row => !socialGraphIds.has(row.content_id)) // A4.3 dedup
      .filter(row => !blockedIds.has(row.author_id) && !blockedIds.has(row.author_org_id))
      .slice(0, TRENDING_CAP)
      .map(row => _mapRowToCandidate(row));

    return candidates;
  } catch (err) {
    console.error('[trendingSource] Failed fetching trending candidates:', err.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Exported key patterns (for integration checkpoint verification)
// ---------------------------------------------------------------------------
function getRegisteredKeyPatterns() {
  return {
    trendingGlobal: TRENDING_REDIS_KEY,
  };
}

module.exports = {
  getTrendingCandidates,
  getRegisteredKeyPatterns,
  _TRENDING_TTL: TRENDING_TTL_SECONDS,
  _TRENDING_KEY: TRENDING_REDIS_KEY,
};
