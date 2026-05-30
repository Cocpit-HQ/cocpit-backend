/**
 * Module: Social Graph Candidate Source
 * Sprint Task: Day 2 — Task A3 (A3.1 – A3.5)
 * Owner: Dev A
 * AI-Assisted: Yes (Antigravity)
 * Contracts read: contracts/schemas/candidate.schema.json, contracts/ranking-features.md
 * Last reviewed: 2026-05-24
 *
 * Relationship scores (from ranking-features.md — FROZEN):
 *   0.0  = No connection
 *   0.25 = 2nd-degree connection
 *   0.50 = 1st-degree follower
 *   0.75 = Mutual follow (both follow each other = connection)
 *   1.0  = Close collaborator (not implemented at this layer)
 */

'use strict';

const { v4: uuidv4 } = require('uuid');
const { createCandidateItem, CANDIDATE_SOURCES } = require('../CandidateItem');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FIRST_DEGREE_WINDOW_HOURS  = 72;
const SECOND_DEGREE_WINDOW_HOURS = 48;
const SOURCE_CAP = 50; // A3.5 — max candidates from this source

// ---------------------------------------------------------------------------
// Internal: compute raw_engagement score from subquery counts
// Formula from ranking-features.md (FROZEN):
//   raw_engagement = (likes × 0.6) + (comments × 1.2) + (shares × 1.5)
// clicks not tracked at post level — defaulted to 0
// ---------------------------------------------------------------------------
function _computeRawEngagement(likeCount, commentCount, shareCount) {
  return (likeCount * 0.6) + (commentCount * 1.2) + (shareCount * 1.5);
}

// ---------------------------------------------------------------------------
// A3.1 — Query 1st-degree posts (last 72h)
// Relationship score: 0.75 if mutual follow (connection), else 0.50
// ---------------------------------------------------------------------------
async function _fetchFirstDegree(userId, pool) {
  const sql = `
    SELECT
      p.post_id                       AS content_id,
      'post'                          AS type,
      p.author_id,
      p.created_at,
      (SELECT COUNT(*) FROM post_likes    pl WHERE pl.post_id = p.post_id)::float AS like_count,
      (SELECT COUNT(*) FROM post_comments pc WHERE pc.post_id = p.post_id)::float AS comment_count,
      (SELECT COUNT(*) FROM posts         rp WHERE rp.shared_post_id = p.post_id)::float AS share_count,
      (SELECT COUNT(*) FROM reports       r  WHERE r.target_type = 'POST' AND r.target_id = p.post_id AND r.created_at > NOW() - INTERVAL '24 hours')::float AS report_count,
      EXISTS (
        SELECT 1 FROM connections c
        WHERE c.user_id = $1 AND c.connected_user_id = p.author_id
      ) AS is_mutual
    FROM posts p
    JOIN followers f ON f.following_id = p.author_id
    WHERE f.follower_id = $1
      AND p.author_id  != $1
      AND p.created_at  > NOW() - INTERVAL '${FIRST_DEGREE_WINDOW_HOURS} hours'
      AND p.visibility  = 'public'
      AND (p.is_removed IS FALSE OR p.is_removed IS NULL)
    ORDER BY p.created_at DESC
    LIMIT ${SOURCE_CAP}
  `;

  const { rows } = await pool.query(sql, [userId]);
  return rows;
}

// ---------------------------------------------------------------------------
// A3.2 — Query 2nd-degree posts (last 48h)
// Relationship score: 0.25
// ---------------------------------------------------------------------------
async function _fetchSecondDegree(userId, pool) {
  const sql = `
    SELECT
      p.post_id                       AS content_id,
      'post'                          AS type,
      p.author_id,
      p.created_at,
      (SELECT COUNT(*) FROM post_likes    pl WHERE pl.post_id = p.post_id)::float AS like_count,
      (SELECT COUNT(*) FROM post_comments pc WHERE pc.post_id = p.post_id)::float AS comment_count,
      (SELECT COUNT(*) FROM posts         rp WHERE rp.shared_post_id = p.post_id)::float AS share_count,
      (SELECT COUNT(*) FROM reports       r  WHERE r.target_type = 'POST' AND r.target_id = p.post_id AND r.created_at > NOW() - INTERVAL '24 hours')::float AS report_count
    FROM posts p
    JOIN followers f2 ON f2.following_id = p.author_id
    JOIN followers f1 ON f1.following_id  = f2.follower_id
    WHERE f1.follower_id = $1
      AND f2.follower_id != $1
      AND p.author_id    != $1
      AND p.created_at    > NOW() - INTERVAL '${SECOND_DEGREE_WINDOW_HOURS} hours'
      AND p.visibility    = 'public'
      AND (p.is_removed IS FALSE OR p.is_removed IS NULL)
      AND NOT EXISTS (
        SELECT 1 FROM followers direct
        WHERE direct.follower_id = $1 AND direct.following_id = p.author_id
      )
    ORDER BY p.created_at DESC
    LIMIT ${SOURCE_CAP}
  `;

  const { rows } = await pool.query(sql, [userId]);
  return rows;
}

