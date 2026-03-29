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

        // Get matching post IDs (lightweight query)
        // Ideally cached, but running direct DB for safety to respect strict chronological order first.
        // Caching post visibility is heavily tied to user ID. We will restrict the fetched pool via DB safely.
        
        // Construct the full hydration query enforcing visibility on the tag.
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
            nextCursor: last ? { cursorPostId: last.post_id } : null
        });
    } catch (err) {
        console.error("Error in getHashtagPosts:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.getTrendingHashtags = async (req, res) => {
    if (!redisClient.isOpen) {
        return res.json({ tags: [] });
    }
    
    try {
        const trending = await redisClient.zRevRangeWithScores("trending_hashtags", 0, 9);
        const formatted = trending.map(t => ({
            tag: t.value,
            usage_count: typeof t.score === 'number' ? t.score : parseFloat(t.score)
        }));
        
        res.json({ tags: formatted });
    } catch (err) {
        console.error("Error in getTrendingHashtags:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.searchHashtags = async (req, res) => {
    const { q } = req.query;
    if (!q || q.length < 2) return res.json({ tags: [] });

    try {
        const { rows } = await pool.query(`
            SELECT tag, usage_count 
            FROM hashtags 
            WHERE tag ILIKE $1
            ORDER BY usage_count DESC
            LIMIT 10
        `, [`${q.toLowerCase()}%`]);

        res.json({ tags: rows });
    } catch (err) {
        console.error("Error in searchHashtags:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};
