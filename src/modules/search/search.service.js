/**
 * Global Search Service for COCPIT
 * Orchestrates multi-entity parallel subroutines for 'all' mode
 * and delegates to domain-specific queries for category deep-dives.
 * Enforces transaction-scoped statement_timeout = 3500ms and safe pool release.
 */
const pool = require('../../core/db/pool');
const { searchPeople } = require('./queries/peopleSearch.query');
const { searchJobs } = require('./queries/jobSearch.query');
const { searchCompanies } = require('./queries/companySearch.query');
const { searchInstitutes } = require('./queries/instituteSearch.query');
const { searchPosts } = require('./queries/postSearch.query');
const { searchHashtags } = require('./queries/hashtagSearch.query');

/**
 * Executes a search subroutine with transaction-scoped statement timeout
 * Discards the connection on error to guarantee zero connection-state pollution.
 */
async function executeSearchSubroutine(subroutineFn) {
  const client = await pool.connect();
  let hasError = false;

  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL statement_timeout = 3500');
    const result = await subroutineFn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    hasError = true;
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release(hasError ? true : undefined);
  }
}

/**
 * Maps a settled promise to a standard section response
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

  // 1. Stage A: Multi-Category 'All' View
  if (type === 'all') {
    const [peopleRes, jobsRes, companiesRes, institutesRes, postsRes, hashtagsRes] = await Promise.allSettled([
      executeSearchSubroutine(client => searchPeople(client, { searchTerm, viewerId, orgActorId, limit: 3 })),
      executeSearchSubroutine(client => searchJobs(client, { queryParams: { q: searchTerm }, viewerId: humanUserId, orgActorId, limit: 3 })),
      executeSearchSubroutine(client => searchCompanies(client, { searchTerm, viewerId, orgActorId, limit: 2 })),
      executeSearchSubroutine(client => searchInstitutes(client, { searchTerm, viewerId, orgActorId, limit: 2 })),
      executeSearchSubroutine(client => searchPosts(client, { searchTerm, viewerId: effectiveViewerId, orgActorId, limit: 2 })),
      executeSearchSubroutine(client => searchHashtags(client, { searchTerm, limit: 2 })),
    ]);

    const sections = {
      people: mapSettledResult(peopleRes),
      jobs: mapSettledResult(jobsRes),
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
  }

  // 2. Stage B: Category-Specific Deep-Dives
  const numLimit = Number(limit) || 10;

  switch (type) {
    case 'people': {
      const result = await executeSearchSubroutine(client =>
        searchPeople(client, { searchTerm, viewerId, orgActorId, limit: numLimit, cursor, queryParams: { ...queryParams, q: searchTerm } })
      );
      return {
        type: 'people',
        query: searchTerm,
        items: result.items,
        next_cursor: result.next_cursor || null,
        has_more: Boolean(result.has_more),
        pagination: {
          limit: numLimit,
          next_cursor: result.next_cursor || null,
          has_more: Boolean(result.has_more),
        },
      };
    }

    case 'jobs': {
      // Pass all filter params along with the search term
      const combinedParams = { ...queryParams, q: searchTerm };
      const result = await executeSearchSubroutine(client =>
        searchJobs(client, { queryParams: combinedParams, viewerId: humanUserId, orgActorId, limit: numLimit, cursor })
      );
      return {
        type: 'jobs',
        query: searchTerm,
        items: result.items,
        next_cursor: result.next_cursor || null,
        has_more: Boolean(result.has_more),
        pagination: {
          limit: numLimit,
          next_cursor: result.next_cursor || null,
          has_more: Boolean(result.has_more),
        },
      };
    }

    case 'companies': {
      const result = await executeSearchSubroutine(client =>
        searchCompanies(client, { searchTerm, viewerId, orgActorId, limit: numLimit, cursor, queryParams })
      );
      return {
        type: 'companies',
        query: searchTerm,
        items: result.items,
        next_cursor: result.next_cursor || null,
        has_more: Boolean(result.has_more),
        pagination: {
          limit: numLimit,
          next_cursor: result.next_cursor || null,
          has_more: Boolean(result.has_more),
        },
      };
    }

    case 'institutes': {
      const result = await executeSearchSubroutine(client =>
        searchInstitutes(client, { searchTerm, viewerId, orgActorId, limit: numLimit, cursor, queryParams })
      );
      return {
        type: 'institutes',
        query: searchTerm,
        items: result.items,
        next_cursor: result.next_cursor || null,
        has_more: Boolean(result.has_more),
        pagination: {
          limit: numLimit,
          next_cursor: result.next_cursor || null,
          has_more: Boolean(result.has_more),
        },
      };
    }

    case 'posts': {
      const result = await executeSearchSubroutine(client =>
        searchPosts(client, { searchTerm, viewerId: effectiveViewerId, orgActorId, limit: numLimit, cursor, queryParams })
      );
      return {
        type: 'posts',
        query: searchTerm,
        items: result.items,
        next_cursor: result.next_cursor || null,
        has_more: Boolean(result.has_more),
        pagination: {
          limit: numLimit,
          next_cursor: result.next_cursor || null,
          has_more: Boolean(result.has_more),
        },
      };
    }

    case 'hashtags': {
      const result = await executeSearchSubroutine(client =>
        searchHashtags(client, { searchTerm, limit: numLimit, cursor, queryParams })
      );
      return {
        type: 'hashtags',
        query: searchTerm,
        items: result.items,
        next_cursor: result.next_cursor || null,
        has_more: Boolean(result.has_more),
        pagination: {
          limit: numLimit,
          next_cursor: result.next_cursor || null,
          has_more: Boolean(result.has_more),
        },
      };
    }

    default: {
      const err = new Error(`Unsupported search type: '${type}'. Supported types: all, people, jobs, companies, institutes, posts, hashtags`);
      err.statusCode = 400;
      throw err;
    }
  }
}

module.exports = {
  executeSearch,
  executeSearchSubroutine,
};
