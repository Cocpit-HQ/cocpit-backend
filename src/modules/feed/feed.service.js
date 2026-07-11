/**
 * feed.service.js
 * COCPIT Feed Engine — Feed Slice Assembly Service
 *
 * Sprint Task: Day 3 — Task B7 (B7.1 – B7.5)
 * Owner: Dev B
 * AI-Assisted: Yes (Antigravity)
 * Contracts read: contracts/api-contracts.md (FROZEN),
 *                 contracts/redis-key-registry.md (FROZEN)
 * Last reviewed: 2026-05-26
 *
 * Orchestrates the full feed generation pipeline:
 *   [1] Redis cache check (feed:slice:{userId}:{cursor})
 *   [2] Session read (exploration_enabled flag)
 *   [3] Candidate generation (all 4 sources via candidateGenerator)
 *   [4] Ranking (rankingCalculator)
 *   [5] Exploration pool fetch (explorationPool — parallel with ranking)
 *   [6] Reranking + slot injection (rerankingEngine)
 *   [7] Cache write (TTL 300s)
 *   [8] Session cursor update + seen-set update
 *   [9] Return FeedResponse
 *
 * Redis keys used (from redis-key-registry.md — FROZEN):
 *   feed:slice:{userId}:{cursor}  → String JSON, TTL 300s
 *   feed:seen:{userId}            → Set, TTL 86400s
 */

'use strict';

const { v4: uuidv4 } = require('uuid');

const { generateCandidates }      = require('./candidates/candidateGenerator');
const { rankCandidates }          = require('./ranking/rankingCalculator');
const { rerankCandidates }        = require('./reranking/rerankingEngine');
const { getExplorationCandidates } = require('./exploration/explorationPool');
const {
  getFeedSlice,
  setFeedSlice,
  addToSeenSet,
} = require('./cache/feedCache');
const { getSession, updateCursor, incrementSeenCount, createSession } = require('./session/feedSession.service');
const { getPostHydrationSelect, getPostHydrationJoins, getPublicFeedWhere } = require('../../core/queries/postHydration.query');
const feedAnalytics = require('./analytics/feedAnalytics.service');
const { incrementUserHashtagScore } = require('../../services/recommendation.service');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_PAGE_SIZE = 20;    // B7 — fixed page size
const FEED_SLICE_TTL    = 300;   // 5 minutes — per redis-key-registry.md
const EXPLORATION_SLOTS = 3;     // slots requested from exploration pool

// ---------------------------------------------------------------------------
// ID-160/D1 — Actor-scoped cache/session identifier
// ---------------------------------------------------------------------------

/**
 * buildCacheScopeId
 *
 * Builds the identifier used for feed SLICE cache, SESSION state, and the
 * SEEN-SET — i.e. everything that must not be shared between a human's
 * personal feed and a company/organization they're acting as. Candidate
 * generation and ranking intentionally keep using the real `userId` (they
 * key off the human's own social graph / intent signals in the DB; that's
 * unrelated to which cache entry serves the response — see ID-160
 * implementation plan, "D1 minimal" scope).
 *
 * Falls back to the bare userId — today's exact behavior and key shape —
 * whenever no organization actor is present, which is always true for
 * callers that never send x-actor-type/x-actor-id (e.g. mobile clients
 * today), so their cache keys are byte-for-byte unchanged.
 *
 * @param {string} userId
 * @param {string} [orgActorId]
 * @returns {string}
 */
function buildCacheScopeId(userId, orgActorId) {
  return orgActorId ? `${userId}:org:${orgActorId}` : userId;
}

// ---------------------------------------------------------------------------
// ID-160/D1 — Actor-scoped cache/session identifier
// ---------------------------------------------------------------------------

