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

    // Verify post belongs to authenticated user or their organization and is active
    const postRes = await pool.query(
      'SELECT author_id, author_org_id, is_active, is_deleted, is_removed FROM posts WHERE post_id = $1',
      [postId]
    );
    if (postRes.rowCount === 0) {
      return res.status(404).json({ status: 'error', message: 'Post not found' });
    }

    const {
      author_id: postAuthor,
      author_org_id: postOrg,
      is_active,
      is_deleted,
      is_removed,
    } = postRes.rows[0];
    if (is_active === false || is_deleted === true || is_removed === true) {
      return res.status(404).json({ status: 'error', message: 'Post not found' });
    }

    if (postAuthor !== userId) {
      let isAuthorized = false;
      if (postOrg) {
        const orgMemberCheck = await pool.query(
          'SELECT 1 FROM organization_members WHERE organization_id = $1 AND user_id = $2',
          [postOrg, userId]
        );
        isAuthorized = orgMemberCheck.rowCount > 0;
      }
      if (!isAuthorized) {
        return res
          .status(403)
          .json({ status: 'error', message: 'Unauthorized to view analytics for this post' });
      }
    }

    const data = await postAnalyticsService.getPostAnalyticsData(postId, userId, {
      filter,
      startDate,
      endDate,
    });

    res.status(200).json({ status: 'success', data });
  } catch (err) {
    next(err);
  }
};
