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
  removeFromSeenSet,
  addToHiddenSet,
  getHiddenSet,
  removeFromHiddenSet,
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
// Main Entry
// ---------------------------------------------------------------------------

/**
 * Fetch a chronological feed, bypassing all ranking logic and seen-set filtering.
 * It will filter out explicitly hidden posts and blocked users.
 */
async function _fetchChronologicalFeed(userId, cursor, limit, pool, orgActorId) {
  const scopeId = buildCacheScopeId(userId, orgActorId);
  
  // Use timestamp string (e.g. ts:2026-07-15T10:00:00.000Z) or default to now
  let cursorTs = new Date().toISOString();
  if (cursor && cursor.startsWith('ts:')) {
    cursorTs = cursor.slice(3);
  }

  // Fetch chronological posts, filtering blocked users and blocked organizations directly in SQL
  const query = `
    SELECT p.post_id AS id, 'post' AS type, 'organic' AS slot_type, p.created_at
    FROM posts p
    WHERE p.visibility = 'public'
      AND (p.is_removed IS FALSE OR p.is_removed IS NULL)
      AND p.is_active = TRUE
      AND p.is_community_article IS NOT TRUE
      AND p.created_at < $1
      ${orgActorId ? `
      AND NOT EXISTS (
        SELECT 1 FROM blocks b
        WHERE (p.author_org_id IS NULL AND (
                (b.is_org_block = true AND b.blocker_id = $2 AND b.blocked_id = p.author_id)
             OR (b.is_org_block = false AND b.blocker_id = p.author_id AND b.blocked_id = $2)
        ))
        OR (p.author_org_id IS NOT NULL AND (
                (b.blocker_id = p.author_org_id AND b.blocked_id = $2)
             OR (b.blocker_id = $2 AND b.blocked_id = p.author_org_id)
        ))
      )
      AND NOT EXISTS (
        SELECT 1 FROM reports r
        WHERE (
            r.target_id = p.post_id 
            OR (
                p.shared_post_id IS NOT NULL 
                AND (p.content IS NULL OR TRIM(regexp_replace(p.content, '<[^>]+>|&nbsp;|\u200B|\u00A0|&#8203;|&#160;|&zwnj;', '', 'gi')) = '') 
                AND r.target_id = p.shared_post_id
            )
            OR (
                EXISTS (
                    SELECT 1 FROM posts rp 
                    WHERE rp.post_id = r.target_id 
                      AND rp.shared_post_id = COALESCE(p.shared_post_id, p.post_id)
                      AND rp.content IS NOT NULL 
                      AND TRIM(regexp_replace(rp.content, '<[^>]+>|&nbsp;|\u200B|\u00A0|&#8203;|&#160;|&zwnj;', '', 'gi')) != ''
                )
            )
        )
          AND r.target_type = 'POST' 
          AND r.reporter_id = $4
          AND r.reporter_org_id = $2
      )
      ` : `
      AND NOT EXISTS (
        SELECT 1 FROM blocks b
        WHERE (b.is_org_block = false AND p.author_org_id IS NULL AND ((b.blocker_id = $2 AND b.blocked_id = p.author_id) OR (b.blocker_id = p.author_id AND b.blocked_id = $2)))
           OR (b.is_org_block = true AND p.author_org_id IS NOT NULL AND ((b.blocker_id = p.author_org_id AND b.blocked_id = $2) OR (b.blocker_id = $2 AND b.blocked_id = p.author_org_id)))
           OR (b.is_org_block = false AND p.author_org_id IS NOT NULL AND (b.blocker_id = $2 AND b.blocked_id = p.author_org_id))
      )
      AND NOT EXISTS (
        SELECT 1 FROM reports r
        WHERE (
            r.target_id = p.post_id 
            OR (
                p.shared_post_id IS NOT NULL 
                AND (p.content IS NULL OR TRIM(regexp_replace(p.content, '<[^>]+>|&nbsp;|\u200B|\u00A0|&#8203;|&#160;|&zwnj;', '', 'gi')) = '') 
                AND r.target_id = p.shared_post_id
            )
            OR (
                EXISTS (
                    SELECT 1 FROM posts rp 
                    WHERE rp.post_id = r.target_id 
                      AND rp.shared_post_id = COALESCE(p.shared_post_id, p.post_id)
                      AND rp.content IS NOT NULL 
                      AND TRIM(regexp_replace(rp.content, '<[^>]+>|&nbsp;|\u200B|\u00A0|&#8203;|&#160;|&zwnj;', '', 'gi')) != ''
                )
            )
        )
          AND r.target_type = 'POST' 
          AND r.reporter_id = $4
          AND r.reporter_org_id IS NULL
      )
      `}
    ORDER BY p.created_at DESC
    LIMIT $3
  `;
  const result = await pool.query(query, [cursorTs, orgActorId || userId, limit, userId]);
  let items = result.rows;

  // Filter explicitly hidden posts
  try {
    const hiddenSet = await getHiddenSet(scopeId);
    if (hiddenSet && hiddenSet.length > 0) {
      const hiddenIds = new Set(hiddenSet);
      items = items.filter(item => !hiddenIds.has(item.id));
    }
  } catch (err) {
    console.warn('[feedService] Failed to fetch hidden set for chronological feed:', err.message);
  }

  // Map to position for standard response format
  const formattedItems = items.map((item, index) => ({
    id: item.id,
    type: item.type,
    slot_type: item.slot_type,
    position: index,
    created_at: item.created_at
  }));

  // Determine next cursor based on the last item's created_at
  let nextCursor = null;
  if (formattedItems.length > 0) {
    const lastItemTs = new Date(formattedItems[formattedItems.length - 1].created_at).toISOString();
    nextCursor = `ts:${lastItemTs}`;
  }

  return { items: formattedItems, nextCursor };
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
  ]);

  // ── Step 3: Extract opportunity candidates from ranked list ───────────────
  // ===========================================================================
  // [CLEANUP - FEED REFACTOR] REASON FOR COMMENTING OUT:
  // - Status: DISCONNECTED / UNUSED
  // - Technical Reason: Opportunity items (jobs, events) cannot be hydrated by
  //   _hydrateFeedItems (which queries the 'posts' table). They arrived with post_data = null
  //   and were filtered out by frontend (feed.ts).
  // - Active Replacement: Passing [] allows rerankingEngine to fill all 20 feed slots
  //   with fully-hydrated organic posts.
  // ===========================================================================
  // const opportunityCandidates = rankedCandidates
  //   .filter(item => item._candidate?.isOpportunity === true)
  //   .map(item => item._candidate);  // pass raw CandidateItem to slot injector
  const opportunityCandidates = [];

  // ── Step 4: Rerank + slot injection ──────────────────────────────────────
  // scopeId (not userId) so the seen-set dedup matches whichever actor is
  // actually viewing — see buildCacheScopeId. isInitialPage disables the
  // seen-set filter for a fresh page load — see rerankCandidates doc comment.
  const feedItems = await rerankCandidates(
    rankedCandidates,
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
  if (!items || items.length === 0) return items;
  if (!pool) return items; // Can't hydrate without DB pool

  const postIds = items.map(i => i.id).filter(Boolean);
  if (postIds.length === 0) return items;

  try {
    const query = `
      SELECT ${getPostHydrationSelect(2, 1)}
      ${getPostHydrationJoins()}
      ${getPublicFeedWhere(1, orgActorId ? 2 : null)}
      AND p.post_id = ANY($3::uuid[])
    `;
    // param 1: user (always real identity — blocks/membership checks etc.)
    // param 2: company — ID-160/D1: pass the acting org so is_liked/is_saved/
    //   is_commented/broadcast-visibility reflect the company's own state
    //   instead of always falling back to the human's personal state.
    const params = [userId, orgActorId, postIds];

    const { rows } = await pool.query(query, params);
    
    const { hydrateShareCounts } = require('../../utils/shareHydration');
    const hydratedRows = await hydrateShareCounts(rows);

    const rowMap = new Map();
    for (const row of hydratedRows) {
      rowMap.set(row.post_id, row);
    }

    return items.map(item => ({
      ...item,
      post_data: rowMap.get(item.id) || null
    })).filter(item => item.post_data && item.post_data.is_reported !== true);
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
// Internal: fetch chronological feed (when algorithm = false)
// ---------------------------------------------------------------------------

async function _fetchChronologicalFeed(userId, cursor, limit, pool, orgActorId = null) {
  if (!pool) return { items: [], nextCursor: null };

  const scopeId = buildCacheScopeId(userId, orgActorId);

  let hiddenSet = new Set();
  try {
    const hiddenArray = await getHiddenSet(scopeId);
    hiddenSet = new Set(hiddenArray || []);
  } catch (err) {
    console.warn('[feedService] _fetchChronologicalFeed getHiddenSet failed:', err.message);
  }

  const fetchLimit = limit + 5;
  const params = [fetchLimit];
  let cursorCondition = '';

  if (cursor && cursor !== 'initial') {
    params.push(cursor);
    cursorCondition = `AND p.created_at < $2`;
  }

  const query = `
    SELECT p.post_id AS id, 'post' AS type, 'organic' AS slot_type, p.created_at
    FROM posts p
    WHERE (p.is_removed IS FALSE OR p.is_removed IS NULL)
      AND (p.is_active IS TRUE OR p.is_active IS NULL)
      AND (p.is_deleted IS FALSE OR p.is_deleted IS NULL)
      AND (p.is_unlisted IS FALSE OR p.is_unlisted IS NULL)
      AND NOT EXISTS (
        SELECT 1 FROM users u WHERE u.user_id = p.author_id AND (u.is_deleted = true OR u.is_suspended = true OR u.deletion_execute_at IS NOT NULL)
      )
      AND NOT EXISTS (
        SELECT 1 FROM organizations o WHERE o.org_id = p.author_org_id AND (o.is_deleted = true OR o.is_deactivated = true OR o.is_suspended = true)
      )
      ${cursorCondition}
    ORDER BY p.created_at DESC, p.post_id DESC
    LIMIT $1;
  `;

  try {
    const { rows } = await pool.query(query, params);
    
    const rawItems = (rows || []).filter(r => !hiddenSet.has(r.id));
    const items = rawItems.slice(0, limit);

    const lastItem = items[items.length - 1];
    const nextCursor = items.length >= limit && lastItem && lastItem.created_at
      ? new Date(lastItem.created_at).toISOString()
      : null;

    return { items, nextCursor };
  } catch (err) {
    console.error('[feedService] _fetchChronologicalFeed failed:', err.message);
    return { items: [], nextCursor: null };
  }
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
 * @returns {Promise<object>}       - FeedResponse matching api-contracts.md
 */
async function getFeed({ userId, cursor = null, limit = DEFAULT_PAGE_SIZE, pool = null, context = 'home', orgActorId = null, algorithm = true } = {}) {
  if (!userId) throw new Error('feedService.getFeed: `userId` is required');

  const pageSize = Math.min(Math.max(limit, 1), 50);  // enforce max from api-contracts.md
  const effectiveCursor = cursor || 'initial';
  const scopeId = buildCacheScopeId(userId, orgActorId);
  
  // ── 0. Chronological By-pass (algorithm=false) ────────────────────────────
  if (algorithm === false) {
    const chronoResult = await _fetchChronologicalFeed(userId, cursor, pageSize, pool, orgActorId);
    const hydratedSlicedItems = await _hydrateFeedItems(chronoResult.items, userId, pool, orgActorId);
    
    // We construct a mock session just to populate the response properly.
    const mockSession = { session_id: 'chrono-session' };
    
    return _buildResponse(hydratedSlicedItems, mockSession, false, chronoResult.nextCursor, chronoResult.items.length);
  }

  // ID-160 follow-up: true only for a genuinely fresh page load (no cursor
  // supplied) — see rerankCandidates' isInitialPage doc comment.
  const isInitialPage = !cursor;

  // ── B7.2: Check Redis cache first ─────────────────────────────────────────
  let cachedSlice = null;
  try {
    cachedSlice = await getFeedSlice(scopeId, effectiveCursor);
  } catch (cacheErr) {
    console.warn('[feedService] Cache read failed, falling through to pipeline:', cacheErr.message);
  }

  // ── Get or create session ─────────────────────────────────────────────────
  let session = null;
  try {
    session = await getSession(scopeId);
    if (!session) {
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
    const nextCursor = session?.cursor ?? effectiveCursor;
    const sliced = cachedSlice.slice(0, pageSize);
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
        slot_type: 'organic',
        position: index
      }));
    } catch (fallbackErr) {
      feedItems = [];
    }
  }

  // ── B7.4: Cache the assembled slice (TTL 5 min) ───────────────────────────
  const slicedItems = feedItems.slice(0, pageSize);
  const nextCursor = slicedItems.length > 0 ? uuidv4() : null;
  try {
    const ttl = slicedItems.length > 0 ? FEED_SLICE_TTL : 15;
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
    ]);
  } catch (sessionUpdateErr) {
    console.warn('[feedService] Session update failed (non-fatal):', sessionUpdateErr.message);
  }

  // ── Hydrate items ─────────────────────────────────────────────────────────
  const hydratedSlicedItems = await _hydrateFeedItems(slicedItems, userId, pool, orgActorId);

  // ── B7.5: Return response ─────────────────────────────────────────────────
  return _buildResponse(hydratedSlicedItems, session, false, nextCursor, totalCandidates);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

