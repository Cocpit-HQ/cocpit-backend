/**
 * rerankingEngine.js
 * COCPIT Feed Engine — Reranking / Diversity Layer
 *
 * Sprint Task: Day 2 — Task B4 (B4.1 – B4.5) [scaffold]
 *              Day 3 — Task B6 (B6.1 – B6.5) [completion]
 * Owner: Dev B
 * AI-Assisted: Yes (Antigravity)
 * Contracts read: contracts/ranking-features.md (FROZEN v1.0.0),
 *                 contracts/schemas/ranking-result.schema.json (FROZEN v1.0.0)
 * Last reviewed: 2026-05-26
 *
 * Full reranking pipeline (ordered):
 *   1. Seen-set filter       — remove items the user has already seen (Redis)
 *   2. Diversity penalty     — penalise same-author (2nd+) and same-type (4th+)
 *   3. Re-sort               — by updated final_score DESC
 *   4. Anti-spam hard limits — max 2 same author, max 3 same type, bait removal (B6.1)
 *   5. Slot injection        — exploration at [3,10,17], opportunity at [6,13,19] (B6.2/B6.3)
 *   6. Respect exploration_enabled flag from session (B6.4)
 *   7. Return FeedItem[] with exactly 20 items assigned positions (B6.5)
 *
 * IMPORTANT: diversity_penalty (soft score reduction) is Day 2.
 *            Anti-spam hard limits (hard drops) are Day 3 — applied AFTER re-sort.
 *            Do NOT re-implement spam detection from rankingCalculator.
 *            Do NOT add new signal weights.
 *            Do NOT access the DB directly — only Redis (via feedCache).
 */

'use strict';

const { getSeenSet } = require('../cache/feedCache');

// ---------------------------------------------------------------------------
// Constants (from ranking-features.md — FROZEN)
// ---------------------------------------------------------------------------

const DIVERSITY_WEIGHT = 0.15;   // Wd

const AUTHOR_PENALTY_THRESHOLDS = [
  { minCount: 2, penalty: 0.5 },  // 2nd appearance: subtract 0.5 × Wd
];

const CONTENT_TYPE_PENALTY_THRESHOLDS = [
  { minCount: 4, penalty: 1.0 },  // 4th same type: subtract 1.0 × Wd
];

// Anti-spam hard limits (from ARCHITECTURE_FROZEN.md)
const ANTI_SPAM_MAX_AUTHOR_PER_PAGE = 2;   // B6.1 — hard drop after 2nd
const ANTI_SPAM_MAX_TYPE_PER_PAGE   = 3;   // B6.1 — hard drop after 3rd

// Slot positions (from ranking-features.md — FROZEN, 0-indexed)
const EXPLORATION_SLOT_POSITIONS  = [3, 10, 17];  // B6.3
const OPPORTUNITY_SLOT_POSITIONS  = [6, 13, 19];  // B6.2

const FEED_PAGE_SIZE = 20;  // B6.5 — exactly 20 items per page

// ---------------------------------------------------------------------------
// Day 2 helpers (preserved unchanged)
// ---------------------------------------------------------------------------

function getAuthorPenalty(appearanceCount) {
  for (const threshold of AUTHOR_PENALTY_THRESHOLDS) {
    if (appearanceCount >= threshold.minCount) return threshold.penalty;
  }
  return 0;
}

function getContentTypePenalty(typeCount) {
  for (const threshold of CONTENT_TYPE_PENALTY_THRESHOLDS) {
    if (typeCount >= threshold.minCount) return threshold.penalty;
  }
  return 0;
}

