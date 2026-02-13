const pool = require("../db/pool");

// 1️⃣ Toggle Save / Unsave
exports.toggleSavePost = async (req, res) => {
    const { postId } = req.params;
    const userId = req.user.sub;

    try {
        // Check if already saved
        const existing = await pool.query(
            `SELECT 1 FROM saved_post 
             WHERE user_id = $1 AND post_id = $2`,
            [userId, postId]
        );

        if (existing.rows.length > 0) {
            // Unsave
            await pool.query(
                `DELETE FROM saved_post 
                 WHERE user_id = $1 AND post_id = $2`,
                [userId, postId]
            );

            return res.status(200).json({
                success: true,
                saved: false,
                message: "Post unsaved"
            });
        }

        // Save
        await pool.query(
            `INSERT INTO saved_post (user_id, post_id)
             VALUES ($1, $2)`,
            [userId, postId]
        );

        return res.status(200).json({
            success: true,
            saved: true,
            message: "Post saved"
        });

    } catch (error) {
        console.error("Toggle Save Error:", error);
        return res.status(500).json({
            success: false,
            message: "Server error"
        });
    }
};

// 2️⃣ Get Saved Posts
exports.getSavedPosts = async (req, res) => {
    const userId = req.user.sub;

    try {
        const result = await pool.query(
            `SELECT 
                p.*, 
                sp.saved_at,
                u.full_name AS author_name, 
                u.avatar_url AS author_avatar,
                COALESCE(
                    (SELECT json_agg(json_build_object('url', pm.url, 'media_type', pm.media_type)) 
                     FROM post_media pm WHERE pm.post_id = p.post_id),
                    '[]'::json
                ) AS media,
                (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.post_id)::int AS like_count,
                (SELECT COUNT(*) FROM post_comments pc WHERE pc.post_id = p.post_id)::int AS comment_count
             FROM saved_post sp
             JOIN posts p ON p.post_id = sp.post_id
             JOIN users u ON u.user_id = p.author_id
             WHERE sp.user_id = $1
             ORDER BY sp.saved_at DESC`,
            [userId]
        );

        return res.status(200).json({
            success: true,
            posts: result.rows
        });

    } catch (error) {
        console.error("Get Saved Posts Error:", error);
        return res.status(500).json({
            success: false,
            message: "Server error"
        });
    }
};

// 3️⃣ Check if Post is Saved
exports.checkIfPostSaved = async (req, res) => {
    const { postId } = req.params;
    const userId = req.user.sub;

    try {
        const result = await pool.query(
            `SELECT 1 FROM saved_post
             WHERE user_id = $1 AND post_id = $2`,
            [userId, postId]
        );

        return res.status(200).json({
            success: true,
            isSaved: result.rows.length > 0
        });

    } catch (error) {
        console.error("Check Saved Error:", error);
        return res.status(500).json({
            success: false,
            message: "Server error"
        });
    }
};