// ===========================================================================
// [CLEANUP - FEED REFACTOR] REASON FOR COMMENTING OUT:
// - Status: REDUNDANT
// - Technical Reason: Legacy hidePost function.
// - Active Replacement: Post hiding and negative hashtag affinity adjustments (-5)
//   are handled cleanly by submitFeedback with feedbackType = 'NOT_INTERESTED'.
// ===========================================================================
/*
async function hidePost({ userId, postId, sessionId, position, pool, orgActorId = null }) {
  if (!userId || !postId) throw new Error('hidePost: userId and postId are required');

  const scopeId = buildCacheScopeId(userId, orgActorId);

  // 1. Permanently hide from future feed generations (addToSeenSet and addToHiddenSet)
  try {
    await Promise.all([
      addToSeenSet(scopeId, [postId]),
      addToHiddenSet(scopeId, [postId])
    ]);
  } catch (err) {
    console.warn('[feedService] hidePost Redis sets update failed:', err.message);
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
*/

/**
 * unhidePost
 * Reverses a "Not Interested" action:
 * 1. Removes the post from seenSet and hiddenSet
 * 2. Logs the analytics event
 * 3. Reverses the negative penalty to user's hashtag score
 */
async function unhidePost({ userId, postId, sessionId, position, pool, orgActorId = null }) {
  if (!userId || !postId) throw new Error('unhidePost: userId and postId are required');

  const scopeId = buildCacheScopeId(userId, orgActorId);

  // 1. Remove from seenSet and hiddenSet
  try {
    await Promise.all([
      removeFromSeenSet(scopeId, [postId]),
      removeFromHiddenSet(scopeId, [postId])
    ]);
  } catch (err) {
    console.warn('[feedService] unhidePost Redis sets update failed:', err.message);
  }

  // 2. Track analytics event as 'unhide'
  try {
    await feedAnalytics.trackEvent({
      event_type: 'unhide',
      item_id: postId,
      item_type: 'post',
      user_id: userId,
      session_id: sessionId || 'unknown_session',
      position: position || 0,
      context: 'home',
      pool
    });
  } catch (err) {
    console.warn('[feedService] unhidePost trackEvent failed:', err.message);
  }

  // 3. Reverse the negative penalty (+5) to the user's hashtag score
  try {
    await incrementUserHashtagScore(userId, 5, null, postId).catch(err => {
      console.warn('[feedService] unhidePost score penalty failed:', err.message);
    });
  } catch (err) {
    console.warn('[feedService] unhidePost incrementUserHashtagScore failed:', err.message);
  }

  return { ok: true };
}

