/**
 * CandidateItem.js
 * COCPIT Feed Engine — Candidate Item factory + constants
 *
 * Aligned with: FEED-SPRINT-HQ/contracts/schemas/candidate.schema.json (FROZEN v1.0.0)
 *
 * Day 1 scaffold — no ranking, no scoring formulas, no ML/embeddings.
 * Scoring fields are defined but left at defaults; Day 2+ will populate them.
 */

'use strict';

// ---------------------------------------------------------------------------
// Constants (mirror candidate.schema.json enums)
// ---------------------------------------------------------------------------

/**
 * Valid values for the `source` field.
 * Matches schema enum: source → enum[...]
 */
const CANDIDATE_SOURCES = Object.freeze({
  SOCIAL_GRAPH:        'social_graph',
  TRENDING_GLOBAL:     'trending_global',
  TRENDING_NICHE:      'trending_niche',
  OPPORTUNITY_JOB:     'opportunity_job',
  OPPORTUNITY_EVENT:   'opportunity_event',
  EXPLORATION:         'exploration',
  FOLLOWED_HASHTAG:    'followed_hashtag',
  ORGANIZATION_CONTENT:'organization_content',
});

/**
 * Valid values for the `type` field.
 * Matches schema enum: type → enum[...]
 */
const CANDIDATE_ITEM_TYPES = Object.freeze({
  POST:    'post',
  JOB:     'job',
  EVENT:   'event',
  STARTUP: 'startup',
  PERSON:  'person',
});

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * createCandidateItem
 *
 * Lightweight factory that validates required fields and applies safe defaults.
 * Does NOT compute scores — scoring is a Day 2+ concern.
 *
 * Schema required fields: id (itemId), type (itemType), source, content_id, author_id, created_at
 *
 * @param {object} input
 * @param {string} input.itemId          - Unique candidate instance UUID (maps to schema `id`)
 * @param {string} input.itemType        - Content type (maps to schema `type`)
 * @param {string} input.source          - Which source produced this candidate
 * @param {string} [input.contentId]     - UUID of the actual content entity (maps to schema `content_id`)
 * @param {string} [input.authorId]      - UUID of the content author (maps to schema `author_id`)
 * @param {number} [input.score]         - Raw pre-ranking score (default 0; schema `engagement_score`)
 * @param {number} [input.recencyWeight] - Recency decay multiplier 0–1 (default 0)
 * @param {number} [input.relationshipScore] - User-author relationship strength 0–1 (default 0)
 * @param {boolean}[input.isOpportunity] - True for job/event opportunity-slot items (default false)
 * @param {object} [input.metadata]      - Source-specific extra data (default {})
 * @param {string} [input.createdAt]     - ISO-8601 timestamp; defaults to now
 * @returns {object} Candidate item object
 * @throws {Error} if required fields are missing or invalid
 */
function createCandidateItem(input = {}) {
  const {
    itemId,
    itemType,
    source,
    contentId      = null,
    authorId       = null,
    score          = 0,
    recencyWeight  = 0,
    relationshipScore = 0,
    isOpportunity  = false,
    metadata       = {},
    createdAt      = new Date().toISOString(),
  } = input;

  // --- Required field validation ---
  if (!itemId) {
    throw new Error('CandidateItem: `itemId` is required');
  }
  if (!itemType) {
    throw new Error('CandidateItem: `itemType` is required');
  }
  if (!source) {
    throw new Error('CandidateItem: `source` is required');
  }

  // --- Enum validation (warn, not throw, to keep scaffold non-breaking) ---
  const validTypes   = Object.values(CANDIDATE_ITEM_TYPES);
  const validSources = Object.values(CANDIDATE_SOURCES);

  if (!validTypes.includes(itemType)) {
    console.warn(`CandidateItem: unknown itemType "${itemType}". Expected one of: ${validTypes.join(', ')}`);
  }
  if (!validSources.includes(source)) {
    console.warn(`CandidateItem: unknown source "${source}". Expected one of: ${validSources.join(', ')}`);
  }

  // --- Score sanity (no formula — just clamp to >= 0) ---
  const safeScore = typeof score === 'number' && score >= 0 ? score : 0;

  return Object.freeze({
    // Schema field mapping
    itemId,                          // schema: id
    itemType,                        // schema: type
    source,                          // schema: source
    contentId,                       // schema: content_id
    authorId,                        // schema: author_id
    createdAt,                       // schema: created_at

    // Score fields — defaults only; no ranking logic here
    score: safeScore,                // schema: engagement_score (raw placeholder)
    recencyWeight,                   // schema: recency_weight
    relationshipScore,               // schema: relationship_score
    isOpportunity,                   // schema: is_opportunity

    // Extensible bucket
    metadata: { ...metadata },
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  createCandidateItem,
  CANDIDATE_SOURCES,
  CANDIDATE_ITEM_TYPES,
};
