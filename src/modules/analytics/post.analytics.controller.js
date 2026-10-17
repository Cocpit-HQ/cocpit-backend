/**
 * Post Analytics Controller
 */

const pool = require('../../core/db/pool');
const postAnalyticsService = require('./post.analytics.service');

exports.getPostAnalytics = async (req, res, next) => {
    try {
        const userId = req.user?.sub || req.user?.id || req.user?.user_id;
        const { postId } = req.params;
        const { filter, startDate, endDate } = req.query;

        // Verify post belongs to authenticated user
        const postRes = await pool.query('SELECT author_id FROM posts WHERE post_id = $1', [postId]);
        if (postRes.rowCount === 0) {
            return res.status(404).json({ status: 'error', message: 'Post not found' });
        }
        
        // Handle variations in author_id vs user_id in posts table schema
        const postAuthor = postRes.rows[0].author_id;
        if (postAuthor !== userId) {
            return res.status(403).json({ status: 'error', message: 'Unauthorized to view analytics for this post' });
        }
        
        const data = await postAnalyticsService.getPostAnalyticsData(postId, userId, { filter, startDate, endDate });
        
        res.status(200).json({ status: 'success', data });
    } catch (err) {
        next(err);
    }
};
