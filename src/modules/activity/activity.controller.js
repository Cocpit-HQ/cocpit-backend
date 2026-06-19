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

