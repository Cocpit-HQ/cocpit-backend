const pool = require('../../../core/db/pool');
const redis = require('../../../core/cache/redis');

// GET /api/admin/feed/metrics
exports.getFeedMetrics = async (req, res) => {
  try {
    // Parse date range (default to last 30 days)
    const end = req.query.endDate ? new Date(req.query.endDate) : new Date();
    const start = req.query.startDate ? new Date(req.query.startDate) : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);

    // 1. Total Daily Activity Volume (posts created today in UTC)
    const dailyVolumeRes = await pool.query(
      "SELECT COUNT(*) FROM posts WHERE created_at >= NOW() - INTERVAL '24 hours'"
    );
    const dailyActivityVolume = parseInt(dailyVolumeRes.rows[0].count, 10);

    // 2. Engagement Rate calculation:
    // (Total Likes + Total Comments + Total Shares in period) / (Active Users in period)
    const activeUsersRes = await pool.query(
      "SELECT COUNT(DISTINCT user_id) FROM user_activity_log WHERE created_at >= $1 AND created_at <= $2",
      [start.toISOString(), end.toISOString()]
    );
    const activeUsersCount = parseInt(activeUsersRes.rows[0].count, 10) || 1; // avoid divide by zero

    const likesCountRes = await pool.query(
      "SELECT COUNT(*) FROM post_likes WHERE created_at >= $1 AND created_at <= $2",
      [start.toISOString(), end.toISOString()]
    );
    const commentsCountRes = await pool.query(
      "SELECT COUNT(*) FROM post_comments WHERE created_at >= $1 AND created_at <= $2",
      [start.toISOString(), end.toISOString()]
    );
    const sharesCountRes = await pool.query(
      "SELECT COUNT(*) FROM post_shares WHERE created_at >= $1 AND created_at <= $2",
      [start.toISOString(), end.toISOString()]
    );

    const totalLikes = parseInt(likesCountRes.rows[0].count, 10);
    const totalComments = parseInt(commentsCountRes.rows[0].count, 10);
    const totalShares = parseInt(sharesCountRes.rows[0].count, 10);
    const totalInteractions = totalLikes + totalComments + totalShares;

    const engagementRate = activeUsersCount > 0 
      ? parseFloat(((totalInteractions / activeUsersCount) * 100).toFixed(1)) 
      : 0;

    // 3. Avg Engagement per Post (interactions / total posts in period)
    const postsCountRes = await pool.query(
      "SELECT COUNT(*) FROM posts WHERE created_at >= $1 AND created_at <= $2",
      [start.toISOString(), end.toISOString()]
    );
    const totalPosts = parseInt(postsCountRes.rows[0].count, 10) || 1;
    const avgEngagementPerPost = parseFloat((totalInteractions / totalPosts).toFixed(1));

    res.json({
      engagementRate,
      dailyActivityVolume,
      avgEngagementPerPost
    });
  } catch (error) {
    console.error('Error fetching feed metrics:', error);
    res.status(500).json({ error: 'Failed to fetch feed metrics' });
  }
};

