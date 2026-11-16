/**
 * Hashtag Search Query for COCPIT Global Search
 * Queries hashtags with deterministic multi-mode sorting (Trending, Most Popular, Recently Added, Most Used),
 * lexical match precision (Exact/Prefix > Substring), and keyset cursor pagination.
 */

function encodeHashtagCursor(item, sortBy) {
  if (!item) return null;
  const payload = {
    m: sortBy,
    r: typeof item.sort_rank === 'number' ? item.sort_rank : 0,
    v: sortBy === 'most_used' 
        ? (item.usage_count || 0)
        : sortBy === 'recently_added' 
        ? (item.effective_recent_at || item.last_used_at || item.created_at || new Date().toISOString())
        : sortBy === 'trending'
        ? (item.trending_score || 0)
        : (item.posts_count || item.post_count || 0),
    t: (item.tag || '').toLowerCase(),
    id: item.id || item.hashtag_id,
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodeHashtagCursor(cursor) {
  if (!cursor || typeof cursor !== 'string') return null;
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.r === 'number' && typeof parsed.id === 'string') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

async function searchHashtags(client, { searchTerm, limit = 25, cursor = null, queryParams = {} }) {
  let query = (searchTerm || '').trim();
  if (query.startsWith('#')) {
    query = query.slice(1).trim();
  }

  const cleanTerm = query.toLowerCase();
  const cappedLimit = Number(limit) || 25;
  const parsedCursor = decodeHashtagCursor(cursor);

  // Parse sort_by (or sort): 'trending', 'most_popular', 'recently_added', 'most_used'.
  // Default to 'most_popular' matching the UI mockup default.
  const rawSort = (queryParams.sort_by || queryParams.sort || 'most_popular').toLowerCase().replace(/[\s-]/g, '_');
  const validSorts = ['trending', 'most_popular', 'recently_added', 'most_used'];
  const sortBy = validSorts.includes(rawSort) ? rawSort : 'most_popular';

  const params = [];
  let paramIdx = 1;

  let lexicalScoreSql = '0 AS sort_rank';
  let whereSearchClause = '1=1';

  if (cleanTerm) {
    params.push(`%${cleanTerm}%`);
    const likeIdx = paramIdx++;
    params.push(`${cleanTerm}%`);
    const prefixIdx = paramIdx++;

    whereSearchClause = `LOWER(h.tag) LIKE $${likeIdx}`;
    lexicalScoreSql = `CASE WHEN LOWER(h.tag) LIKE $${prefixIdx} THEN 0 ELSE 1 END AS sort_rank`;
  }

  // Cursor pagination conditions
  let cursorCondition = '';
  if (parsedCursor) {
    params.push(parsedCursor.r);
    const cRankIdx = paramIdx++;

    if (sortBy === 'recently_added') {
      const cursorDate = parsedCursor.v && !isNaN(Date.parse(parsedCursor.v))
        ? new Date(parsedCursor.v)
        : new Date(0);
      params.push(cursorDate, parsedCursor.id);
      const cDateIdx = paramIdx++;
      const cIdIdx = paramIdx++;

      cursorCondition = `
        AND (
          (sort_rank > $${cRankIdx})
          OR (sort_rank = $${cRankIdx} AND (effective_recent_at < $${cDateIdx} OR effective_recent_at IS NULL))
          OR (sort_rank = $${cRankIdx} AND effective_recent_at = $${cDateIdx} AND h.hashtag_id < $${cIdIdx})
        )
      `;
    } else {
      params.push(Number(parsedCursor.v) || 0, parsedCursor.t || '', parsedCursor.id);
      const cValIdx = paramIdx++;
      const cTagIdx = paramIdx++;
      const cIdIdx = paramIdx++;

      const metricCol = sortBy === 'most_used' 
        ? 'COALESCE(h.usage_count, 0)'
        : sortBy === 'trending'
        ? 'trending_score'
        : 'COALESCE(h.posts_count, 0)';

      cursorCondition = `
        AND (
          (sort_rank > $${cRankIdx})
          OR (sort_rank = $${cRankIdx} AND ${metricCol} < $${cValIdx})
          OR (sort_rank = $${cRankIdx} AND ${metricCol} = $${cValIdx} AND LOWER(h.tag) > $${cTagIdx})
          OR (sort_rank = $${cRankIdx} AND ${metricCol} = $${cValIdx} AND LOWER(h.tag) = $${cTagIdx} AND h.hashtag_id > $${cIdIdx})
        )
      `;
    }
  }

  // Order clause based on chosen mode
  let orderSql = '';
  let trendingSelect = '';

  switch (sortBy) {
    case 'trending':
      trendingSelect = `
        (
          CASE 
            WHEN h.last_used_at >= NOW() - INTERVAL '24 hours' THEN 100
            WHEN h.last_used_at >= NOW() - INTERVAL '7 days' THEN 40
            ELSE 0
          END + COALESCE(h.posts_count, 0)
        ) AS trending_score,
      `;
      orderSql = `ORDER BY sort_rank ASC, trending_score DESC, COALESCE(h.usage_count, 0) DESC, LOWER(h.tag) ASC, h.hashtag_id ASC`;
      break;

    case 'recently_added':
      orderSql = `ORDER BY sort_rank ASC, effective_recent_at DESC NULLS LAST, h.hashtag_id DESC`;
      break;

    case 'most_used':
      orderSql = `ORDER BY sort_rank ASC, COALESCE(h.usage_count, 0) DESC, COALESCE(h.posts_count, 0) DESC, LOWER(h.tag) ASC, h.hashtag_id ASC`;
      break;

    case 'most_popular':
    default:
      orderSql = `ORDER BY sort_rank ASC, COALESCE(h.posts_count, 0) DESC, COALESCE(h.usage_count, 0) DESC, LOWER(h.tag) ASC, h.hashtag_id ASC`;
      break;
  }

  const fetchLimit = cappedLimit + 1;
  params.push(fetchLimit);
  const limitIdx = paramIdx++;

  const sql = `
    WITH candidate_tags AS (
      SELECT 
        h.hashtag_id,
        h.tag,
        COALESCE(h.usage_count, 0) AS usage_count,
        COALESCE(h.posts_count, 0) AS posts_count,
        h.created_at,
        h.last_used_at,
        COALESCE(h.last_used_at, h.created_at) AS effective_recent_at,
        ${trendingSelect}
        ${lexicalScoreSql}
      FROM hashtags h
      WHERE ${whereSearchClause}
    )
    SELECT *
    FROM candidate_tags h
    WHERE 1=1
      ${cursorCondition}
    ${orderSql}
    LIMIT $${limitIdx};
  `;

  const { rows } = await client.query(sql, params);
  const hasMore = rows.length > cappedLimit;
  const items = hasMore ? rows.slice(0, cappedLimit) : rows;

  let nextCursor = null;
  if (hasMore && items.length > 0) {
    const lastItem = items[items.length - 1];
    nextCursor = encodeHashtagCursor(lastItem, sortBy);
  }

  const formattedItems = items.map(item => {
    let postsDisplay = '0 posts';
    const count = item.posts_count || item.usage_count || 0;
    if (count >= 1000) {
      postsDisplay = `${(count / 1000).toFixed(1)}k posts`;
    } else {
      postsDisplay = `${count} post${count === 1 ? '' : 's'}`;
    }

    return {
      id: item.hashtag_id,
      tag: item.tag,
      display_tag: item.tag.startsWith('#') ? item.tag : `#${item.tag}`,
      usage_count: item.usage_count,
      post_count: count,
      posts_count: count,
      posts_display: postsDisplay,
      created_at: item.created_at,
      last_used_at: item.last_used_at,
      effective_recent_at: item.effective_recent_at,
      sort_rank: item.sort_rank,
      trending_score: item.trending_score,
    };
  });

  return {
    items: formattedItems,
    has_more: hasMore,
    next_cursor: nextCursor,
  };
}

module.exports = {
  searchHashtags,
  encodeHashtagCursor,
  decodeHashtagCursor,
};
