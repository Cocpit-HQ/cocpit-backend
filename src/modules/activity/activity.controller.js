const pool = require("../../core/db/pool");

/**
 * Get user activity history
 * Supports pagination and type filtering
 */
exports.getActivity = async (req, res) => {
    // Robust userId retrieval (supports both sub and user_id)
    const userId = req.user?.sub || req.user?.user_id || req.user?.id;
    const { type, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    try {
        let entityFilter = "";
        const queryParams = [userId, parseInt(limit), offset];

        // 1. Apply entity filter based on type
        if (type === "posts") {
            entityFilter = "AND log.entity_type IN ('post', 'poll')";
        } else if (type === "likes") {
            entityFilter = "AND log.action_type = 'like_post'";
        } else if (type === "comments") {
            entityFilter = "AND log.action_type = 'comment_post'";
        } else if (type === "reposts") {
            entityFilter = "AND log.action_type = 'repost_post'";
        } else if (type === "jobs") {
            entityFilter = "AND log.entity_type = 'job'";
        } else if (type === "events") {
            entityFilter = "AND log.entity_type = 'event'";
        }


        // 2. Execute unified query with detailed hydration
        // We join across all tables to get titles/names for the "Your Activity" feed
        const result = await pool.query(
            `
            SELECT 
                log.*,
                p.content as post_content,
                u.full_name as post_author_name,
                u.avatar_url as post_author_avatar,
                j.title as job_title,
                j.company_name as job_company_name,
                e.title as event_title,
                e.banner_url as event_banner
            FROM user_activity_log log
            LEFT JOIN posts p ON log.entity_type = 'post' AND log.entity_id = p.post_id
            LEFT JOIN active_users u ON p.author_id = u.user_id
            LEFT JOIN jobs j ON log.entity_type = 'job' AND log.entity_id = j.job_id
            LEFT JOIN events e ON log.entity_type = 'event' AND log.entity_id = e.event_id
            WHERE log.user_id = $1
            ${entityFilter}
            ORDER BY log.created_at DESC
            LIMIT $2 OFFSET $3
            `,
            queryParams
        );

        // Return standardized object for frontend
        res.json({
            activities: result.rows,
            hasMore: result.rows.length === parseInt(limit),
            page: parseInt(page)
        });

    } catch (err) {
        console.error("Get activity error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

/**
 * Clear activity history
 */
exports.clearActivity = async (req, res) => {
    const userId = req.user?.sub || req.user?.user_id;
    const { type } = req.query;

    try {
        let deleteQuery = "DELETE FROM user_activity_log WHERE user_id = $1";
        const params = [userId];

        if (type === "posts") {
            deleteQuery += " AND entity_type IN ('post', 'poll')";
        } else if (type === "jobs") {
            deleteQuery += " AND entity_type = 'job'";
        } else if (type === "events") {
            deleteQuery += " AND entity_type = 'event'";
        }

        await pool.query(deleteQuery, params);
        res.json({ message: "History cleared successfully" });
    } catch (err) {
        console.error("Clear activity error:", err);
        res.status(500).json({ message: "Failed to clear history" });
    }
};

/**
 * Get posts where the user is tagged
 */
exports.getTaggedPosts = async (req, res) => {
    const userId = req.user?.sub || req.user?.user_id;
    const { page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    try {
        const countRes = await pool.query(
            `SELECT COUNT(*) FROM post_tags WHERE tagged_user_id = $1 AND is_active_tag = true`,
            [userId]
        );
        const total = parseInt(countRes.rows[0].count);

        const result = await pool.query(
            `SELECT pt.tag_id, pt.post_id, pt.updated_at AS tagged_at,
                    p.content AS post_content, p.created_at AS post_created_at,
                    u.user_id AS author_id, u.full_name AS author_name,
                    u.avatar_url AS author_avatar, u.account_name AS author_slug
             FROM post_tags pt
             JOIN posts p ON pt.post_id = p.post_id
             JOIN active_users u ON p.author_id = u.user_id
             WHERE pt.tagged_user_id = $1 AND pt.is_active_tag = true
             ORDER BY pt.updated_at DESC
             LIMIT $2 OFFSET $3`,
            [userId, parseInt(limit), offset]
        );

        res.json({
            activities: result.rows,
            hasMore: offset + result.rows.length < total,
            page: parseInt(page),
            total
        });
    } catch (err) {
        console.error("Get tagged activity error:", err);
        res.status(500).json({ message: "Failed to fetch tagged activity" });
    }
};

/**
 * Untag self from a post
 */
exports.removeTag = async (req, res) => {
    const userId = req.user?.sub || req.user?.user_id;
    const { postId } = req.params;

    try {
        const result = await pool.query(
            `UPDATE post_tags
             SET is_active_tag = false, updated_at = NOW()
             WHERE post_id = $1 AND tagged_user_id = $2
             RETURNING tag_id`,
            [postId, userId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ message: "Active tag not found on this post" });
        }

        res.json({ message: "Tag removed successfully" });
    } catch (err) {
        console.error("Remove tag error:", err);
        res.status(500).json({ message: "Failed to remove tag" });
    }
};

