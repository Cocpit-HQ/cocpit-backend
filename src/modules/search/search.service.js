/**
 * Global Search Service for COCPIT
 * Orchestrates multi-entity subroutines on a single database connection for 'all' mode
 * and delegates to domain-specific queries for category deep-dives.
 * Implements Redis caching and session-level statement_timeout = 3500ms.
 */
const crypto = require('crypto');
const pool = require('../../core/db/pool');
const redis = require('../../core/cache/redis');
const { searchPeople } = require('./queries/peopleSearch.query');
const { searchJobs } = require('./queries/jobSearch.query');
const { searchCompanies } = require('./queries/companySearch.query');
const { searchInstitutes } = require('./queries/instituteSearch.query');
const { searchPosts } = require('./queries/postSearch.query');
const { searchHashtags } = require('./queries/hashtagSearch.query');

/**
 * Builds the actor scope ID for personalized search cache isolation
 */
function buildSearchCacheScopeId({ actor, userId }) {
  if (actor?.type === 'ORGANIZATION') {
    return `org:${actor.orgId || actor.id}`;
  }
  const uid = userId || actor?.userId || (actor?.type === 'USER' ? (actor.userId || actor.id) : null);
  if (uid) {
    return `user:${uid}`;
  }
  return 'guest';
}

/**
 * Builds a deterministic Redis cache key based on query parameters and actor scope
 */
function buildSearchCacheKey({ scopeId, type, q, cursor, limit, queryParams }) {
  const normParams = {
    q: (q || '').trim().toLowerCase(),
    cursor: cursor || null,
    limit: limit || 10,
    ...queryParams,
  };
  const sortedKeys = Object.keys(normParams).sort();
  const canonical = {};
  for (const k of sortedKeys) {
    if (normParams[k] !== undefined && normParams[k] !== null && normParams[k] !== '') {
      canonical[k] = normParams[k];
    }
  }
  const hash = crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16);
  return `search:cache:${scopeId}:${type}:${hash}`;
}

/**
 * Personalization-aware TTL strategy
 */
function getSearchCacheTTL({ scopeId, type }) {
  if (type === 'hashtags') return 300; // 5 minutes
  if (scopeId === 'guest') return 120; // 2 minutes
  if (type === 'all') return 30; // 30 seconds for authenticated personalized overview
  return 120; // 2 minutes for category deep-dives
}

/**
 * Safe Redis cache reader with error suppression
 */
async function getCachedSearch(key) {
  try {
    if (!redis || typeof redis.get !== 'function') return null;
    const raw = await redis.get(key);
    if (raw) {
      return JSON.parse(raw);
    }
  } catch (err) {
    // Fail silently, fall back to DB
  }
  return null;
}

/**
 * Safe Redis cache writer with error suppression
 */
async function setCachedSearch(key, data, ttlSeconds) {
  try {
    if (!redis || typeof redis.set !== 'function') return;
    await redis.set(key, JSON.stringify(data), 'EX', ttlSeconds);
  } catch (err) {
    // Fail silently
  }
}

/**
 * Executes a search operation using a single connection client.
 * Sets session statement_timeout = 3500ms and resets to 0 before release.
 * Releases with error flag on failure to prevent connection state leakage.
 */
async function withSearchClient(fn) {
  const client = await pool.connect();
  let hasError = false;

  try {
    await client.query('SET statement_timeout = 3500');
    const result = await fn(client);
    await client.query('SET statement_timeout = 0').catch(() => {});
    return result;
  } catch (err) {
    hasError = true;
    await client.query('SET statement_timeout = 0').catch(() => {});
    throw err;
  } finally {
    client.release(hasError ? true : undefined);
  }
}

/**
 * Backward compatibility wrapper for executeSearchSubroutine
 */
async function executeSearchSubroutine(subroutineFn) {
  return withSearchClient(subroutineFn);
}

/**
 * Maps a settled promise result to a standard section response
 */
function mapSettledResult(settled) {
  if (settled.status === 'fulfilled') {
    return {
      items: settled.value.items,
      has_more: Boolean(settled.value.has_more),
      status: 'success',
    };
  }

  const err = settled.reason;
  console.error('[mapSettledResult Error]:', err?.message || err);
  const isTimeout = err?.code === '57014' || err?.message?.includes('statement timeout');
  return {
    items: [],
    has_more: false,
    status: 'error',
    error_code: isTimeout ? 'QUERY_TIMEOUT' : 'QUERY_FAILED',
  };
}

/**
 * Main search orchestrator
 */