// GET /api/admin/feed/posts
exports.getFeedPosts = async (req, res) => {
  try {
    const { role, location, sort, page = 1, limit = 10, unlistedOnly, userId } = req.query;
    const offset = (page - 1) * limit;

    let whereClauses = [];
    if (!userId) {
      whereClauses.push("p.created_at >= NOW() - INTERVAL '30 days'");
    }
    if (unlistedOnly === 'true') {
      whereClauses.push("p.is_unlisted = true");
    } else if (unlistedOnly === 'false') {
      whereClauses.push("p.is_unlisted = false");
    }
    
    let queryParams = [];
    let paramIndex = 1;

    if (userId) {
      whereClauses.push(`p.author_id = $${paramIndex}`);
      queryParams.push(userId);
      paramIndex++;
    }

    // Filter by Role
    if (role && role !== 'All Roles') {
      let jobTitleFilter = '';
      if (role === 'Software Engineers') {
        jobTitleFilter = '%engineer%';
      } else if (role === 'Designers') {
        jobTitleFilter = '%design%';
      } else if (role === 'Founders / Executives') {
        jobTitleFilter = '%founder%';
      }
      if (jobTitleFilter) {
        whereClauses.push(`u.job_title ILIKE $${paramIndex}`);
        queryParams.push(jobTitleFilter);
        paramIndex++;
      }
    }

    // Filter by Location
    if (location && location !== 'All Locations') {
      if (location === 'Remote / Hybrid') {
        whereClauses.push(`(u.location ILIKE '%remote%' OR u.location ILIKE '%hybrid%')`);
      } else {
        whereClauses.push(`u.location ILIKE $${paramIndex}`);
        queryParams.push(`%${location}%`);
        paramIndex++;
      }
    }

    // If sorting by Highly Reported, only return posts that have actually been reported
    if (sort === 'Highly Reported') {
      whereClauses.push("EXISTS (SELECT 1 FROM reports rep WHERE rep.target_type = 'post' AND rep.target_id = p.post_id)");
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // Sort order
    let orderSql = 'ORDER BY p.created_at DESC, p.post_id DESC';
    if (sort === 'Most Liked') {
      orderSql = 'ORDER BY likes DESC, p.created_at DESC, p.post_id DESC';
    } else if (sort === 'Highly Reported') {
      orderSql = 'ORDER BY reports DESC, p.created_at DESC, p.post_id DESC';
    }

    const postsQuery = `
      SELECT 
        p.post_id AS id,
        p.content,
        p.created_at,
        p.is_unlisted AS "isUnlisted",
        u.full_name AS author,
        u.job_title AS title,
        u.company_name AS company,
        u.location,
        u.avatar_url AS avatar,
        COALESCE(pm.url, NULL) AS "mediaUrl",
        COALESCE(l.likes_count, 0) AS likes,
        COALESCE(c.comments_count, 0) AS comments,
        COALESCE(s.shares_count, 0) AS shares,
        COALESCE(r.reports_count, 0) AS reports,
        u.moderation_flags,
        pa.appeal_reason AS "appealReason",
        pa.status AS "appealStatus"
      FROM posts p
      JOIN users u ON p.author_id = u.user_id
      LEFT JOIN post_media pm ON p.post_id = pm.post_id
      LEFT JOIN post_appeals pa ON p.post_id = pa.post_id AND pa.status = 'pending'
      LEFT JOIN (
        SELECT post_id, COUNT(*) AS likes_count FROM post_likes GROUP BY post_id
      ) l ON p.post_id = l.post_id
      LEFT JOIN (
        SELECT post_id, COUNT(*) AS comments_count FROM post_comments GROUP BY post_id
      ) c ON p.post_id = c.post_id
      LEFT JOIN (
        SELECT post_id, COUNT(*) AS shares_count FROM post_shares GROUP BY post_id
      ) s ON p.post_id = s.post_id
      LEFT JOIN (
        SELECT target_id, COUNT(*) AS reports_count FROM reports WHERE target_type = 'post' GROUP BY target_id
      ) r ON p.post_id = r.target_id
      ${whereSql}
      ${orderSql}
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    const countQuery = `
      SELECT COUNT(*) 
      FROM posts p
      JOIN users u ON p.author_id = u.user_id
      ${whereSql}
    `;

    const countRes = await pool.query(countQuery, queryParams);
    const totalPosts = parseInt(countRes.rows[0].count, 10);

    const postsRes = await pool.query(postsQuery, [...queryParams, limit, offset]);

    // Filter out posts that contain raw code, stack traces, console errors, or code frame lines
    const filteredRows = postsRes.rows.filter(row => {
      const content = row.content || '';
      if (
        content.includes('## Error Type') ||
        content.includes('AxiosError') ||
        content.includes('at async') ||
        /\d+\s*\|/.test(content)
      ) {
        return false;
      }
      return true;
    });

    // Format response to match frontend expectations
    const posts = filteredRows.map(row => ({
      id: row.id,
      author: row.author,
      title: row.title || '',
      company: row.company || '',
      location: row.location || 'Unknown',
      avatar: row.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(row.author)}&background=e0e7ff&color=3730a3`,
      content: row.content,
      mediaUrl: row.mediaUrl,
      metrics: {
        likes: parseInt(row.likes, 10),
        comments: parseInt(row.comments, 10),
        shares: parseInt(row.shares, 10),
        saves: 0,
        clicks: 0
      },
      aiFlag: row.moderation_flags > 2 ? { type: 'safety', message: `High Risk: Author has ${row.moderation_flags} moderation flags.` } : null,
      status: 'active',
      isUnlisted: !!row.isUnlisted,
      appeal: row.appealStatus === 'pending' ? {
        reason: row.appealReason,
        status: row.appealStatus
      } : null
    }));

    res.json({
      posts,
      totalPosts,
      currentPage: parseInt(page, 10),
      totalPages: Math.ceil(totalPosts / limit)
    });
  } catch (error) {
    console.error('Error fetching feed posts:', error);
    res.status(500).json({ error: 'Failed to fetch feed posts' });
  }
};

