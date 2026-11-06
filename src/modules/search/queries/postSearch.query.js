/**
 * Post Search Query for COCPIT Global Search
 * Queries public discoverable posts with partial GIN trigram index,
 * multi-signal LinkedIn-grade relevance scoring (lexical + social affinity + engagement + recency),
 * date/content-type filtering, post category personal privacy checks,
 * broadcast verification, and bidirectional block enforcement.
 */
const { getPostHydrationSelect, getPostHydrationJoins } = require('../../../core/queries/postHydration.query');

function encodePostCursor(item, rank) {
  if (!item) return null;
  const payload = {
    s: typeof rank === 'number' ? rank : (item.relevance_score ?? 0),
    t: item.created_at,
    id: item.post_id || item.id,
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodePostCursor(cursor) {
  if (!cursor || typeof cursor !== 'string') return null;
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(raw);
    if (parsed.t && parsed.id && !isNaN(Date.parse(parsed.t))) {
      return {
        s: typeof parsed.s === 'number' ? parsed.s : 0,
        t: parsed.t,
        id: parsed.id,
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function searchPosts(client, { searchTerm, viewerId, orgActorId = null, limit = 10, cursor = null, queryParams = {} }) {
  const trimmed = searchTerm.trim().replace(/^['"]|['"]$/g, '');
  const likeTerm = `%${trimmed}%`;
  const prefixTerm = `${trimmed}%`;
  const parsedCursor = decodePostCursor(cursor);
  const sortBy = (queryParams.sort_by || '').toLowerCase();
  const isLatestSort = sortBy === 'latest';

  // $1 = likeTerm, $2 = viewerId, $3 = orgActorId, $4 = prefixTerm
  const params = [likeTerm, viewerId || null, orgActorId || null, prefixTerm];
  let currentIdx = 5;

  // 1. Scoring Expression
  const scoreSql = `(
    CASE
      WHEN p.title IS NOT NULL AND LOWER(p.title) LIKE LOWER($4) THEN 120
      WHEN LOWER(p.content) LIKE LOWER($4) THEN 100
      WHEN LOWER(p.content) LIKE LOWER($1) THEN 60
      ELSE 20
    END
    +
    CASE
      WHEN $2::uuid IS NOT NULL AND (
        EXISTS (SELECT 1 FROM followers WHERE follower_id = $2::uuid AND following_id = p.author_id)
        OR (p.author_org_id IS NOT NULL AND EXISTS (SELECT 1 FROM organization_followers WHERE user_id = $2::uuid AND org_id = p.author_org_id))
      ) THEN 60
      WHEN $2::uuid IS NOT NULL AND EXISTS (
        SELECT 1 FROM followers f1 
        JOIN followers f2 ON f1.follower_id = f2.following_id AND f1.following_id = f2.follower_id
        WHERE f1.follower_id = $2::uuid AND f1.following_id = p.author_id
      ) THEN 40
      ELSE 0
    END
    +
    (
      LEAST(COALESCE((SELECT COUNT(*) FROM active_post_likes pl WHERE pl.post_id = p.post_id), 0), 50) * 2 +
      LEAST(COALESCE((SELECT COUNT(*) FROM active_post_comments ac WHERE ac.post_id = p.post_id), 0), 30) * 3
    )
    +
    CASE
      WHEN p.created_at >= NOW() - INTERVAL '24 hours' THEN 50
      WHEN p.created_at >= NOW() - INTERVAL '7 days' THEN 30
      WHEN p.created_at >= NOW() - INTERVAL '30 days' THEN 15
      ELSE 0
    END
  )`;

  // 2. Keyset Cursor Clause
  let cursorClause = '';
  if (parsedCursor) {
    if (isLatestSort) {
      params.push(new Date(parsedCursor.t), parsedCursor.id);
      cursorClause = `
        AND (
          p.created_at < $${currentIdx} 
          OR (p.created_at = $${currentIdx} AND p.post_id < $${currentIdx + 1})
        )
      `;
      currentIdx += 2;
    } else {
      params.push(parsedCursor.s, new Date(parsedCursor.t), parsedCursor.id);
      const sIdx = currentIdx;
      const tIdx = currentIdx + 1;
      const idIdx = currentIdx + 2;
      cursorClause = `
        AND (
          ${scoreSql} < $${sIdx}
          OR (${scoreSql} = $${sIdx} AND (p.created_at < $${tIdx} OR (p.created_at = $${tIdx} AND p.post_id < $${idIdx})))
        )
      `;
      currentIdx += 3;
    }
  }

  // 3. Date Posted Filter Clause
  let dateFilterClause = '';
  const datePosted = (queryParams.date_posted || '').toLowerCase();
  if (datePosted === 'past_24h' || datePosted === '24h') {
    dateFilterClause = `AND p.created_at >= NOW() - INTERVAL '24 hours'`;
  } else if (datePosted === 'past_week' || datePosted === 'week') {
    dateFilterClause = `AND p.created_at >= NOW() - INTERVAL '7 days'`;
  } else if (datePosted === 'past_month' || datePosted === 'month') {
    dateFilterClause = `AND p.created_at >= NOW() - INTERVAL '30 days'`;
  }

  // 4. Content Type Filter Clause (supports multi-select)
  let contentTypeClause = '';
  const rawContentType = queryParams.content_type || queryParams.contentType;
  if (rawContentType) {
    const types = (Array.isArray(rawContentType)
      ? rawContentType
      : String(rawContentType).split(/[,|]/)
    )
      .map(t => String(t).trim().toLowerCase())
      .filter(Boolean);

    if (types.length > 0) {
      const typeConditions = [];
      types.forEach(t => {
        if (t === 'text') {
          typeConditions.push(`(
            (p.post_type IS NULL OR p.post_type::text IN ('text', 'normal'))
            AND p.shared_post_id IS NULL
            AND (pc.name IS NULL OR pc.name != 'Article')
            AND NOT EXISTS (SELECT 1 FROM post_media pm WHERE pm.post_id = p.post_id)
            AND NOT EXISTS (SELECT 1 FROM post_polls pp WHERE pp.post_id = p.post_id)
          )`);
        } else if (t === 'image' || t === 'images') {
          typeConditions.push(`(p.post_type::text IN ('image', 'images') OR EXISTS (SELECT 1 FROM post_media pm WHERE pm.post_id = p.post_id AND pm.media_type = 'image'))`);
        } else if (t === 'video' || t === 'videos') {
          typeConditions.push(`(p.post_type::text IN ('video', 'videos') OR EXISTS (SELECT 1 FROM post_media pm WHERE pm.post_id = p.post_id AND pm.media_type = 'video'))`);
        } else if (t === 'poll' || t === 'polls') {
          typeConditions.push(`(p.post_type::text IN ('poll', 'polls') OR EXISTS (SELECT 1 FROM post_polls pp WHERE pp.post_id = p.post_id))`);
        } else if (t === 'article' || t === 'articles') {
          typeConditions.push(`(p.post_type::text IN ('article', 'articles') OR (pc.name IS NOT NULL AND pc.name = 'Article'))`);
        } else if (t === 'repost' || t === 'reposts') {
          typeConditions.push(`p.shared_post_id IS NOT NULL`);
        }
      });

      if (typeConditions.length > 0) {
        contentTypeClause = `AND (${typeConditions.join(' OR ')})`;
      }
    }
  }

  // 5. Hashtags Filter Clause
  let hashtagClause = '';
  const rawHashtags = queryParams.hashtag || queryParams.hashtags || queryParams.tag;
  if (rawHashtags) {
    const tagArray = (Array.isArray(rawHashtags)
      ? rawHashtags
      : String(rawHashtags).split(/[,|]/)
    )
      .map(t => String(t).trim().replace(/^#/, '').toLowerCase())
      .filter(Boolean);

    if (tagArray.length > 0) {
      params.push(tagArray);
      hashtagClause = `
        AND EXISTS (
          SELECT 1 FROM post_hashtags ph
          JOIN hashtags h ON h.hashtag_id = ph.hashtag_id
          WHERE ph.post_id = p.post_id
            AND LOWER(h.tag) = ANY($${currentIdx}::text[])
        )
      `;
      currentIdx++;
    }
  }

  // 6. Posted By Filter Clause (connections | followers | others) - supports multi-select
  let postedByClause = '';
  const rawPostedBy = queryParams.posted_by || queryParams.postedBy;
  if (rawPostedBy) {
    const postedByList = (Array.isArray(rawPostedBy)
      ? rawPostedBy
      : String(rawPostedBy).split(/[,|]/)
    )
      .map(p => String(p).trim().toLowerCase())
      .filter(Boolean);

    if (postedByList.length > 0) {
      const postedByConditions = [];

      postedByList.forEach(pb => {
        if (pb === 'connections') {
          postedByConditions.push(`(
            p.author_org_id IS NULL AND
            $2::uuid IS NOT NULL AND (
              EXISTS (
                SELECT 1 FROM connections c 
                WHERE (c.user_id = $2::uuid AND c.connected_user_id = p.author_id)
                   OR (c.user_id = p.author_id AND c.connected_user_id = $2::uuid)
              )
              OR EXISTS (
                SELECT 1 FROM followers f1 
                JOIN followers f2 ON f1.follower_id = f2.following_id AND f1.following_id = f2.follower_id 
                WHERE f1.follower_id = $2::uuid AND f1.following_id = p.author_id
              )
            )
          )`);
        } else if (pb === 'followers') {
          postedByConditions.push(`(
            ($2::uuid IS NOT NULL AND (
              p.author_org_id IS NULL AND EXISTS (
                SELECT 1 FROM followers f WHERE f.follower_id = p.author_id AND f.following_id = $2::uuid
              )
            ))
            OR ($3::uuid IS NOT NULL AND (
              p.author_org_id IS NULL AND EXISTS (
                SELECT 1 FROM organization_followers ofol WHERE ofol.user_id = p.author_id AND ofol.org_id = $3::uuid
              )
            ))
          )`);
        } else if (pb === 'others') {
          postedByConditions.push(`(
            ($2::uuid IS NULL OR (
              NOT EXISTS (
                SELECT 1 FROM connections c 
                WHERE (c.user_id = $2::uuid AND c.connected_user_id = p.author_id)
                   OR (c.user_id = p.author_id AND c.connected_user_id = $2::uuid)
              )
              AND NOT EXISTS (
                SELECT 1 FROM followers f1 
                JOIN followers f2 ON f1.follower_id = f2.following_id AND f1.following_id = f2.follower_id 
                WHERE f1.follower_id = $2::uuid AND f1.following_id = p.author_id
              )
              AND NOT EXISTS (
                SELECT 1 FROM followers f WHERE f.follower_id = p.author_id AND f.following_id = $2::uuid
              )
            ))
            AND ($3::uuid IS NULL OR NOT EXISTS (
              SELECT 1 FROM organization_followers ofol WHERE ofol.user_id = p.author_id AND ofol.org_id = $3::uuid
            ))
          )`);
        }
      });

      if (postedByConditions.length > 0) {
        postedByClause = `AND (${postedByConditions.join(' OR ')})`;
      }
    }
  }

  const fetchLimit = Number(limit) + 1;
  params.push(fetchLimit);
  const limitIdx = currentIdx;

  const orderClause = isLatestSort
    ? `ORDER BY p.created_at DESC, p.post_id DESC`
    : `ORDER BY relevance_score DESC, p.created_at DESC, p.post_id DESC`;

  // Selective public discovery predicate strictly compatible with idx_posts_content_trgm
  const sql = `
    SELECT
      ${getPostHydrationSelect(3, 2)},
      ${scoreSql} AS relevance_score
    ${getPostHydrationJoins()}
    WHERE p.visibility = 'public'
      AND p.is_active = TRUE
      AND (p.is_removed IS FALSE OR p.is_removed IS NULL)
      AND (p.is_deleted IS FALSE OR p.is_deleted IS NULL)
      AND (p.is_unlisted IS FALSE OR p.is_unlisted IS NULL)
      AND (p.status IS NULL OR p.status = 'published')
      AND p.content ILIKE $1
      ${dateFilterClause}
      ${contentTypeClause}
      ${hashtagClause}
      ${postedByClause}
      -- Personal category privacy check (connections & author only)
      AND (
        pc.name != 'Personal' OR pc.name IS NULL
        OR (pc.name = 'Personal' AND (
          ($2::uuid IS NOT NULL AND p.author_id = $2::uuid)
          OR EXISTS (
            SELECT 1 FROM followers f1 
            JOIN followers f2 ON f1.follower_id = f2.following_id AND f1.following_id = f2.follower_id 
            WHERE f1.follower_id = $2::uuid AND f1.following_id = p.author_id
          )
        ))
      )
      -- Broadcast scope check (child org members & followers only)
      AND (
        p.is_broadcast IS FALSE OR p.is_broadcast IS NULL
        OR (
          p.is_broadcast = TRUE AND p.author_org_id IN (
            SELECT o.parent_org_id FROM organizations o 
            JOIN organization_members om ON om.org_id = o.org_id 
            WHERE om.user_id = $2::uuid AND om.status = 'ACTIVE' AND o.parent_org_id IS NOT NULL
            UNION
            SELECT o.parent_org_id FROM organizations o 
            JOIN organization_followers ofol ON ofol.org_id = o.org_id 
            WHERE ofol.user_id = $2::uuid AND o.parent_org_id IS NOT NULL
          )
        )
      )
      -- Bidirectional block check
      AND NOT EXISTS (
        SELECT 1 FROM blocks b 
        WHERE (
          -- When viewing as company
          ($3::uuid IS NOT NULL AND (
            (b.is_org_block = true AND ((b.blocker_id = $3::uuid AND b.blocked_id = p.author_id) OR (b.blocker_id = p.author_id AND b.blocked_id = $3::uuid)))
            OR
            (p.author_org_id IS NOT NULL AND ((b.blocker_id = p.author_org_id AND b.blocked_id = $3::uuid) OR (b.blocker_id = $3::uuid AND b.blocked_id = p.author_org_id)))
          ))
          OR
          -- When viewing as individual user
          ($3::uuid IS NULL AND $2::uuid IS NOT NULL AND (
            (b.is_org_block = false AND ((b.blocker_id = $2::uuid AND b.blocked_id = p.author_id) OR (b.blocker_id = p.author_id AND b.blocked_id = $2::uuid)))
            OR
            (p.author_org_id IS NOT NULL AND ((b.blocker_id = p.author_org_id AND b.blocked_id = $2::uuid) OR (b.blocker_id = $2::uuid AND b.blocked_id = p.author_org_id)))
          ))
        )
      )
      ${cursorClause}
    ${orderClause}
    LIMIT $${limitIdx};
  `;

  const { rows } = await client.query(sql, params);
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;

  let nextCursor = null;
  if (hasMore && items.length > 0) {
    const lastItem = items[items.length - 1];
    nextCursor = encodePostCursor(lastItem, lastItem.relevance_score);
  }

  return {
    items,
    has_more: hasMore,
    next_cursor: nextCursor,
  };
}

module.exports = {
  searchPosts,
  encodePostCursor,
  decodePostCursor,
};