function applyDiversityPenalties(rankedCandidates) {
  const authorCounts      = new Map();
  const contentTypeCounts = new Map();

  return rankedCandidates.map(item => {
    const authorId = item._candidate?.authorId  ?? null;
    const itemType = item._candidate?.itemType   ?? 'unknown';

    const authorCount = authorCounts.get(authorId) ?? 0;
    const typeCount   = contentTypeCounts.get(itemType) ?? 0;

    const authorPenaltyValue = getAuthorPenalty(authorCount + 1);
    const typePenaltyValue   = getContentTypePenalty(typeCount + 1);
    const diversityPenalty   = Math.max(authorPenaltyValue, typePenaltyValue);
    const penaltyDeduction   = diversityPenalty * DIVERSITY_WEIGHT;

    if (authorId) authorCounts.set(authorId, authorCount + 1);
    contentTypeCounts.set(itemType, typeCount + 1);

    if (penaltyDeduction === 0) return item;

    const adjustedScore = Math.max(0, item.final_score - penaltyDeduction);
    return {
      ...item,
      final_score: Math.round(adjustedScore * 100000) / 100000,
      score_breakdown: {
        ...item.score_breakdown,
        diversity_penalty: Math.round(diversityPenalty * 10000) / 10000,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// B6.1 — Anti-spam hard limits (NEW Day 3)
// Applied AFTER diversity penalty re-sort — these are hard drops, not scores.
// ---------------------------------------------------------------------------

/**
 * _isEngagementBait
 * Mirrors the bait heuristic in rankingCalculator.computeSpamPenalty.
 * Returns true if shares > 10×likes AND comments < 5.
 *
 * @param {object} item - ScoredCandidate
 * @returns {boolean}
 */
function _isEngagementBait(item) {
  const meta     = item._candidate?.metadata || {};
  const likes    = meta.like_count    || 0;
  const comments = meta.comment_count || 0;
  const shares   = meta.share_count   || 0;
  return shares > (10 * likes) && comments < 5;
}

/**
 * _applyAntiSpam
 * Enforces hard limits per ARCHITECTURE_FROZEN.md:
 *   - Max 2 items from the same author per page
 *   - Max 3 items of the same content type per page
 *   - Remove engagement bait items
 *   - Remove items that already have spam_penalty = 1.0 in score_breakdown
 *
 * Items are dropped (not reordered) when limits are exceeded.
 *
 * @param {Array} items - ScoredCandidate[] sorted by final_score DESC
 * @returns {Array}     - Filtered ScoredCandidate[]
 */
function _applyAntiSpam(items) {
  const authorCounts = new Map();
  const typeCounts   = new Map();
  const result       = [];

  for (const item of items) {
    const authorId = item._candidate?.authorId ?? '__unknown__';
    const itemType = item._candidate?.itemType ?? 'unknown';

    // Drop engagement bait
    if (_isEngagementBait(item)) continue;

    // Drop items the ranker already flagged as spam (spam_penalty = 1.0)
    if (item.score_breakdown?.spam_penalty === 1.0) continue;

    // Hard author cap
    const authorCount = authorCounts.get(authorId) ?? 0;
    if (authorCount >= ANTI_SPAM_MAX_AUTHOR_PER_PAGE) continue;

    // Hard content-type cap
    const typeCount = typeCounts.get(itemType) ?? 0;
    if (typeCount >= ANTI_SPAM_MAX_TYPE_PER_PAGE) continue;

    // Item passes all checks
    authorCounts.set(authorId, authorCount + 1);
    typeCounts.set(itemType, typeCount + 1);
    result.push(item);
  }

  return result;
}

// ---------------------------------------------------------------------------
// B6.2 / B6.3 — Slot injection (NEW Day 3)
// ---------------------------------------------------------------------------

/**
 * _buildFeedItem
 * Converts a ScoredCandidate to the FeedItem shape expected by the API.
 *
 * @param {object} scoredItem
 * @param {number} position     - 0-indexed position in the final page
 * @param {string} slotType     - 'organic' | 'exploration' | 'opportunity'
 * @returns {object}
 */
function _buildFeedItem(scoredItem, position, slotType) {
  return {
    id:              scoredItem.item_id,
    type:            scoredItem._candidate?.itemType ?? 'post',
    content:         scoredItem._candidate?.metadata ?? {},
    author:          { id: scoredItem._candidate?.authorId ?? null },
    score:           scoredItem.final_score,
    slot_type:       slotType,
    ranked_at:       scoredItem.ranked_at,
    ranking_version: scoredItem.ranking_version,
    position,
    // Internal scoring data (stripped at controller before sending to client)
    _score_breakdown: scoredItem.score_breakdown,
    _candidate_id:    scoredItem.candidate_id,
  };
}

/**
 * _candidateToFeedItem
 * Converts a raw CandidateItem (from explorationPool / opportunitySource)
 * to a minimal FeedItem for slot injection. Score is the candidate's raw score.
 *
 * @param {object} candidate - CandidateItem
 * @param {number} position
 * @param {string} slotType
 * @returns {object}
 */
function _candidateToFeedItem(candidate, position, slotType) {
  return {
    id:              candidate.contentId,
    type:            candidate.itemType,
    content:         candidate.metadata ?? {},
    author:          { id: candidate.authorId ?? null },
    score:           candidate.score ?? 0,
    slot_type:       slotType,
    ranked_at:       new Date().toISOString(),
    ranking_version: '1.0.0',
    position,
    _score_breakdown: {},
    _candidate_id:    candidate.itemId,
  };
}

/**
 * _buildSlottedPage
 *
 * Assembles a 20-item feed page by:
 *   1. Starting with `organicItems` (post-anti-spam, scored list)
 *   2. Injecting exploration candidates at [3, 10, 17] (if enabled)
 *   3. Injecting opportunity candidates at [6, 13, 19]
 *   4. Filling remaining positions with organic items in order
 *   5. Assigning 0-indexed final positions
 *
 * Slot conflict rule: opportunity > exploration > organic
 * If fewer than FEED_PAGE_SIZE items are available, compacts nulls.
 *
 * @param {Array}   organicItems         - ScoredCandidate[] (anti-spam applied)
 * @param {Array}   opportunityCandidates - CandidateItem[] from opportunitySource
 * @param {Array}   explorationCandidates - CandidateItem[] from explorationPool
 * @param {boolean} explorationEnabled   - from session.exploration_enabled
 * @returns {Array} FeedItem[] with 0-indexed positions, max FEED_PAGE_SIZE items
 */
function _buildSlottedPage(organicItems, opportunityCandidates, explorationCandidates, explorationEnabled) {
  // Initialise page as array of nulls
  const page = new Array(FEED_PAGE_SIZE).fill(null);

  // ── Step 1: Reserve exploration slots ─────────────────────────────────────
  const exploreQueue = [...explorationCandidates];
  if (explorationEnabled) {
    for (const pos of EXPLORATION_SLOT_POSITIONS) {
      if (pos < FEED_PAGE_SIZE && exploreQueue.length > 0) {
        const candidate = exploreQueue.shift();
        page[pos] = { type: 'exploration', candidate };
      }
    }
  }

  // ── Step 2: Reserve opportunity slots (override exploration if conflict) ───
  const oppQueue = [...opportunityCandidates];
  for (const pos of OPPORTUNITY_SLOT_POSITIONS) {
    if (pos < FEED_PAGE_SIZE && oppQueue.length > 0) {
      const candidate = oppQueue.shift();
      page[pos] = { type: 'opportunity', candidate };
    }
  }

  // ── Step 3: Fill remaining nulls with organic items ───────────────────────
  const organicQueue = [...organicItems];
  for (let i = 0; i < FEED_PAGE_SIZE; i++) {
    if (page[i] === null && organicQueue.length > 0) {
      page[i] = { type: 'organic', item: organicQueue.shift() };
    }
  }

  // ── Step 4: Build final FeedItem[] (compact nulls, assign positions) ───────
  const feedItems = [];
  let position = 0;

  for (const slot of page) {
    if (slot === null) continue; // sparse page — skip

    if (slot.type === 'exploration') {
      feedItems.push(_candidateToFeedItem(slot.candidate, position, 'exploration'));
    } else if (slot.type === 'opportunity') {
      feedItems.push(_candidateToFeedItem(slot.candidate, position, 'opportunity'));
    } else {
      feedItems.push(_buildFeedItem(slot.item, position, 'organic'));
    }
    position++;
  }

  return feedItems;
}

// ---------------------------------------------------------------------------
// Main export — rerankCandidates
// ---------------------------------------------------------------------------

/**
 * rerankCandidates
 *
 * Full reranking pipeline. New Day 3 params use safe defaults to maintain
 * backward compatibility with all Day 2 unit tests.
 *
 * @param {Array}   rankedCandidates       - ScoredCandidate[] from rankingCalculator
 * @param {string}  userId                 - UUID of the requesting user
 * @param {object}  [session={}]           - Feed session (reads exploration_enabled)
 * @param {Array}   [opportunityCandidates=[]] - CandidateItem[] from opportunitySource (A6)
 * @param {Array}   [explorationCandidates=[]] - CandidateItem[] from explorationPool (A7)
 * @returns {Promise<Array>}               - FeedItem[] with positions assigned, ≤ 20 items
 */
async function rerankCandidates(
  rankedCandidates,
  userId,
  session               = {},
  opportunityCandidates = [],
  explorationCandidates = [],
) {
  if (!Array.isArray(rankedCandidates) || rankedCandidates.length === 0) {
    return [];
  }
  if (!userId) {
    throw new Error('rerankCandidates: `userId` is required');
  }

  // ── 1. Seen-set filter ────────────────────────────────────────────────────
  let seenIds = new Set();
  try {
    const seenArr = await getSeenSet(userId);
    seenIds = new Set(seenArr);
  } catch (err) {
    console.warn('[rerankingEngine] Could not fetch seen set, skipping filter:', err.message);
  }

  const unseen = seenIds.size > 0
    ? rankedCandidates.filter(item => !seenIds.has(item.item_id))
    : rankedCandidates;

  // ── 2. Diversity penalties (soft score reduction — Day 2) ─────────────────
  const penalised = applyDiversityPenalties(unseen);

  // ── 3. Re-sort by updated final_score DESC ────────────────────────────────
  const resorted = penalised.slice().sort((a, b) => b.final_score - a.final_score);

  // ── 4. Anti-spam hard limits (Day 3 — B6.1) ──────────────────────────────
  const antiSpammed = _applyAntiSpam(resorted);

  // ── 5. Read exploration_enabled flag from session (B6.4) ─────────────────
  // feedSession.service.js stores this as boolean after _formatSession().
  const explorationEnabled = !session || session.exploration_enabled !== false; // default: true

  // ── 6. Build slotted 20-item page (B6.2 + B6.3) ──────────────────────────
  const feedItems = _buildSlottedPage(
    antiSpammed,
    Array.isArray(opportunityCandidates) ? opportunityCandidates : [],
    Array.isArray(explorationCandidates) ? explorationCandidates : [],
    explorationEnabled,
  );

  return feedItems;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  rerankCandidates,

  // Individual helpers — exported for unit tests
  applyDiversityPenalties,
  getAuthorPenalty,
  getContentTypePenalty,

  // Day 3 helpers — exported for unit tests
  _applyAntiSpam,
  _isEngagementBait,
  _buildSlottedPage,

  // Constants — exported for integration verification
  _DIVERSITY_WEIGHT:                DIVERSITY_WEIGHT,
  _AUTHOR_PENALTY_THRESHOLDS:       AUTHOR_PENALTY_THRESHOLDS,
  _CONTENT_TYPE_PENALTY_THRESHOLDS: CONTENT_TYPE_PENALTY_THRESHOLDS,
  _EXPLORATION_SLOT_POSITIONS:      EXPLORATION_SLOT_POSITIONS,
  _OPPORTUNITY_SLOT_POSITIONS:      OPPORTUNITY_SLOT_POSITIONS,
  _ANTI_SPAM_MAX_AUTHOR_PER_PAGE:   ANTI_SPAM_MAX_AUTHOR_PER_PAGE,
  _ANTI_SPAM_MAX_TYPE_PER_PAGE:     ANTI_SPAM_MAX_TYPE_PER_PAGE,
  _FEED_PAGE_SIZE:                  FEED_PAGE_SIZE,
};
