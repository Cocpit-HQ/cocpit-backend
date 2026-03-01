const pool = require("../../core/db/pool");
const { checkBlockStatus } = require("../../core/utils/blockCheck");

// Toggle like on a comment
exports.toggleCommentLike = async (req, res) => {
    const userId = req.user.sub;
    const { commentId } = req.params;

    if (!commentId || !userId) {
        return res.status(400).json({ message: "Comment ID and user ID are required" });
    }

    try {
        // Check if comment exists
        const commentCheck = await pool.query(
            `SELECT comment_id, author_id FROM post_comments WHERE comment_id = $1`,
            [commentId]
        );

        if (commentCheck.rowCount === 0) {
            return res.status(404).json({ message: "Comment not found" });
        }

        const commentAuthorId = commentCheck.rows[0].author_id;
        const isBlocked = await checkBlockStatus(commentAuthorId, userId);
        const hasBlocked = await checkBlockStatus(userId, commentAuthorId);

        if (isBlocked || hasBlocked) {
            return res.status(403).json({ message: "You cannot like this comment" });
        }

        // Check if user already liked this comment
        const existingLike = await pool.query(
            `SELECT * FROM comment_likes WHERE user_id = $1 AND comment_id = $2`,
            [userId, commentId]
        );

        let liked;
        if (existingLike.rowCount > 0) {
            // Unlike: Remove the like
            await pool.query(
                `DELETE FROM comment_likes WHERE user_id = $1 AND comment_id = $2`,
                [userId, commentId]
            );
            liked = false;
        } else {
            // Like: Add the like
            await pool.query(
                `INSERT INTO comment_likes (user_id, comment_id) VALUES ($1, $2)`,
                [userId, commentId]
            );
            liked = true;
        }

        // Get updated like count
        const likeCountResult = await pool.query(
            `SELECT COUNT(*)::int as like_count FROM comment_likes WHERE comment_id = $1`,
            [commentId]
        );

        const likeCount = likeCountResult.rows[0].like_count;

        res.status(200).json({
            liked,
            likeCount,
            message: liked ? "Comment liked" : "Comment unliked"
        });
    } catch (err) {
        console.error("Toggle comment like error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};