// DELETE /api/admin/feed/posts/:id
exports.deleteFeedPost = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason = 'Post Moderation Takedown', message = 'Your post has been unlisted for violating community guidelines.' } = req.body;

    // Verify post exists
    const checkRes = await pool.query('SELECT post_id, author_id FROM posts WHERE post_id = $1', [id]);
    if (checkRes.rowCount === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }

    const post = checkRes.rows[0];

    // Soft takedown: Toggle is_unlisted to true and make it private
    await pool.query("UPDATE posts SET is_unlisted = true, visibility = 'private' WHERE post_id = $1", [id]);

    // Purge from global feed pools
    if (redis.status === 'ready') {
      await redis.zrem('feed:explore:pool', id);
      await redis.zrem('feed:trending:global', id);
    }

    // Send a warning notification to the author
    await pool.query(
      'INSERT INTO user_warnings (user_id, reason, message, is_severe) VALUES ($1, $2, $3, false)',
      [post.author_id, reason, message]
    );

    // Audit log
    await pool.query(
      `INSERT INTO admin_audit_logs (user_id, action_type, description) 
       VALUES ($1, 'UNLIST_POST', $2)`,
      [req.user.sub || null, `Unlisted post ${id} by user ${post.author_id} for: ${reason}`]
    );

    res.json({ success: true, message: 'Post successfully unlisted and warning sent' });
  } catch (error) {
    console.error('Error unlisting feed post:', error);
    res.status(500).json({ error: 'Failed to unlist feed post' });
  }
};

// POST /api/admin/feed/posts/:id/restore
exports.restoreFeedPost = async (req, res) => {
  try {
    const { id } = req.params;

    // Verify post exists
    const checkRes = await pool.query('SELECT post_id, author_id FROM posts WHERE post_id = $1', [id]);
    if (checkRes.rowCount === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }

    const post = checkRes.rows[0];

    // Restore: Toggle is_unlisted to false and make it public again
    await pool.query("UPDATE posts SET is_unlisted = false, visibility = 'public' WHERE post_id = $1", [id]);

    // Resolve pending appeals as approved
    await pool.query("UPDATE post_appeals SET status = 'approved', resolved_at = NOW() WHERE post_id = $1 AND status = 'pending'", [id]);

    // Notify Main API to emit Socket.io notification
    try {
      await fetch('http://localhost:5000/internal/v1/appeals/notify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-secret': process.env.INTERNAL_API_SECRET
        },
        body: JSON.stringify({
          userId: post.author_id,
          postId: id,
          status: 'approved',
          reason: 'Admin approved your appeal'
        })
      });
    } catch (notifyErr) {
      console.error('Failed to notify Main API for appeal approval:', notifyErr);
    }

    // Audit log
    await pool.query(
      `INSERT INTO admin_audit_logs (user_id, action_type, description) 
       VALUES ($1, 'RESTORE_POST', $2)`,
      [req.user.sub || null, `Restored post ${id} by user ${post.author_id}`]
    );

    res.json({ success: true, message: 'Post successfully restored to public status' });
  } catch (error) {
    console.error('Error restoring feed post:', error);
    res.status(500).json({ error: 'Failed to restore feed post' });
  }
};

// POST /api/admin/feed/posts/:id/reject-appeal
exports.rejectFeedPostAppeal = async (req, res) => {
  try {
    const { id } = req.params;

    // Verify post exists
    const checkRes = await pool.query('SELECT post_id, author_id FROM posts WHERE post_id = $1', [id]);
    if (checkRes.rowCount === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }

    const post = checkRes.rows[0];

    // Resolve pending appeals as rejected
    await pool.query("UPDATE post_appeals SET status = 'rejected', resolved_at = NOW() WHERE post_id = $1 AND status = 'pending'", [id]);

    // Notify Main API to emit Socket.io notification
    try {
      await fetch('http://localhost:5000/internal/v1/appeals/notify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-secret': process.env.INTERNAL_API_SECRET
        },
        body: JSON.stringify({
          userId: post.author_id,
          postId: id,
          status: 'rejected',
          reason: 'Admin rejected your appeal'
        })
      });
    } catch (notifyErr) {
      console.error('Failed to notify Main API for appeal rejection:', notifyErr);
    }

    // Audit log
    await pool.query(
      `INSERT INTO admin_audit_logs (user_id, action_type, description) 
       VALUES ($1, 'REJECT_APPEAL', $2)`,
      [req.user.sub || null, `Rejected appeal for post ${id} by user ${post.author_id}`]
    );

    res.json({ success: true, message: 'Appeal successfully rejected' });
  } catch (error) {
    console.error('Error rejecting feed post appeal:', error);
    res.status(500).json({ error: 'Failed to reject feed post appeal' });
  }
};