// ---------------------------------------------------------------------------
// A3.3 — Map DB rows → CandidateItem objects
// ---------------------------------------------------------------------------
function _mapRowToCandidate(row, relationshipScore) {
  const rawEngagement = _computeRawEngagement(
    parseFloat(row.like_count    || 0),
    parseFloat(row.comment_count || 0),
    parseFloat(row.share_count   || 0),
  );

  return createCandidateItem({
    itemId:            uuidv4(),
    itemType:          row.type,
    source:            CANDIDATE_SOURCES.SOCIAL_GRAPH,
    contentId:         row.content_id,
    authorId:          row.author_id,
    createdAt:         row.created_at instanceof Date
                         ? row.created_at.toISOString()
                         : row.created_at,
    score:             rawEngagement,
    relationshipScore,
    isOpportunity:     false,
    metadata: {
      like_count:    parseFloat(row.like_count    || 0),
      comment_count: parseFloat(row.comment_count || 0),
      share_count:   parseFloat(row.share_count   || 0),
      report_count:  parseFloat(row.report_count  || 0),
    },
  });
}

// ---------------------------------------------------------------------------
// A3.4 / A3.5 — getSocialGraphCandidates (public API)
// ---------------------------------------------------------------------------

/**
 * getSocialGraphCandidates
 *
 * Fetches candidates from the requesting user's social graph.
 * Returns up to SOURCE_CAP (50) deduplicated CandidateItem objects.
 *
 * @param {object} params
 * @param {string} params.userId  - Requesting user's UUID
 * @param {number} params.limit   - Max candidates (honours SOURCE_CAP cap)
 * @param {object} params.pool    - pg Pool (read-only)
 * @returns {Promise<Array>}      - CandidateItem[]
 */
async function getSocialGraphCandidates({ userId, limit, pool }) {
  try {
    if (!userId) {
      console.warn('[socialGraphSource] userId missing — returning []');
      return [];
    }

    if (!pool) {
      console.warn('[socialGraphSource] pool not provided — returning []');
      return [];
    }

    let firstDegreeRows  = [];
    let secondDegreeRows = [];

    [firstDegreeRows, secondDegreeRows] = await Promise.all([
      _fetchFirstDegree(userId, pool),
      _fetchSecondDegree(userId, pool),
    ]);

    // A3.3 — Map to CandidateItems with correct relationship scores
    const firstDegreeCandidates = firstDegreeRows.map(row => {
      // is_mutual → connections table entry found → 0.75 (mutual follow)
      const relationshipScore = row.is_mutual ? 0.75 : 0.50;
      return _mapRowToCandidate(row, relationshipScore);
    });

    const secondDegreeCandidates = secondDegreeRows.map(row =>
      _mapRowToCandidate(row, 0.25)
    );

    // A3.4 — Merge, deduplicate by contentId (first-degree wins on collision)
    const seenContentIds = new Set();
    const merged = [];

    for (const candidate of [...firstDegreeCandidates, ...secondDegreeCandidates]) {
      if (!seenContentIds.has(candidate.contentId)) {
        seenContentIds.add(candidate.contentId);
        merged.push(candidate);
      }
    }

    // A3.5 — Apply cap
    const cap = Math.min(limit || SOURCE_CAP, SOURCE_CAP);
    return merged.slice(0, cap);
  } catch (err) {
    console.error('[socialGraphSource] Failed fetching social graph candidates:', err.message);
    return [];
  }
}

module.exports = { getSocialGraphCandidates };
