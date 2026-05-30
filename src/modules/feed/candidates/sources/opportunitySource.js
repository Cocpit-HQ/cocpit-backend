/**
 * opportunitySource.js
 * COCPIT Feed Engine — Opportunity Candidate Source
 *
 * Sprint Task: Day 3 — Task A6 (A6.1 – A6.5)
 * Owner: Dev A
 * AI-Assisted: Yes (Antigravity)
 * Contracts read: contracts/schemas/candidate.schema.json,
 *                 contracts/ranking-features.md (FROZEN v1.0.0)
 * Last reviewed: 2026-05-26
 *
 * Queries jobs and events that are relevant to the requesting user.
 * Computes a three-factor relevance score:
 *   relevance = location_match × intent_match × recency
 * Only items with relevance > 0.6 are returned.
 * All returned candidates are tagged: isOpportunity: true
 *
 * Schema notes (from schema.sql — source of truth):
 *   events.start_time  TIMESTAMPTZ   ← NOT 'event_date'
 *   user_skills        JOIN via profiles(profile_id) → users(user_id)
 *   user_intent_scores columns: job_seeker_score, event_score (INT, 0–∞)
 */

'use strict';

const { v4: uuidv4 } = require('uuid');
const { createCandidateItem, CANDIDATE_SOURCES } = require('../CandidateItem');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RELEVANCE_THRESHOLD = 0.6;   // A6.4 — filter items below this score
const OPPORTUNITY_CAP     = 20;    // max opportunity candidates to return
const RECENCY_WINDOW_DAYS = 7;     // A6.1 / A6.2 — last 7 days

// ---------------------------------------------------------------------------
// A6.3 helpers — relevance sub-scores
// ---------------------------------------------------------------------------

/**
 * _computeLocationMatch
 * Compares user location text to job/event location text.
 * Simple text-based comparison (geo-service not available at this layer).
 *
 * @param {string|null} userLocation  - User's location string (from users.location or profiles)
 * @param {string|null} itemLocation  - Job/event location field
 * @returns {number} 0.0 | 0.5 | 1.0
 */
function _computeLocationMatch(userLocation, itemLocation) {
  if (!itemLocation) return 0.5;
  const i = itemLocation.toLowerCase().trim();
  if (i.includes('remote') || i.includes('virtual')) return 0.8;
  if (!userLocation) return 0.5; // unknown → neutral
  const u = userLocation.toLowerCase().trim();
  if (u === i) return 1.0;
  // Partial: share at least one word (city or country token)
  const uTokens = u.split(/[\s,]+/);
  const iTokens = i.split(/[\s,]+/);
  const overlap = uTokens.some(t => t.length > 2 && iTokens.includes(t));
  if (overlap) return 0.5;
  return 0.0;
}

/**
 * _computeIntentMatch
 * Maps user intent scores to the item type.
 * Scores from user_intent_scores are raw integers (0–∞); normalize to 0–1.
 *
 * @param {{ job_seeker_score: number, event_score: number }} intentScores
 * @param {'job'|'event'} itemType
 * @returns {number} 0–1
 */
function _computeIntentMatch(intentScores, itemType) {
  if (!intentScores) return 0;
  if (itemType === 'job') {
    return Math.min((intentScores.job_seeker_score || 0) / 100, 1.0);
  }
  if (itemType === 'event') {
    return Math.min((intentScores.event_score || 0) / 100, 1.0);
  }
  return 0;
}

/**
 * _computeRecency
 * Same decay formula as rankingCalculator (FROZEN — must not diverge).
 * age < 1h    → 1.0
 * 1–72h       → 1.0 - (age_hours / 72)
 * > 72h       → 0.4 × e^(−age_days × 0.1)
 * floor: 0.05
 *
 * @param {string|Date} createdAt
 * @returns {number} 0.05–1.0
 */
function _computeRecency(createdAt) {
  if (!createdAt) return 0.05;
  const ageMs    = Date.now() - new Date(createdAt).getTime();
  const ageHours = ageMs / (1000 * 60 * 60);
  const ageDays  = ageHours / 24;

  let recency;
  if (ageHours < 1) {
    recency = 1.0;
  } else if (ageHours <= 72) {
    recency = 1.0 - (ageHours / 72);
  } else {
    recency = 0.4 * Math.exp(-ageDays * 0.1);
  }
  return Math.max(recency, 0.05);
}

/**
 * _computeRelevanceScore
 * A6.3 — Three-factor product formula from ranking-features.md (FROZEN):
 *   relevance = location_match × intent_match × recency
 *
 * @param {number} locationMatch  0–1
 * @param {number} intentMatch    0–1
 * @param {number} recency        0–1
 * @returns {number}
 */
function _computeRelevanceScore(locationMatch, intentMatch, recency) {
  return locationMatch * intentMatch * recency;
}

// ---------------------------------------------------------------------------
// A6.1 — Fetch job candidates
// JOIN chain: users → profiles → user_skills → job_skills → jobs
// ---------------------------------------------------------------------------