/**
 * submitFeedback
 * Generic feedback mechanism for Interested / Not Interested
 */
async function submitFeedback({ userId, postId, feedbackType, sessionId, position, pool, orgActorId = null }) {
  if (!userId || !postId || !feedbackType) {
    throw new Error('submitFeedback: userId, postId, and feedbackType are required');
  }

  // 1. Upsert the permanent feedback to DB
  try {
    await pool.query(`
      INSERT INTO user_post_feedback (user_id, post_id, feedback_type, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (user_id, post_id) 
      DO UPDATE SET feedback_type = EXCLUDED.feedback_type, updated_at = NOW()
    `, [userId, postId, feedbackType]);
  } catch (err) {
    console.error('[feedService] submitFeedback DB upsert failed:', err.message);
    throw err;
  }

  const scopeId = buildCacheScopeId(userId, orgActorId);

  if (feedbackType === 'INTERESTED') {
    // 2a. Track analytics event
    try {
      await feedAnalytics.trackEvent({
        event_type: 'interested',
        item_id: postId,
        item_type: 'post',
        user_id: userId,
        session_id: sessionId || 'unknown_session',
        position: position || 0,
        context: 'home',
        pool
      });
    } catch (err) {
      console.warn('[feedService] submitFeedback trackEvent interested failed:', err.message);
    }

    // 3a. Increment positive score (+5)
    try {
      await incrementUserHashtagScore(userId, 5, null, postId).catch(() => {});
    } catch (err) {}

    // 4a. If they were previously "NOT_INTERESTED", we should unhide it from Redis sets
    try {
      await Promise.all([
        removeFromSeenSet(scopeId, [postId]),
        removeFromHiddenSet(scopeId, [postId])
      ]);
    } catch (err) {}

  } else if (feedbackType === 'NOT_INTERESTED') {
    // 2b. Add to hiddenSet / seenSet
    try {
      await Promise.all([
        addToSeenSet(scopeId, [postId]),
        addToHiddenSet(scopeId, [postId])
      ]);
    } catch (err) {
      console.warn('[feedService] submitFeedback NOT_INTERESTED Redis failed:', err.message);
    }

    // 3b. Track analytics event
    try {
      await feedAnalytics.trackEvent({
        event_type: 'not_interested',
        item_id: postId,
        item_type: 'post',
        user_id: userId,
        session_id: sessionId || 'unknown_session',
        position: position || 0,
        context: 'home',
        pool
      });
    } catch (err) {
      console.warn('[feedService] submitFeedback trackEvent not_interested failed:', err.message);
    }

    // 4b. Decrement score (-5)
    try {
      await incrementUserHashtagScore(userId, -5, null, postId).catch(() => {});
    } catch (err) {}
  }

  return { ok: true };
}

module.exports = {
  getFeed,
  // hidePost, // UNUSED: Frontend uses submitFeedback with 'NOT_INTERESTED'
  unhidePost,
  submitFeedback,
  buildCacheScopeId,

  // Exported for unit tests
  _buildResponse,
  _runPipeline,
};
