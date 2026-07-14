/**
 * candidateGenerator.js
 * COCPIT Feed Engine — Candidate Generation Orchestrator
 *
 * Sprint Task: Day 2 — Task B5 (B5.1 – B5.4)
 * Owner: Dev B
 * AI-Assisted: Yes (Antigravity)
 * Contracts read: contracts/redis-key-registry.md, contracts/schemas/candidate.schema.json
 * Last reviewed: 2026-05-24
 *
 * Calls all 4 candidate sources in parallel, merges results, deduplicates by
 * contentId, caches the pool in Redis (feed:candidates:{userId}, TTL 120s),
 * and returns the merged CandidateItem[].
 *
 * Day 1 scaffold foundations preserved:
 *   ✓ Promise.allSettled — one failing source never crashes the pipeline
 *   ✓ Per-source error logging
 *   ✓ Limit cap
 * Day 2 additions (B5):
 *   ✓ Cache-first: getCandidatePool → early return on hit
 *   ✓ Real dedup by contentId (first-seen wins; social graph has priority)
 *   ✓ Cache write after merge: setCandidatePool (TTL 120s)
 *   ✓ Strengthened isCandidateValid: checks itemId + contentId presence
 */

'use strict';

const { getSocialGraphCandidates } = require('./sources/socialGraphSource');
const { getTrendingCandidates }    = require('./sources/trendingSource');
const { getOpportunityCandidates } = require('./sources/opportunitySource');
const { getExplorationCandidates } = require('./sources/explorationSource');
const {
  getCandidatePool,
  setCandidatePool,
} = require('../cache/feedCache');

const CANDIDATE_SOURCE_TIMEOUT_MS = parseInt(process.env.CANDIDATE_SOURCE_TIMEOUT_MS, 10) || 5000;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * withTimeout
 * Wraps a promise in a timeout that rejects if the promise does not resolve within the specified duration.
 *
 * @param {Promise} promise
 * @param {number} timeoutMs
 * @param {string} sourceName
 * @returns {Promise}
 */
