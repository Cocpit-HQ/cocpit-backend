/**
 * Module: Ranking Calculator
 * Sprint Task: Day 2 — Task A5 (A5.1 – A5.7)
 * Owner: Dev A
 * AI-Assisted: Yes (Antigravity)
 * Contracts read: contracts/ranking-features.md (FROZEN v1.0.0),
 *                 contracts/schemas/ranking-result.schema.json (FROZEN v1.0.0)
 * Last reviewed: 2026-05-24
 *
 * Architecture: Signal Registry pattern.
 * - All signal weights live in SIGNAL_REGISTRY (config).
 * - computeFinalScore is a generic loop — never needs editing when signals are added.
 * - Adding a new signal = add 1 entry to SIGNAL_REGISTRY + 1 compute function.
 * - Frozen weights are respected exactly as specified in ranking-features.md.
 *
 * IMPORTANT: diversity_penalty is ALWAYS 0.0 at this layer.
 * Per ranking-features.md: diversity penalty is applied in the reranking layer
 * (rerankingEngine.js — Task B4, Day 3). It is included in score_breakdown for
 * observability but does not affect final_score here.
 */

'use strict';

// ---------------------------------------------------------------------------
// Version (from ranking-features.md — FROZEN)
// ---------------------------------------------------------------------------

const RANKING_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// Signal Registry
// Weights are FROZEN per ranking-features.md. Any weight change requires CCP.
//
// type: 'positive' → value × weight added to score
// type: 'penalty'  → value × weight subtracted from score
//
// To add a new signal on Day 5+:
//   1. Write a compute function below
//   2. Add one entry here — zero other changes needed
// ---------------------------------------------------------------------------

const SIGNAL_REGISTRY = Object.freeze([
  {
    name:   'recency',
    weight: 0.25,
    type:   'positive',
    fn:     computeRecency,
  },
  {
    name:   'engagement',
    weight: 0.30,
    type:   'positive',
    fn:     computeEngagement,
  },
  {
    name:   'relationship',
    weight: 0.25,
    type:   'positive',
    fn:     computeRelationship,
  },
  {
    name:   'intent_match',
    weight: 0.20,
    type:   'positive',
    fn:     computeIntentMatch,
  },
  {
    name:   'spam_penalty',
    weight: 0.50,
    type:   'penalty',
    fn:     computeSpamPenalty,
  },
  // diversity_penalty: always 0 here — applied in rerankingEngine.js (Day 3)
  {
    name:   'diversity_penalty',
    weight: 0.15,
    type:   'penalty',
    fn:     () => 0,   // No-op at ranking layer — kept for score_breakdown transparency
  },
]);

// ---------------------------------------------------------------------------
// A5.2 — computeRecency(candidate, ctx) → 0–1
// Formula from ranking-features.md (FROZEN):
//   age < 1h   → 1.0
//   1–72h      → 1.0 - (age_hours / 72)
//   > 72h      → 0.4 × e^(-age_days × 0.1)
//   floor:     0.05 (content never reaches 0)
// ---------------------------------------------------------------------------
function computeRecency(candidate, ctx) {
  const createdAt = candidate.createdAt;
  if (!createdAt) return 0.05;

  const now = (ctx && ctx.now) ? ctx.now : Date.now();
  const ageMs    = now - new Date(createdAt).getTime();
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

  // Floor at 0.05 — content never drops to zero
  return Math.max(recency, 0.05);
}

// ---------------------------------------------------------------------------
// A5.3 — computeEngagement(candidate, ctx) → 0–1 (normalized)
// Formula from ranking-features.md (FROZEN):
//   raw  = (likes × 0.6) + (comments × 1.2) + (shares × 1.5) + (clicks × 1.0)
//   norm = raw / max(maxEngagement, 1)
//
// candidate.score holds the raw_engagement computed at generation time.
// ctx.maxEngagement is the max raw_engagement across the full candidate pool.
// ---------------------------------------------------------------------------
function computeEngagement(candidate, ctx) {
  const raw = candidate.score || 0;
  const max = (ctx && ctx.maxEngagement > 0) ? ctx.maxEngagement : 1;
  return Math.min(raw / max, 1.0);
}

// ---------------------------------------------------------------------------
// computeRelationship(candidate, ctx) → 0–1
// Value is set at generation time by the social graph source.
// Relationship scores (from ranking-features.md — FROZEN):
//   0.0  No connection
//   0.25 2nd-degree
//   0.50 1st-degree follower
//   0.75 Mutual follow
//   1.0  Close collaborator
// ---------------------------------------------------------------------------
function computeRelationship(candidate /*, ctx */) {
  const rs = candidate.relationshipScore;
  if (typeof rs !== 'number' || isNaN(rs)) return 0;
  return Math.min(Math.max(rs, 0), 1); // clamp 0–1
}

// ---------------------------------------------------------------------------
// A5.4 — computeIntentMatch(candidate, ctx) → 0–1
// Maps user intent scores (from user_intent_scores table) to content type.
// Intent scores are raw integers — normalized to 0–1 by dividing by 100.
//
// Mapping:
//   type = 'job'   → job_seeker_score / 100
//   type = 'event' → event_score / 100
//   type = 'post'  → creator_score / 100
//   other          → 0.0
// ---------------------------------------------------------------------------
function computeIntentMatch(candidate, ctx) {
  if (!ctx || !ctx.intentScores) return 0;

  const { job_seeker_score = 0, creator_score = 0, event_score = 0 } = ctx.intentScores;
  const type = candidate.itemType;

  let rawScore = 0;

  if (type === 'job') {
    rawScore = job_seeker_score;
  } else if (type === 'event') {
    rawScore = event_score;
  } else if (type === 'post') {
    rawScore = creator_score;
  }

  // Normalize: raw scores are integers (0–∞ in DB), cap at 1.0
  return Math.min(rawScore / 100, 1.0);
}

