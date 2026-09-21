const pool = require('../../core/db/pool');

exports.verifyToken = async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }

    const query = `
      SELECT 
        at.token_id, 
        at.is_used, 
        at.expires_at,
        ma.action_id,
        ma.action_type,
        ma.reason,
        ma.duration_days,
        ma.created_at as suspended_at,
        u.user_id,
        u.full_name as user_name
      FROM appeal_tokens at
      JOIN moderation_actions ma ON at.action_id = ma.action_id
      JOIN users u ON ma.target_id = u.user_id AND ma.target_type = 'USER'
      WHERE at.token_hash = $1
    `;

    const result = await pool.query(query, [token]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Invalid or expired appeal link.' });
    }

    const tokenData = result.rows[0];

    if (tokenData.is_used) {
      return res.status(400).json({ error: 'This appeal link has already been used.' });
    }

    if (new Date() > new Date(tokenData.expires_at)) {
      return res.status(400).json({ error: 'This appeal link has expired.' });
    }

    res.json({
      success: true,
      data: {
        token_id: tokenData.token_id,
        user_name: tokenData.user_name,
        action_type: tokenData.action_type,
        reason: tokenData.reason,
        duration_days: tokenData.duration_days,
        suspended_at: tokenData.suspended_at
      }
    });

  } catch (err) {
    console.error('Error verifying appeal token:', err);
    res.status(500).json({ error: 'Failed to verify token' });
  }
};

exports.submitAppeal = async (req, res) => {
  try {
    const { token, appealReason } = req.body;

    if (!token || !appealReason || !appealReason.trim()) {
      return res.status(400).json({ error: 'Token and appeal reason are required.' });
    }

    // Begin Transaction
    await pool.query('BEGIN');

    // 1. Validate token again and lock row
    const tokenQuery = `
      SELECT token_id, action_id, is_used, expires_at
      FROM appeal_tokens
      WHERE token_hash = $1
      FOR UPDATE
    `;
    const tokenRes = await pool.query(tokenQuery, [token]);

    if (tokenRes.rows.length === 0) {
      await pool.query('ROLLBACK');
      return res.status(404).json({ error: 'Invalid or expired appeal link.' });
    }

    const tokenData = tokenRes.rows[0];

    if (tokenData.is_used || new Date() > new Date(tokenData.expires_at)) {
      await pool.query('ROLLBACK');
      return res.status(400).json({ error: 'This appeal link is no longer valid.' });
    }

    // 2. Check if appeal already exists for this action
    const existingRes = await pool.query('SELECT appeal_id FROM moderation_appeals WHERE action_id = $1', [tokenData.action_id]);
    if (existingRes.rows.length > 0) {
      await pool.query('ROLLBACK');
      return res.status(400).json({ error: 'An appeal has already been submitted for this action.' });
    }

    const actionRes = await pool.query('SELECT target_id FROM moderation_actions WHERE action_id = $1', [tokenData.action_id]);
    const userId = actionRes.rows[0].target_id;

    // 3. Insert the appeal
    await pool.query(
      'INSERT INTO moderation_appeals (token_id, action_id, user_id, appeal_reason) VALUES ($1, $2, $3, $4)',
      [tokenData.token_id, tokenData.action_id, userId, appealReason]
    );

    // 4. Mark token as used
    await pool.query('UPDATE appeal_tokens SET is_used = true WHERE token_hash = $1', [token]);

    await pool.query('COMMIT');
    res.json({ success: true, message: 'Appeal submitted successfully.' });

  } catch (err) {
    await pool.query('ROLLBACK');
    console.error('Error submitting appeal:', err);
    res.status(500).json({ error: 'Failed to submit appeal' });
  }
};