/**
 * buildCacheScopeId
 *
 * Builds the identifier used for feed SLICE cache, SESSION state, and the
 * SEEN-SET — i.e. everything that must not be shared between a human's
 * personal feed and a company/organization they're acting as. Candidate
 * generation and ranking intentionally keep using the real `userId` (they
 * key off the human's own social graph / intent signals in the DB; that's
 * unrelated to which cache entry serves the response — see ID-160
 * implementation plan, "D1 minimal" scope).
 *
 * Falls back to the bare userId — today's exact behavior and key shape —
 * whenever no organization actor is present, which is always true for
 * callers that never send x-actor-type/x-actor-id (e.g. mobile clients
 * today), so their cache keys are byte-for-byte unchanged.
 *
 * @param {string} userId
 * @param {string} [orgActorId]
 * @returns {string}
 */
function buildCacheScopeId(userId, orgActorId) {
  return orgActorId ? `${userId}:org:${orgActorId}` : userId;
}

// ---------------------------------------------------------------------------
// Internal: run the full generation → ranking → reranking pipeline
// ---------------------------------------------------------------------------

/**
 * _runPipeline
 *
 * Executes candidateGenerator → rankingCalculator → explorationPool
 * (ranking + explore fetch run in parallel) → rerankingEngine.
 *
 * @param {object} params
 * @param {string} params.userId        - Requesting user UUID (real identity — used for DB-backed personalization)
 * @param {string} params.scopeId       - Cache-scope id (see buildCacheScopeId) — used for the seen-set only
 * @param {number} params.limit         - Page size (default 20)
 * @param {object} params.pool          - pg Pool instance
 * @param {object} params.session       - FeedSession (from feedSession.service)
 * @param {boolean} params.isInitialPage - ID-160 follow-up: true when this is a fresh page
 *   load (no cursor), so rerankCandidates skips the seen-set filter — see its own doc comment.
 * @returns {Promise<Array>}       - FeedItem[] from rerankingEngine
 */
async function _runPipeline({ userId, scopeId, limit, pool, session, isInitialPage }) {
  // ── Step 1: Generate candidates (all 4 sources) ───────────────────────────
  const candidates = await generateCandidates({ userId, pool });
  const totalCandidates = candidates.length;

  // ── Step 2: Rank + fetch exploration pool (parallel) ─────────────────────
  const [rankedCandidates, explorationCandidates] = await Promise.all([
    rankCandidates(candidates, userId, pool),
    getExplorationCandidates(scopeId, EXPLORATION_SLOTS),
    getExplorationCandidates(scopeId, EXPLORATION_SLOTS),
  ]);

  // ── Step 3: Extract opportunity candidates from ranked list ───────────────
  // Opportunity candidates are already scored; extract them to pass separately
  // to the reranker so it can inject them at correct slot positions [6,13,19].
  const opportunityCandidates = rankedCandidates
    .filter(item => item._candidate?.isOpportunity === true)
    .map(item => item._candidate);  // pass raw CandidateItem to slot injector

  // ── Step 4: Rerank + slot injection ──────────────────────────────────────
  // scopeId (not userId) so the seen-set dedup matches whichever actor is
  // actually viewing — see buildCacheScopeId. isInitialPage disables the
  // seen-set filter for a fresh page load — see rerankCandidates doc comment.
  const feedItems = await rerankCandidates(
    rankedCandidates,
    scopeId,
    scopeId,
    session,
    opportunityCandidates,
    explorationCandidates,
    isInitialPage,
  );

  return { feedItems, totalCandidates };
}

// ---------------------------------------------------------------------------
// Internal: hydrate post data from DB
// ---------------------------------------------------------------------------

