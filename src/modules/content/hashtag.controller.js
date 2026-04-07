const pool = require("../../core/db/pool");
const redisClient = require("../../core/db/redis");
const { getPostHydrationSelect, getPostHydrationJoins, getPublicFeedWhere } = require("../../core/queries/postHydration.query");

const getRequestedOrganizationActorId = (req, fallbackOrgId = null) => {
    const actorOrgId = req.actor?.type === "ORGANIZATION" ? req.actor.orgId : null;
    if (actorOrgId) {
        if (fallbackOrgId && actorOrgId !== fallbackOrgId) {
            const err = new Error("Active organization actor does not match requested organization");
            err.statusCode = 403;
            throw err;
        }
        return actorOrgId;
    }
    return fallbackOrgId;
};

const getContentActorScope = (req, fallbackOrgId = null) => {
    const userId = req.user?.sub || req.user?.user_id;
    const orgId = getRequestedOrganizationActorId(req, fallbackOrgId);
    return { userId, orgId, isOrgActor: !!orgId };
};

exports.getHashtagPosts = async (req, res) => {
    const { tag } = req.params;
    const { cursorPostId, companyId: requestedCompanyId, limit = 10 } = req.query;

    const lowerTag = (tag || "").toLowerCase().replace(/^#/, '');

    if (!lowerTag || lowerTag.length < 2 || lowerTag.length > 30) {
        return res.status(400).json({ message: "Invalid hashtag" });
    }

    try {
        const actorScope = getContentActorScope(req, requestedCompanyId || null);
        const userParamIdx = 1;
        const companyParamIdx = 2;
        const tagParamIdx = 3;

        // 1. Get Tag Metadata (real post count from post_hashtags)
        const tagRes = await pool.query(
            `SELECT h.tag, COUNT(ph.post_id)::int as usage_count
             FROM hashtags h
             LEFT JOIN post_hashtags ph ON ph.hashtag_id = h.hashtag_id
             LEFT JOIN posts p ON p.post_id = ph.post_id
             WHERE lower(h.tag) = $1
             GROUP BY h.hashtag_id, h.tag`,
            [lowerTag]
        );
        const tagMetadata = tagRes.rows[0] || { tag: lowerTag, usage_count: 0 };

        // 2. Hydrate Feed
        const query = `
            SELECT
                ${getPostHydrationSelect(companyParamIdx, userParamIdx)}
            ${getPostHydrationJoins()}
            JOIN post_hashtags ph ON ph.post_id = p.post_id
            JOIN hashtags h ON h.hashtag_id = ph.hashtag_id
            ${getPublicFeedWhere(userParamIdx)}
            AND h.tag = $${tagParamIdx}
            ${cursorPostId ? `AND p.created_at < (SELECT created_at FROM posts WHERE post_id = $4)` : ''}
            ORDER BY p.created_at DESC, p.post_id DESC
            LIMIT $${cursorPostId ? 5 : 4}
        `;

        const params = [actorScope.userId, actorScope.orgId || null, lowerTag];
        if (cursorPostId) {
            params.push(cursorPostId);
            params.push(parseInt(limit, 10));
        } else {
            params.push(parseInt(limit, 10));
        }

        const { rows } = await pool.query(query, params);
        const last = rows[rows.length - 1];

        res.json({
            posts: rows,
            nextCursor: last ? { cursorPostId: last.post_id } : null,
            hashtag: tagMetadata
        });
    } catch (err) {
        console.error("Error in getHashtagPosts:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.getTrendingHashtags = async (req, res) => {
    try {
        let tagNames = [];

        // Use Redis for trending order (which tags are hot)
        if (redisClient.isOpen) {
            try {
                const trending = await redisClient.zRevRangeWithScores("trending_hashtags", 0, 9);
                tagNames = trending.map(t => t.value);
            } catch (redisErr) {
                console.warn("Redis trending fetch failed, falling back to DB:", redisErr.message);
            }
        }

        // Fallback: get top hashtags from DB directly (24h window)
        if (tagNames.length === 0) {
            const { rows } = await pool.query(`
                SELECT h.tag, COUNT(ph.post_id)::int as usage_count
                FROM hashtags h
                JOIN post_hashtags ph ON ph.hashtag_id = h.hashtag_id
                JOIN posts p ON p.post_id = ph.post_id
                WHERE p.created_at > NOW() - INTERVAL '24 hours'
                GROUP BY h.hashtag_id, h.tag
                ORDER BY usage_count DESC
                LIMIT 10
            `);
            return res.json({ tags: rows });
        }

        // Get actual post counts from DB for the trending tags
        const { rows } = await pool.query(`
            SELECT h.tag, COUNT(ph.post_id)::int as usage_count
            FROM hashtags h
            LEFT JOIN post_hashtags ph ON ph.hashtag_id = h.hashtag_id
            LEFT JOIN posts p ON p.post_id = ph.post_id
            WHERE h.tag = ANY($1)
            GROUP BY h.hashtag_id, h.tag
        `, [tagNames]);

        // Maintain Redis ordering but use real counts
        const countMap = new Map(rows.map(r => [r.tag, r.usage_count]));
        const formatted = tagNames
            .map(tag => ({ tag, usage_count: countMap.get(tag) || 0 }))
            .filter(t => t.usage_count > 0);

        res.json({ tags: formatted });
    } catch (err) {
        console.error("Error in getTrendingHashtags:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.searchHashtags = async (req, res) => {
    let { q } = req.query;
    if (!q || q.length < 1) return res.json({ tags: [] });

    // Remove leading # if present and lowercase/trim
    const query = q.startsWith('#') ? q.slice(1).trim().toLowerCase() : q.trim().toLowerCase();
    
    // If query is just "#", show trending hashtags instead of "No matches"
    if (query.length < 1) {
        try {
            const { rows } = await pool.query(`
                SELECT h.tag, COALESCE(usage_count, 0) as usage_count, posts_count, last_used_at
                FROM hashtags h
                WHERE COALESCE(usage_count, 0) > 0
                ORDER BY usage_count DESC, last_used_at DESC NULLS LAST
                LIMIT 10
            `);
            return res.json({ tags: rows, source: 'trending_fallback' });
        } catch (err) {
            return res.json({ tags: [] });
        }
    }

    const cacheKey = `hashtag_search:${query}`;

    try {
        // 1. Check Redis Cache (Non-blocking)
        if (redisClient.isOpen) {
            try {
                const cached = await redisClient.get(cacheKey);
                if (cached) {
                    return res.json({ tags: JSON.parse(cached), source: 'cache' });
                }
            } catch (cacheErr) {
                console.warn("[searchHashtags] Redis cache fetch failed:", cacheErr.message);
            }
        }

        // 2. Complex Scoring Query (Instagram-like)
        // Match: Exact (100) > Prefix (70) > Partial (40)
        // Popularity: usage_count is primary ranking factor (weight 0.7)
        // Recency: minor tiebreaker (weight 0.3)
        const { rows } = await pool.query(`
            SELECT 
                tag, 
                COALESCE(usage_count, 0) as usage_count, 
                COALESCE(posts_count, 0) as posts_count,
                last_used_at,
                (
                    CASE 
                        WHEN lower(tag) = $1 THEN 100
                        WHEN lower(tag) LIKE $1 || '%' THEN 70
                        WHEN lower(tag) LIKE '%' || $1 || '%' THEN 40
                        ELSE 0
                    END
                    + COALESCE(usage_count, 0) * 5
                    + CASE 
                        WHEN last_used_at > NOW() - INTERVAL '1 day' THEN 10
                        WHEN last_used_at > NOW() - INTERVAL '7 days' THEN 5
                        ELSE 0
                    END
                ) AS score
            FROM hashtags 
            WHERE tag ILIKE '%' || $1 || '%'
            ORDER BY score DESC, usage_count DESC NULLS LAST
            LIMIT 10
        `, [query]);

        // 3. Cache results for 60 seconds (Non-blocking)
        if (redisClient.isOpen && rows.length > 0) {
            try {
                // Determine if we need specialized set logic based on proxy limitations
                await redisClient.set(cacheKey, JSON.stringify(rows));
                await redisClient.expire(cacheKey, 60);
            } catch (cacheErr) {
                console.warn("[searchHashtags] Redis cache set failed:", cacheErr.message);
            }
        }

        res.json({ tags: rows, source: 'db' });
    } catch (err) {
        console.error("Error in searchHashtags:", err);
        res.status(500).json({ 
            message: "Internal server error",
            details: process.env.NODE_ENV === 'development' ? err.message : undefined 
        });
    }
};