// ---------------------------------------------------------------------------
// computeSpamPenalty(candidate, ctx) → 0 or 1
// From ranking-features.md (FROZEN):
//   spam if: shares > 10 × likes AND comments < 5
// Returns 1.0 (full penalty) or 0.0 (clean)
//
// Note: author spam_flag and report_count checks require extra DB queries.
// Those are deferred to Day 5 production hardening (Task A11).
// For now: engagement-bait heuristic only.
// ---------------------------------------------------------------------------
function computeSpamPenalty(candidate /*, ctx */) {
  const meta     = candidate.metadata || {};
  const likes    = meta.like_count    || 0;
  const comments = meta.comment_count || 0;
  const shares   = meta.share_count   || 0;

  // 1. Engagement bait: suspiciously high shares vs likes, very low comments
  if (shares > (10 * likes) && comments < 5) {
    return 1.0;
  }

  // 2. Author has spam_flag = true in DB (coalesced inside metadata or candidate object)
  if (candidate.spam_flag === true || meta.spam_flag === true) {
    return 1.0;
  }

  // 3. Content was reported > 3 times in the last 24h
  if (meta.report_count > 3) {
    return 1.0;
  }

  // 4. Content has is_hidden = true
  if (candidate.is_hidden === true || meta.is_hidden === true) {
    return 1.0;
  }

  return 0.0;
}

// ---------------------------------------------------------------------------
// A5.5 — computeFinalScore(candidate, ctx) → { score, breakdown }
// The formula engine — loops SIGNAL_REGISTRY. Never needs editing for new signals.
// ---------------------------------------------------------------------------
function computeFinalScore(candidate, ctx) {
  let score = 0;
  const breakdown = {};

  for (const signal of SIGNAL_REGISTRY) {
    const value = signal.fn(candidate, ctx);
    breakdown[signal.name] = Math.round(value * 10000) / 10000; // 4dp precision

    if (signal.type === 'positive') {
      score += value * signal.weight;
    } else if (signal.type === 'penalty') {
      score -= value * signal.weight;
    }
  }

  return {
    score: Math.max(0, score), // floor at 0 — score never goes negative
    breakdown,
  };
}

// ---------------------------------------------------------------------------
// A5.6 — rankCandidates(candidates, userId, pool) → ScoredCandidate[]
// Full ranking pipeline:
//   1. Fetch user intent scores (1 DB query)
//   2. Compute maxEngagement across pool
//   3. Build ctx (shared context, computed once per run)
//   4. Score each candidate via computeFinalScore
//   5. Sort descending by final_score
//   6. Attach ranking_version + ranked_at (A5.7)
// ---------------------------------------------------------------------------

/**
 * rankCandidates
 *
 * @param {Array}  candidates - CandidateItem[] from candidateGenerator
 * @param {string} userId     - UUID of the requesting user
 * @param {object} pool       - pg Pool for intent score query
 * @returns {Promise<Array>}  - ScoredCandidate[] sorted by final_score DESC
 */
async function rankCandidates(candidates, userId, pool) {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];

  // ── Step 1: Fetch user intent scores (1 DB query) ────────────────────────
  let intentScores = { job_seeker_score: 0, creator_score: 0, event_score: 0 };

  if (pool && userId) {
    try {
      const result = await pool.query(
        `SELECT job_seeker_score, creator_score, event_score
         FROM   user_intent_scores
         WHERE  user_id = $1`,
        [userId]
      );
      if (result.rows.length > 0) {
        intentScores = result.rows[0];
      }
    } catch (err) {
      // Non-fatal — intent scores default to 0, ranking continues
      console.warn('[rankingCalculator] Could not fetch intent scores:', err.message);
    }
  }

  // ── Step 2: Compute maxEngagement across pool (for normalization) ─────────
  const maxEngagement = candidates.reduce(
    (max, c) => Math.max(max, c.score || 0),
    0
  );

  // ── Step 3: Build shared context (computed once) ──────────────────────────
  const ranked_at = new Date().toISOString();
  const nowMs = new Date(ranked_at).getTime();

  const ctx = {
    userId,
    intentScores,
    maxEngagement,
    now: nowMs,
  };

  // ── Step 4: Score every candidate ────────────────────────────────────────

  const scored = candidates.map(candidate => {
    const { score, breakdown } = computeFinalScore(candidate, ctx);

    // Shape matches ranking-result.schema.json (FROZEN)
    return {
      item_id:         candidate.contentId,
      candidate_id:    candidate.itemId,
      final_score:     Math.round(score * 100000) / 100000, // 5dp
      score_breakdown: breakdown,
      slot_type:       candidate.isOpportunity ? 'opportunity' : 'organic',
      ranked_at,
      ranking_version: RANKING_VERSION,   // A5.7 — attached to every result
      position:        null,              // assigned by rerankingEngine.js (Day 3)
      // Keep the original candidate attached for downstream consumers
      _candidate:      candidate,
    };
  });

  // ── Step 5: Sort descending by final_score ────────────────────────────────
  scored.sort((a, b) => b.final_score - a.final_score);

  return scored;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  rankCandidates,
  computeFinalScore,

  // Individual signal functions — exported for unit tests
  computeRecency,
  computeEngagement,
  computeRelationship,
  computeIntentMatch,
  computeSpamPenalty,

  // Constants — exported for tests and integration verification
  RANKING_VERSION,
  _SIGNAL_REGISTRY: SIGNAL_REGISTRY,
};