async function _hydrateFeedItems(items, userId, pool, orgActorId = null) {
async function _hydrateFeedItems(items, userId, pool, orgActorId = null) {
  if (!items || items.length === 0) return items;
  if (!pool) return items; // Can't hydrate without DB pool

  const postIds = items.map(i => i.id).filter(Boolean);
  if (postIds.length === 0) return items;

  try {
    const query = `
      SELECT ${getPostHydrationSelect(2, 1)}
      ${getPostHydrationJoins()}
      ${getPublicFeedWhere(1)}
      AND p.post_id = ANY($3::uuid[])
    `;
    // param 1: user (always real identity — blocks/membership checks etc.)
    // param 2: company — ID-160/D1: pass the acting org so is_liked/is_saved/
    //   is_commented/broadcast-visibility reflect the company's own state
    //   instead of always falling back to the human's personal state.
    const params = [userId, orgActorId, postIds];
    // param 1: user (always real identity — blocks/membership checks etc.)
    // param 2: company — ID-160/D1: pass the acting org so is_liked/is_saved/
    //   is_commented/broadcast-visibility reflect the company's own state
    //   instead of always falling back to the human's personal state.
    const params = [userId, orgActorId, postIds];

    const { rows } = await pool.query(query, params);
    
    const rowMap = new Map();
    for (const row of rows) {
      rowMap.set(row.post_id, row);
    }

    return items.map(item => ({
      ...item,
      post_data: rowMap.get(item.id) || null
    }));
  } catch (err) {
    console.error('[feedService] Hydration failed:', err.message);
    return items;
  }
}

// ---------------------------------------------------------------------------
// Internal: build the API response shape
// ---------------------------------------------------------------------------

/**
 * _buildResponse
 *
 * Shapes a feed response matching api-contracts.md (FROZEN).
 *
 * @param {Array}   items      - FeedItem[]
 * @param {object}  session    - FeedSession
 * @param {boolean} cacheHit   - Whether this was served from cache
 * @param {string}  nextCursor - The cursor for the next page
 * @param {number}  totalCandidates - How many raw candidates were generated
 * @returns {object}
 */
function _buildResponse(items, session, cacheHit, nextCursor, totalCandidates = 0) {
  const explorationSlots = items.filter(i => i.slot_type === 'exploration').length;

  return {
    ok: true,
    data: {
      items:      items.map(item => ({
        id:              item.id,
        type:            item.type,
        content:         item.content,
        author:          item.author,
        score:           item.score,
        slot_type:       item.slot_type,
        ranked_at:       item.ranked_at,
        ranking_version: item.ranking_version,
        position:        item.position,
        post_data:       item.post_data,
      })),
      cursor:     nextCursor,
      has_more:   true,  // exhaustion detection is Day 5
      session_id: session?.session_id ?? null,
      served_at:  new Date().toISOString(),
    },
    meta: {
      total_candidates:   totalCandidates,
      cache_hit:          cacheHit,
      exploration_slots:  explorationSlots,
      ranking_version:    '1.0.0',
    },
  };
}

// ---------------------------------------------------------------------------
// B7 — Public API: getFeed
// ---------------------------------------------------------------------------

/**
 * getFeed
 *
 * Cache-first feed slice assembly. On a Redis hit the full pipeline is skipped.
 * On a miss the pipeline runs, results are cached (TTL 300s), and the session
 * cursor + seen set are updated.
 *
 * @param {object}  params
 * @param {string}  params.userId     - Requesting user UUID (required)
 * @param {string}  [params.cursor]   - Pagination cursor from previous response
 * @param {number}  [params.limit]    - Items per page (default: 20, max: 50)
 * @param {object}  [params.pool]     - pg Pool instance (required for live generation)
 * @param {string}  [params.context]  - Feed context: home | explore | startup
 * @param {string}  [params.orgActorId] - ID-160/D1: organization id when the request is
 *   scoped to a company/organization actor (from req.actor, set only when the caller sends
 *   x-actor-type/x-actor-id — mobile clients never send these, so this is undefined for them
 *   and behavior is unchanged). Used to keep cache/session/seen-state and like/save/comment
 *   hydration separate from the same human's personal feed.
 * @param {string}  params.userId     - Requesting user UUID (required)
 * @param {string}  [params.cursor]   - Pagination cursor from previous response
 * @param {number}  [params.limit]    - Items per page (default: 20, max: 50)
 * @param {object}  [params.pool]     - pg Pool instance (required for live generation)
 * @param {string}  [params.context]  - Feed context: home | explore | startup
 * @param {string}  [params.orgActorId] - ID-160/D1: organization id when the request is
 *   scoped to a company/organization actor (from req.actor, set only when the caller sends
 *   x-actor-type/x-actor-id — mobile clients never send these, so this is undefined for them
 *   and behavior is unchanged). Used to keep cache/session/seen-state and like/save/comment
 *   hydration separate from the same human's personal feed.
 * @returns {Promise<object>}       - FeedResponse matching api-contracts.md
 */
async function getFeed({ userId, cursor = null, limit = DEFAULT_PAGE_SIZE, pool = null, context = 'home', orgActorId = null } = {}) {
async function getFeed({ userId, cursor = null, limit = DEFAULT_PAGE_SIZE, pool = null, context = 'home', orgActorId = null } = {}) {
  if (!userId) throw new Error('feedService.getFeed: `userId` is required');

  const pageSize   = Math.min(limit, 50);  // enforce max from api-contracts.md
  const effectiveCursor = cursor || 'initial';
  const scopeId = buildCacheScopeId(userId, orgActorId);
  // ID-160 follow-up: true only for a genuinely fresh page load (no cursor
  // supplied) — see rerankCandidates' isInitialPage doc comment.
  const isInitialPage = !cursor;

  // ── B7.2: Check Redis cache first ─────────────────────────────────────────
  let cachedSlice = null;
  try {
    cachedSlice = await getFeedSlice(scopeId, effectiveCursor);
    cachedSlice = await getFeedSlice(scopeId, effectiveCursor);
  } catch (cacheErr) {
    console.warn('[feedService] Cache read failed, falling through to pipeline:', cacheErr.message);
  }

  // ── Get or create session ─────────────────────────────────────────────────
  let session = null;
  try {
    session = await getSession(scopeId);
    session = await getSession(scopeId);
    if (!session) {
      session = await createSession(scopeId, context);
      session = await createSession(scopeId, context);
    }
  } catch (sessionErr) {
    console.warn('[feedService] Session read failed, continuing with null session:', sessionErr.message);
  }

  // ── Cache HIT: return immediately ─────────────────────────────────────────
  // NOTE: an empty array is deliberately NOT treated as a hit — a previous
  // cold-start/failed generation must not be replayed for the full TTL.
  // Falls through to the generation pipeline below instead.
  if (cachedSlice !== null && Array.isArray(cachedSlice) && cachedSlice.length > 0) {
  // NOTE: an empty array is deliberately NOT treated as a hit — a previous
  // cold-start/failed generation must not be replayed for the full TTL.
  // Falls through to the generation pipeline below instead.
  if (cachedSlice !== null && Array.isArray(cachedSlice) && cachedSlice.length > 0) {
    const nextCursor = session?.cursor ?? effectiveCursor;
    const sliced = cachedSlice.slice(0, pageSize);
    const hydratedSlicedItems = await _hydrateFeedItems(sliced, userId, pool, orgActorId);
    const hydratedSlicedItems = await _hydrateFeedItems(sliced, userId, pool, orgActorId);
    return _buildResponse(hydratedSlicedItems, session, true, nextCursor, 0);
  }

  // ── B7.3: Cache MISS — run full generation pipeline ───────────────────────
  let feedItems     = [];
  let totalCandidates = 0;

  try {
    const pipelineResult = await _runPipeline({ userId, scopeId, limit: pageSize, pool, session, isInitialPage });
    feedItems = pipelineResult.feedItems;
    totalCandidates = pipelineResult.totalCandidates;
  } catch (pipelineErr) {
    console.error('[feedService] Pipeline failed:', pipelineErr.message);
    // Non-fatal: Fallback to trending candidates before giving up
    try {
      const { getTrendingCandidates } = require('./candidates/sources/trendingSource');
      const trending = await getTrendingCandidates({ userId, limit: pageSize, pool });
      feedItems = trending.map((c, index) => ({
        id: c.contentId,
        type: c.itemType,
        content: c.metadata || {},
        author: { id: c.authorId },
        score: c.score,
      feedItems = trending.map((c, index) => ({
        id: c.contentId,
        type: c.itemType,
        content: c.metadata || {},
        author: { id: c.authorId },
        score: c.score,
        slot_type: 'organic',
        position: index
        position: index
      }));
    } catch (fallbackErr) {
      feedItems = [];
    }
  }

  // ── B7.4: Cache the assembled slice (TTL 5 min) ───────────────────────────
  const nextCursor = uuidv4();
  const slicedItems = feedItems.slice(0, pageSize);
  try {
    const ttl = slicedItems.length > 0 ? FEED_SLICE_TTL : 15;
    await setFeedSlice(scopeId, effectiveCursor, slicedItems, ttl);
    await setFeedSlice(scopeId, effectiveCursor, slicedItems, ttl);
  } catch (writeErr) {
    console.warn('[feedService] Cache write failed (non-fatal):', writeErr.message);
  }

  // ── Update session cursor + seen set ──────────────────────────────────────
  try {
    const itemIds = slicedItems.map(i => i.id).filter(Boolean);
    await Promise.all([
      updateCursor(scopeId, nextCursor),
      itemIds.length > 0 ? addToSeenSet(scopeId, itemIds) : Promise.resolve(),
      incrementSeenCount(scopeId, slicedItems.length),
      updateCursor(scopeId, nextCursor),
      itemIds.length > 0 ? addToSeenSet(scopeId, itemIds) : Promise.resolve(),
      incrementSeenCount(scopeId, slicedItems.length),
    ]);
  } catch (sessionUpdateErr) {
    console.warn('[feedService] Session update failed (non-fatal):', sessionUpdateErr.message);
  }

  // ── Hydrate items ─────────────────────────────────────────────────────────
  const hydratedSlicedItems = await _hydrateFeedItems(slicedItems, userId, pool, orgActorId);
  const hydratedSlicedItems = await _hydrateFeedItems(slicedItems, userId, pool, orgActorId);

  // ── B7.5: Return response ─────────────────────────────────────────────────
  return _buildResponse(hydratedSlicedItems, session, false, nextCursor, totalCandidates);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * hidePost
 * Processes a "Not Interested" action:
 * 1. Permanently hides the post (addToSeenSet)
 * 2. Logs the analytics event
 * 3. Applies a negative penalty to user's hashtag score
 */
async function hidePost({ userId, postId, sessionId, position, pool, orgActorId = null }) {
async function hidePost({ userId, postId, sessionId, position, pool, orgActorId = null }) {
  if (!userId || !postId) throw new Error('hidePost: userId and postId are required');

  const scopeId = buildCacheScopeId(userId, orgActorId);

  const scopeId = buildCacheScopeId(userId, orgActorId);

  // 1. Permanently hide from future feed generations (addToSeenSet)
  try {
    await addToSeenSet(scopeId, [postId]);
    await addToSeenSet(scopeId, [postId]);
  } catch (err) {
    console.warn('[feedService] hidePost addToSeenSet failed:', err.message);
  }

  // 2. Track analytics event as 'hide'
  try {
    await feedAnalytics.trackEvent({
      event_type: 'hide',
      item_id: postId,
      item_type: 'post',
      user_id: userId,
      session_id: sessionId || 'unknown_session',
      position: position || 0,
      context: 'home',
      pool
    });
  } catch (err) {
    console.warn('[feedService] hidePost trackEvent failed:', err.message);
  }

  // 3. Apply a negative penalty (-5) to the user's hashtag score based on post tags
  try {
    await incrementUserHashtagScore(userId, -5, null, postId).catch(err => {
      console.warn('[feedService] hidePost score penalty failed:', err.message);
    });
  } catch (err) {
    console.warn('[feedService] hidePost incrementUserHashtagScore failed:', err.message);
  }

  return { ok: true };
}

module.exports = {
  getFeed,
  hidePost,
  buildCacheScopeId,
  buildCacheScopeId,

  // Exported for unit tests
  _buildResponse,
  _runPipeline,
};
