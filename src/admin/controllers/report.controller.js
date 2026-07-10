const pool = require('../../core/db/pool');

exports.getReportReasons = async (req, res) => {
  try {
    const result = await pool.query('SELECT DISTINCT code, label FROM report_reasons ORDER BY code');
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching report reasons:', err);
    res.status(500).json({ error: 'Server error fetching reasons' });
  }
};

exports.getReports = async (req, res) => {
  try {
    const { status = 'active', page = 1, limit = 10, type, reason, severity } = req.query;
    const offset = (page - 1) * limit;
    
    let whereClause = `WHERE status = $1`;
    let queryParams = [status];
    
    if (type && type !== 'All') {
      queryParams.push(type);
      whereClause += ` AND target_type = $${queryParams.length}`;
    }
    if (reason && reason !== 'All') {
      queryParams.push(reason);
      whereClause += ` AND reason = $${queryParams.length}`;
    }
    if (severity && severity !== 'All') {
      queryParams.push(severity);
      whereClause += ` AND severity = $${queryParams.length}`;
    }
    
    // Get total count for pagination
    const countQuery = `SELECT COUNT(*) FROM admin_reports_view ${whereClause}`;
    const countResult = await pool.query(countQuery, queryParams);
    const total = parseInt(countResult.rows[0].count, 10);

    const query = `
      SELECT 
        id,
        target_type as type,
        raw_target_type as "rawType",
        severity,
        offenses,
        content_preview as "contentPreview",
        image_url as "image",
        created_at as "postTime",
        target_id as "postId",
        reason,
        reported_by as "reportedBy",
        reporter_id as "reporterId",
        '100%' as "repScore", -- Mock rep score for now
        target_user_id as "targetUserId",
        target_user_name as "targetUserName"
      FROM admin_reports_view
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}
    `;
    
    const result = await pool.query(query, [...queryParams, limit, offset]);
    
    res.json({
      reports: result.rows,
      total,
      page: parseInt(page, 10),
      totalPages: Math.ceil(total / limit) || 1
    });
  } catch (err) {
    console.error('Error fetching reports:', err);
    res.status(500).json({ error: 'Server error fetching reports' });
  }
};

exports.updateReport = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body; // 'escalated', 'resolved', 'dismissed'
    
    if (!status) return res.status(400).json({ error: 'Status is required' });

    const result = await pool.query(
      'UPDATE reports SET status = $1, resolved_at = NOW() WHERE id = $2 RETURNING *',
      [status, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Report not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating report:', err);
    res.status(500).json({ error: 'Server error updating report' });
  }
};

exports.getAppeals = async (req, res) => {
  try {
    const { status = 'pending' } = req.query;

    const query = `
      SELECT 
        a.appeal_id as id,
        u.full_name as user,
        'Content' as type,
        'Original Violation' as "originalViolation",
        'System' as "suspendingAdmin",
        a.appeal_reason as "appealText",
        a.created_at as "appealTime"
      FROM post_appeals a
      LEFT JOIN users u ON a.user_id = u.user_id
      WHERE a.status = $1
      ORDER BY a.created_at DESC
    `;
    const result = await pool.query(query, [status]);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching appeals:', err);
    res.status(500).json({ error: 'Server error fetching appeals' });
  }
};