function withTimeout(promise, timeoutMs, sourceName) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Source "${sourceName}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then(res => {
        clearTimeout(timer);
        resolve(res);
      })
      .catch(err => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

/**
 * isCandidateValid
 * Structural guard — rejects null/undefined/non-object entries and items
 * missing the fields required by candidate.schema.json.
 *
 * @param {*} candidate
 * @returns {boolean}
 */
function isCandidateValid(candidate) {
  return (
    candidate !== null &&
    candidate !== undefined &&
    typeof candidate === 'object' &&
    !Array.isArray(candidate) &&
    typeof candidate.itemId === 'string' &&
    candidate.itemId.length > 0 &&
    typeof candidate.contentId === 'string' &&
    candidate.contentId.length > 0
  );
}

/**
 * deduplicateByContentId
 * Removes duplicate candidates for the same piece of content.
 * First-seen wins — sources are ordered so social graph takes priority.
 *
 * @param {Array} candidates - Merged, unfiltered candidate list
 * @returns {Array}          - Deduplicated list
 */
function deduplicateByContentId(candidates) {
  const seen   = new Set();
  const result = [];

  for (const candidate of candidates) {
    if (!seen.has(candidate.contentId)) {
      seen.add(candidate.contentId);
      result.push(candidate);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * generateCandidates
 *
 * Cache-first candidate generation. On a cache hit (TTL 120s) the full
 * generation pipeline is skipped. On a miss, all 4 sources are fired
 * concurrently, results are merged, deduplicated, cached, and returned.
 *
 * A failure in any one source is isolated — the remaining sources still
 * contribute to the pool.
 *
 * @param {object}  params
 * @param {string}  params.userId             - Required. UUID of the requesting user.
 * @param {number}  [params.limit=100]        - Max total candidates to return.
 * @param {object}  [params.pool=null]        - pg Pool for source DB queries.
 * @param {object}  [params.context={}]       - Reserved for future context flags.
 * @param {boolean} [params.skipCache=false]  - Force fresh generation (e.g. after hide).
 * @returns {Promise<Array>}                  - CandidateItem[], length ≤ limit.
 * @throws {Error} if userId is not provided.
 */
async function generateCandidates({
  userId,
  limit     = 100,
  pool      = null,
  context   = {},
  skipCache = false,
} = {}) {

  // ── 1. Validate userId ────────────────────────────────────────────────────
  if (!userId) {
    throw new Error('generateCandidates: `userId` is required');
  }

  void context; // accepted for future use (A/B bucket, device type, etc.)

  // ── 2. Cache-first check ──────────────────────────────────────────────────
  // NOTE: an empty cached pool is NOT treated as a hit — a previous
  // cold-start/failed generation must not be replayed for the full TTL.
  if (!skipCache) {
    try {
      const cached = await getCandidatePool(userId);
      if (cached !== null && cached.length > 0) {
        // Slice in case limit changed since the cache was written
        return cached.slice(0, limit);
      }
    } catch (err) {
      // Cache miss or Redis error — fall through to live generation
      console.warn('[candidateGenerator] Cache read failed, generating live:', err.message);
    }
  }

  // ── 3. Call all 4 sources in parallel (fault-tolerant) ───────────────────
  // Source priority order (first seen wins in contentId dedup):
  //   social graph > trending > opportunity > exploration
  const sourceParams = { userId, limit, pool };

  const [
    socialGraphResult,
    trendingResult,
    opportunityResult,
    explorationResult,
  ] = await Promise.allSettled([
    withTimeout(getSocialGraphCandidates(sourceParams), CANDIDATE_SOURCE_TIMEOUT_MS, 'socialGraph'),
    withTimeout(getTrendingCandidates(sourceParams), CANDIDATE_SOURCE_TIMEOUT_MS, 'trending'),
    withTimeout(getOpportunityCandidates(sourceParams), CANDIDATE_SOURCE_TIMEOUT_MS, 'opportunity'),
    withTimeout(getExplorationCandidates(sourceParams), CANDIDATE_SOURCE_TIMEOUT_MS, 'exploration'),
  ]);

  // ── 4. Collect with per-source error isolation ────────────────────────────
  const sourceOutcomes = [
    { name: 'socialGraph', result: socialGraphResult  },
    { name: 'trending',    result: trendingResult     },
    { name: 'opportunity', result: opportunityResult  },
    { name: 'exploration', result: explorationResult  },
  ];

  const combined = [];

  for (const { name, result } of sourceOutcomes) {
    if (result.status === 'fulfilled') {
      const candidates = Array.isArray(result.value) ? result.value : [];

      // A9.2 — Per-source debug logging (only when DEBUG_FEED=true)
      if (process.env.DEBUG_FEED === 'true') {
        console.log(`[candidateGenerator:DEBUG] source=${name} count=${candidates.length}`);
      }

      combined.push(...candidates);
    } else {
      // Log the failure but do NOT bubble it up — feed must remain resilient.
      console.error(
        `[candidateGenerator] Source "${name}" failed:`,
        result.reason?.message ?? result.reason
      );

      // A9.2 — Log failed source count as 0 in debug mode
      if (process.env.DEBUG_FEED === 'true') {
        console.log(`[candidateGenerator:DEBUG] source=${name} count=0 (FAILED)`);
      }
    }
  }

  // A9.2 — Log aggregate counts in debug mode
  if (process.env.DEBUG_FEED === 'true') {
    console.log(`[candidateGenerator:DEBUG] combined=${combined.length}`);
  }

  // ── 5. Validate + deduplicate by contentId ────────────────────────────────
  const valid  = combined.filter(isCandidateValid);
  const deduped = deduplicateByContentId(valid);

  // A11.3 Fallback logic: If generated candidates < 5, fill remaining feed slots using global trending candidates.
  if (deduped.length < 5) {
    try {
      if (process.env.DEBUG_FEED === 'true') {
        console.log(`[candidateGenerator:DEBUG] Pool size is ${deduped.length} (< 5). Triggering trending fallback...`);
      }
      const fallbackTrending = await getTrendingCandidates({ userId, limit, pool });
      const currentContentIds = new Set(deduped.map(c => c.contentId));
      for (const candidate of fallbackTrending) {
        if (!currentContentIds.has(candidate.contentId)) {
          deduped.push(candidate);
        }
      }
    } catch (err) {
      console.warn('[candidateGenerator] Fallback trending fetch failed:', err.message);
    }
  }

  // A9.2 — Log post-filter counts in debug mode
  if (process.env.DEBUG_FEED === 'true') {
    console.log(`[candidateGenerator:DEBUG] valid=${valid.length} deduped=${deduped.length}`);
  }

  // ── 6. Apply total limit ──────────────────────────────────────────────────
  const limited = deduped.slice(0, limit);

  if (limited.length === 0) {
    console.error(`[candidateGenerator] CRITICAL: Zero candidates generated for userId=${userId}. All sources may have failed.`);
  }

  // A9.2 — Log final pool size in debug mode
  if (process.env.DEBUG_FEED === 'true') {
    console.log(`[candidateGenerator:DEBUG] final pool size=${limited.length} (limit=${limit})`);
  }

  // ── 7. Write to Redis cache (non-fatal on failure) ────────────────────────
  try {
    const ttl = limited.length > 0 ? undefined : 15;
    await setCandidatePool(userId, limited, ttl);
  } catch (err) {
    // Cache write failure must never break the response
    console.warn('[candidateGenerator] Cache write failed:', err.message);
  }

  // ── 8. Return merged, deduped, cached pool ────────────────────────────────
  return limited;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { generateCandidates };