async function executeSearch({ q, type = 'all', limit = 10, cursor = null, queryParams = {}, actor = null, userId = null }) {
  const searchTerm = (q || '').trim();
  const humanUserId = userId || actor?.userId || (actor?.type === 'USER' ? (actor.userId || actor.id) : null);
  const viewerId = actor?.type === 'USER' ? (actor.userId || actor.id) : null;
  const orgActorId = actor?.type === 'ORGANIZATION' ? (actor.orgId || actor.id) : null;
  const effectiveViewerId = viewerId || orgActorId;

  // 1. Check Redis Cache
  const scopeId = buildSearchCacheScopeId({ actor, userId });
  const cacheKey = buildSearchCacheKey({ scopeId, type, q: searchTerm, cursor, limit, queryParams });
  const cached = await getCachedSearch(cacheKey);
  if (cached) {
    return cached;
  }

  // 2. Stage A: Multi-Category 'All' View (Executed on 1 single DB connection)
  if (type === 'all') {
    const isOrg = Boolean(orgActorId);

    const result = await withSearchClient(async (client) => {
      const runSubroutine = async (fn) => {
        try {
          const val = await fn();
          return { status: 'fulfilled', value: val };
        } catch (err) {
          return { status: 'rejected', reason: err };
        }
      };

      const peopleRes = await runSubroutine(() => searchPeople(client, { searchTerm, viewerId, orgActorId, limit: 3 }));
      const jobsRes = isOrg
        ? { status: 'fulfilled', value: { items: [], has_more: false } }
        : await runSubroutine(() => searchJobs(client, { queryParams: { q: searchTerm }, viewerId: humanUserId, orgActorId, limit: 3 }));
      const companiesRes = await runSubroutine(() => searchCompanies(client, { searchTerm, viewerId, orgActorId, limit: 2 }));
      const institutesRes = await runSubroutine(() => searchInstitutes(client, { searchTerm, viewerId, orgActorId, limit: 2 }));
      const postsRes = await runSubroutine(() => searchPosts(client, { searchTerm, viewerId: effectiveViewerId, orgActorId, limit: 2 }));
      const hashtagsRes = await runSubroutine(() => searchHashtags(client, { searchTerm, limit: 2 }));

      const sections = {
        people: mapSettledResult(peopleRes),
        jobs: isOrg ? { items: [], has_more: false, status: 'success' } : mapSettledResult(jobsRes),
        companies: mapSettledResult(companiesRes),
        institutes: mapSettledResult(institutesRes),
        posts: mapSettledResult(postsRes),
        hashtags: mapSettledResult(hashtagsRes),
      };

      return {
        status: 'success',
        type: 'all',
        query: searchTerm,
        sections,
        results: sections,
      };
    });

    // Cache if all sections executed without critical query errors
    const hasErrors = Object.values(result.sections || {}).some(s => s.status === 'error');
    if (!hasErrors) {
      const ttl = getSearchCacheTTL({ scopeId, type });
      await setCachedSearch(cacheKey, result, ttl);
    }

    return result;
  }

  // 3. Stage B: Category-Specific Deep-Dives (Executed on 1 single DB connection)
  const numLimit = Number(limit) || 10;

  const result = await withSearchClient(async (client) => {
    switch (type) {
      case 'people': {
        const res = await searchPeople(client, { searchTerm, viewerId, orgActorId, limit: numLimit, cursor, queryParams: { ...queryParams, q: searchTerm } });
        return {
          type: 'people',
          query: searchTerm,
          items: res.items,
          next_cursor: res.next_cursor || null,
          has_more: Boolean(res.has_more),
          pagination: {
            limit: numLimit,
            next_cursor: res.next_cursor || null,
            has_more: Boolean(res.has_more),
          },
        };
      }

      case 'jobs': {
        const combinedParams = { ...queryParams, q: searchTerm };
        const res = await searchJobs(client, { queryParams: combinedParams, viewerId: humanUserId, orgActorId, limit: numLimit, cursor });
        return {
          type: 'jobs',
          query: searchTerm,
          items: res.items,
          next_cursor: res.next_cursor || null,
          has_more: Boolean(res.has_more),
          pagination: {
            limit: numLimit,
            next_cursor: res.next_cursor || null,
            has_more: Boolean(res.has_more),
          },
        };
      }

      case 'companies': {
        const res = await searchCompanies(client, { searchTerm, viewerId, orgActorId, limit: numLimit, cursor, queryParams });
        return {
          type: 'companies',
          query: searchTerm,
          items: res.items,
          next_cursor: res.next_cursor || null,
          has_more: Boolean(res.has_more),
          pagination: {
            limit: numLimit,
            next_cursor: res.next_cursor || null,
            has_more: Boolean(res.has_more),
          },
        };
      }

      case 'institutes': {
        const res = await searchInstitutes(client, { searchTerm, viewerId, orgActorId, limit: numLimit, cursor, queryParams });
        return {
          type: 'institutes',
          query: searchTerm,
          items: res.items,
          next_cursor: res.next_cursor || null,
          has_more: Boolean(res.has_more),
          pagination: {
            limit: numLimit,
            next_cursor: res.next_cursor || null,
            has_more: Boolean(res.has_more),
          },
        };
      }

      case 'posts': {
        const res = await searchPosts(client, { searchTerm, viewerId: effectiveViewerId, orgActorId, limit: numLimit, cursor, queryParams });
        return {
          type: 'posts',
          query: searchTerm,
          items: res.items,
          next_cursor: res.next_cursor || null,
          has_more: Boolean(res.has_more),
          pagination: {
            limit: numLimit,
            next_cursor: res.next_cursor || null,
            has_more: Boolean(res.has_more),
          },
        };
      }

      case 'hashtags': {
        const res = await searchHashtags(client, { searchTerm, limit: numLimit, cursor, queryParams });
        return {
          type: 'hashtags',
          query: searchTerm,
          items: res.items,
          next_cursor: res.next_cursor || null,
          has_more: Boolean(res.has_more),
          pagination: {
            limit: numLimit,
            next_cursor: res.next_cursor || null,
            has_more: Boolean(res.has_more),
          },
        };
      }

      default: {
        const err = new Error(`Unsupported search type: '${type}'. Supported types: all, people, jobs, companies, institutes, posts, hashtags`);
        err.statusCode = 400;
        throw err;
      }
    }
  });

  const ttl = getSearchCacheTTL({ scopeId, type });
  await setCachedSearch(cacheKey, result, ttl);

  return result;
}

module.exports = {
  executeSearch,
  executeSearchSubroutine,
  withSearchClient,
  buildSearchCacheKey,
  buildSearchCacheScopeId,
  getSearchCacheTTL,
};