exports.updateAppeal = async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { action } = req.body; // 'reinstate', 'reinstate_with_warning', 'uphold'

    const validActions = ['reinstate', 'reinstate_with_warning', 'uphold'];
    if (!action || !validActions.includes(action)) {
      return res.status(400).json({ error: `Action must be one of: ${validActions.join(', ')}` });
    }

    await client.query('BEGIN');

    // Step 1: Fetch the appeal and linked post/user
    const appealResult = await client.query(
      'SELECT appeal_id, post_id, user_id FROM post_appeals WHERE appeal_id = $1',
      [id]
    );

    if (appealResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Appeal not found' });
    }

    const { post_id, user_id } = appealResult.rows[0];

    // Step 2: Execute side-effects based on action
    if (action === 'reinstate') {
      // Restore the post to the feed
      await client.query(
        'UPDATE posts SET is_deleted = false, is_unlisted = false, is_removed = false, visibility = $2 WHERE post_id = $1',
        [post_id, 'public']
      );

    } else if (action === 'reinstate_with_warning') {
      // Restore the post
      await client.query(
        'UPDATE posts SET is_deleted = false, is_unlisted = false, is_removed = false, visibility = $2 WHERE post_id = $1',
        [post_id, 'public']
      );
      // Increment the user's moderation flag count
      await client.query(
        'UPDATE users SET moderation_flags = moderation_flags + 1 WHERE user_id = $1',
        [user_id]
      );
      // Log a formal warning in the user_warnings table
      await client.query(
        `INSERT INTO user_warnings (user_id, reason, message, is_severe)
         VALUES ($1, 'Post Warning', 'Your post was reinstated, but it was flagged as violating community guidelines. Further violations may result in permanent removal.', false)`,
        [user_id]
      );

    } else if (action === 'uphold') {
      // No changes to the post — the removal stands.
      // Just mark the appeal as rejected below.
    }

    // Step 3: Update the appeal status
    const finalStatus = (action === 'uphold') ? 'rejected' : 'approved';
    const updated = await client.query(
      'UPDATE post_appeals SET status = $1, resolved_at = NOW() WHERE appeal_id = $2 RETURNING *',
      [finalStatus, id]
    );

    // Notify Main API to emit Socket.io notification
    try {
      await fetch('http://localhost:5000/internal/v1/appeals/notify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-secret': process.env.INTERNAL_API_SECRET
        },
        body: JSON.stringify({
          userId: user_id,
          postId: post_id,
          status: finalStatus,
          reason: action === 'uphold' ? 'Admin rejected your appeal' : 'Admin approved your appeal'
        })
      });
    } catch (notifyErr) {
      console.error('Failed to notify Main API for appeal resolution:', notifyErr);
    }

    await client.query('COMMIT');
    res.json(updated.rows[0]);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error updating appeal:', err);
    res.status(500).json({ error: 'Server error updating appeal' });
  } finally {
    client.release();
  }
};

exports.deleteReportedPost = async (req, res) => {
  try {
    const { id } = req.params;
    
    // Soft delete the post
    const updateRes = await pool.query(
      'UPDATE posts SET is_deleted = true WHERE post_id = $1 RETURNING *',
      [id]
    );

    if (updateRes.rowCount === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }

    // Automatically resolve all active/escalated reports targeting this post
    await pool.query(
      "UPDATE reports SET status = 'resolved', resolved_at = NOW() WHERE target_type IN ('Content', 'POST', 'COMMENT') AND target_id = $1 AND status IN ('active', 'escalated')",
      [id]
    );

    res.json({ message: 'Post deleted successfully and associated reports resolved.' });
  } catch (err) {
    console.error('Error deleting post:', err);
    res.status(500).json({ error: 'Server error deleting post' });
  }
};

exports.deleteReportedComment = async (req, res) => {
  try {
    const { id } = req.params;
    
    // Soft delete the comment
    const updateRes = await pool.query(
      'UPDATE post_comments SET is_deleted = true WHERE comment_id = $1 RETURNING *',
      [id]
    );

    if (updateRes.rowCount === 0) {
      return res.status(404).json({ error: 'Comment not found' });
    }

    // Automatically resolve all active/escalated reports targeting this comment
    await pool.query(
      "UPDATE reports SET status = 'resolved', resolved_at = NOW() WHERE target_type IN ('Content', 'POST', 'COMMENT') AND target_id = $1 AND status IN ('active', 'escalated')",
      [id]
    );

    res.json({ message: 'Comment deleted successfully and associated reports resolved.' });
  } catch (err) {
    console.error('Error deleting comment:', err);
    res.status(500).json({ error: 'Server error deleting comment' });
  }
};