// GET /api/admin/feed/hashtags
exports.getTrendingHashtags = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
         h.hashtag_id AS id, 
         h.tag, 
         h.usage_count,
         CASE 
           WHEN COALESCE(ph.recent_count, 0) > 0 THEN CONCAT('+', GREATEST(ROUND(ph.recent_count / 24.0), 1), '/hr')
           ELSE CONCAT('+', GREATEST(ROUND(h.usage_count / 10.0), 1), '/hr')
         END AS velocity
       FROM hashtags h
       LEFT JOIN (
         SELECT hashtag_id, COUNT(*) AS recent_count 
         FROM post_hashtags 
         WHERE created_at >= NOW() - INTERVAL '24 hours' 
         GROUP BY hashtag_id
       ) ph ON h.hashtag_id = ph.hashtag_id
       ORDER BY h.usage_count DESC 
       LIMIT 6`
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching trending hashtags:', error);
    res.status(500).json({ error: 'Failed to fetch trending hashtags' });
  }
};

// GET /api/admin/feed/leaderboard
exports.getFeedLeaderboard = async (req, res) => {
  try {
    const query = `
      SELECT 
        p.post_id AS id,
        CASE WHEN LENGTH(p.content) > 60 THEN CONCAT(SUBSTRING(p.content, 1, 60), '...') ELSE p.content END AS title,
        u.full_name AS author,
        COALESCE(l.likes_count, 0) AS likes,
        COALESCE(c.comments_count, 0) AS comments,
        COALESCE(s.shares_count, 0) AS shares
      FROM posts p
      JOIN users u ON p.author_id = u.user_id
      LEFT JOIN (
        SELECT post_id, COUNT(*) AS likes_count FROM post_likes GROUP BY post_id
      ) l ON p.post_id = l.post_id
      LEFT JOIN (
        SELECT post_id, COUNT(*) AS comments_count FROM post_comments GROUP BY post_id
      ) c ON p.post_id = c.post_id
      LEFT JOIN (
        SELECT post_id, COUNT(*) AS shares_count FROM post_shares GROUP BY post_id
      ) s ON p.post_id = s.post_id
      ORDER BY (COALESCE(l.likes_count, 0) + (COALESCE(c.comments_count, 0) * 2) + (COALESCE(s.shares_count, 0) * 3)) DESC
      LIMIT 5
    `;
    const result = await pool.query(query);
    res.json(result.rows.map(row => ({
      id: row.id,
      title: row.title || 'Untitled Post',
      author: row.author,
      likes: parseInt(row.likes, 10),
      comments: parseInt(row.comments, 10),
      shares: parseInt(row.shares, 10)
    })));
  } catch (error) {
    console.error('Error fetching leaderboard:', error);
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
};

// GET /api/admin/feed/posts/:id/comments
exports.getPostComments = async (req, res) => {
  try {
    const { id } = req.params;
    const query = `
      SELECT 
        c.comment_id AS id,
        c.content,
        c.created_at,
        u.full_name AS author,
        u.avatar_url AS avatar,
        u.job_title AS title,
        u.company_name AS company
      FROM post_comments c
      JOIN users u ON c.author_id = u.user_id
      WHERE c.post_id = $1
      ORDER BY c.created_at ASC
    `;
    const result = await pool.query(query, [id]);
    res.json(result.rows.map(row => ({
      id: row.id,
      content: row.content,
      created_at: row.created_at,
      author: row.author,
      title: row.title || 'Professional',
      company: row.company || 'Platform User',
      avatar: row.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(row.author)}&background=e0e7ff&color=3730a3`
    })));
  } catch (error) {
    console.error('Error fetching post comments:', error);
    res.status(500).json({ error: 'Failed to fetch post comments' });
  }
};