/**
 * _fetchJobRows
 * Queries active jobs from the last 7 days that share at least one skill
 * with the requesting user. Falls back to all active jobs if no skill match.
 *
 * @param {string} userId
 * @param {object} pool - pg Pool
 * @returns {Promise<Array>}
 */
async function _fetchJobRows(userId, pool) {
  // Primary: skill-matched jobs (strong signal)
  const skillMatchSql = `
    SELECT DISTINCT
      j.job_id        AS content_id,
      'job'           AS type,
      j.recruiter_id  AS author_id,
      j.created_at,
      j.location,
      j.title
    FROM jobs j
    JOIN job_skills js       ON js.job_id   = j.job_id
    JOIN user_skills us      ON us.skill_id  = js.skill_id
    JOIN profiles p          ON p.profile_id = us.profile_id
    WHERE p.user_id           = $1
      AND j.status            = 'ACTIVE'
      AND j.is_active         = TRUE
      AND (j.expires_at IS NULL OR j.expires_at > NOW())
      AND j.created_at        > NOW() - INTERVAL '${RECENCY_WINDOW_DAYS} days'
    ORDER BY j.created_at DESC
    LIMIT 30
  `;

  // Fallback: recent active jobs (no skill requirement)
  const fallbackSql = `
    SELECT
      j.job_id        AS content_id,
      'job'           AS type,
      j.recruiter_id  AS author_id,
      j.created_at,
      j.location,
      j.title
    FROM jobs j
    WHERE j.status    = 'ACTIVE'
      AND j.is_active = TRUE
      AND (j.expires_at IS NULL OR j.expires_at > NOW())
      AND j.created_at > NOW() - INTERVAL '${RECENCY_WINDOW_DAYS} days'
    ORDER BY j.created_at DESC
    LIMIT 20
  `;

  try {
    const { rows } = await pool.query(skillMatchSql, [userId]);
    if (rows.length > 0) return rows;
    // No skill-matched jobs — use fallback
    const fallback = await pool.query(fallbackSql);
    return fallback.rows;
  } catch (err) {
    console.error('[opportunitySource] Job query failed:', err.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// A6.2 — Fetch event candidates
// JOIN: events + user_interests → interests (category match)
// ---------------------------------------------------------------------------

/**
 * _fetchEventRows
 * Queries upcoming events from the last 7 days that match the user's
 * interests (category-based match). Falls back to all upcoming events.
 *
 * @param {string} userId
 * @param {object} pool
 * @returns {Promise<Array>}
 */
async function _fetchEventRows(userId, pool) {
  // Primary: interest-matched events
  const interestMatchSql = `
    SELECT DISTINCT
      e.event_id      AS content_id,
      'event'         AS type,
      e.organizer_id  AS author_id,
      e.created_at,
      e.location,
      e.title,
      e.start_time
    FROM events e
    JOIN interests i         ON LOWER(i.category) = LOWER(e.category)
    JOIN user_interests ui   ON ui.interest_id    = i.interest_id
    WHERE ui.user_id          = $1
      AND e.start_time        > NOW()
      AND e.created_at        > NOW() - INTERVAL '${RECENCY_WINDOW_DAYS} days'
    ORDER BY e.start_time ASC
    LIMIT 20
  `;

  // Fallback: any upcoming events (last 7 days)
  const fallbackSql = `
    SELECT
      e.event_id      AS content_id,
      'event'         AS type,
      e.organizer_id  AS author_id,
      e.created_at,
      e.location,
      e.title,
      e.start_time
    FROM events e
    WHERE e.start_time > NOW()
      AND e.created_at > NOW() - INTERVAL '${RECENCY_WINDOW_DAYS} days'
    ORDER BY e.start_time ASC
    LIMIT 15
  `;

  try {
    const { rows } = await pool.query(interestMatchSql, [userId]);
    if (rows.length > 0) return rows;
    const fallback = await pool.query(fallbackSql);
    return fallback.rows;
  } catch (err) {
    console.error('[opportunitySource] Event query failed:', err.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Fetch user context (location + intent scores) — single call
// ---------------------------------------------------------------------------

/**
 * _fetchUserContext
 * Returns location string and intent scores for relevance computation.
 * Non-fatal: returns safe defaults on failure.
 *
 * @param {string} userId
 * @param {object} pool
 * @returns {Promise<{ location: string|null, intentScores: object }>}
 */
async function _fetchUserContext(userId, pool) {
  const sql = `
    SELECT
      u.location_id,
      COALESCE(u.location, l.name) AS location,
      COALESCE(ui.job_seeker_score, 0) AS job_seeker_score,
      COALESCE(ui.event_score,      0) AS event_score
    FROM users u
    LEFT JOIN locations           l  ON l.id       = u.location_id
    LEFT JOIN user_intent_scores  ui ON ui.user_id  = u.user_id
    WHERE u.user_id = $1
  `;
  try {
    const { rows } = await pool.query(sql, [userId]);
    if (rows.length === 0) return { location: null, intentScores: { job_seeker_score: 0, event_score: 0 } };
    const r = rows[0];
    return {
      location:     r.location || null,
      intentScores: { job_seeker_score: r.job_seeker_score, event_score: r.event_score },
    };
  } catch (err) {
    console.warn('[opportunitySource] User context fetch failed:', err.message);
    return { location: null, intentScores: { job_seeker_score: 0, event_score: 0 } };
  }
}

// ---------------------------------------------------------------------------
// Row → CandidateItem mapper
// ---------------------------------------------------------------------------

/**
 * _mapRowToCandidate
 * Maps a raw DB row to a CandidateItem with is_opportunity: true.
 *
 * @param {object} row
 * @param {string} source - CANDIDATE_SOURCES.OPPORTUNITY_JOB or OPPORTUNITY_EVENT
 * @param {number} relevanceScore - computed relevance (for the raw score field)
 * @returns {object} CandidateItem
 */
function _mapRowToCandidate(row, source, relevanceScore) {
  return createCandidateItem({
    itemId:        uuidv4(),
    itemType:      row.type,
    source,
    contentId:     row.content_id,
    authorId:      row.author_id || null,
    createdAt:     row.created_at instanceof Date
                     ? row.created_at.toISOString()
                     : row.created_at,
    score:         Math.round(relevanceScore * 100000) / 100000,
    relationshipScore: 0,   // no relationship implied for opportunity items
    isOpportunity: true,    // A6.5 — always tagged
    metadata: {
      title:        row.title    || null,
      location:     row.location || null,
      start_time:   row.start_time || null,  // events only
    },
  });
}

// ---------------------------------------------------------------------------
// A6 — Public API: getOpportunityCandidates
// ---------------------------------------------------------------------------

/**
 * getOpportunityCandidates
 *
 * Fetches job and event candidates relevant to the user, scores each by:
 *   relevance = location_match × intent_match × recency
 * Filters items where relevance ≤ 0.6 (A6.4).
 * Tags all returned candidates with isOpportunity: true (A6.5).
 *
 * @param {object}  params
 * @param {string}  params.userId  - Requesting user UUID
 * @param {number}  [params.limit] - Max candidates (capped at OPPORTUNITY_CAP)
 * @param {object}  params.pool    - pg Pool (read-only)
 * @returns {Promise<Array>}       - CandidateItem[], all with isOpportunity: true
 */
async function getOpportunityCandidates({ userId, limit, pool }) {
  try {
    if (!userId) {
      console.warn('[opportunitySource] userId missing — returning []');
      return [];
    }
    if (!pool) {
      console.warn('[opportunitySource] pool not provided — returning []');
      return [];
    }

    // ── 1. Fetch user context + all rows in parallel ──────────────────────────
    const [userCtx, jobRows, eventRows] = await Promise.all([
      _fetchUserContext(userId, pool),
      _fetchJobRows(userId, pool),
      _fetchEventRows(userId, pool),
    ]);

    const { location: userLocation, intentScores } = userCtx;

    // ── 2. Score and filter job rows ──────────────────────────────────────────
    const jobCandidates = jobRows
      .map(row => {
        const locMatch    = _computeLocationMatch(userLocation, row.location);
        const intentMatch = _computeIntentMatch(intentScores, 'job');
        const recency     = _computeRecency(row.created_at);
        const relevance   = _computeRelevanceScore(locMatch, intentMatch, recency);
        return { row, relevance, source: CANDIDATE_SOURCES.OPPORTUNITY_JOB };
      })
      .filter(({ relevance }) => relevance > RELEVANCE_THRESHOLD); // A6.4

    // ── 3. Score and filter event rows ────────────────────────────────────────
    const eventCandidates = eventRows
      .map(row => {
        const locMatch    = _computeLocationMatch(userLocation, row.location);
        const intentMatch = _computeIntentMatch(intentScores, 'event');
        const recency     = _computeRecency(row.created_at);
        const relevance   = _computeRelevanceScore(locMatch, intentMatch, recency);
        return { row, relevance, source: CANDIDATE_SOURCES.OPPORTUNITY_EVENT };
      })
      .filter(({ relevance }) => relevance > RELEVANCE_THRESHOLD); // A6.4

    // ── 4. Merge, sort by relevance DESC ─────────────────────────────────────
    const merged = [...jobCandidates, ...eventCandidates]
      .sort((a, b) => b.relevance - a.relevance);

    // ── 5. Cap and map to CandidateItem ──────────────────────────────────────
    const cap = Math.min(limit || OPPORTUNITY_CAP, OPPORTUNITY_CAP);
    const candidates = merged
      .slice(0, cap)
      .map(({ row, relevance, source }) => _mapRowToCandidate(row, source, relevance));

    return candidates;
  } catch (err) {
    console.error('[opportunitySource] Failed fetching opportunity candidates:', err.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  getOpportunityCandidates,

  // Exported for unit tests
  _computeLocationMatch,
  _computeIntentMatch,
  _computeRecency,
  _computeRelevanceScore,
  _RELEVANCE_THRESHOLD: RELEVANCE_THRESHOLD,
};
