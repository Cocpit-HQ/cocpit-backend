const pool = require('../../core/db/pool');
const socketService = require('../../core/infrastructure/socket.service');

exports.notifyAppealResolved = async (req, res) => {
  try {
    const { userId, postId, status, reason } = req.body;

    if (!userId || !postId || !status) {
      return res.status(400).json({ error: 'Missing required fields: userId, postId, status' });
    }

    let text = '';
    if (status === 'approved') {
      text = 'Your appeal has been approved and your post has been restored.';
    } else if (status === 'rejected') {
      text = 'Your appeal has been reviewed and rejected. The post remains unlisted.';
    } else {
      text = `Your appeal status was updated to: ${status}`;
    }

    // Insert into notifications
    const result = await pool.query(
      `INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata)
       VALUES ($1, NULL, $2, $3, $4, $5)
       RETURNING notification_id`,
      [
        userId,
        'appeal_resolved',
        text,
        postId,
        JSON.stringify({ status, reason, type: 'appeal' })
      ]
    );

    const notificationId = result.rows[0].notification_id;

    // Emit real-time notification
    socketService.notifyUser(userId, 'notification', {
      notification_id: notificationId,
      type: 'appeal_resolved',
      text,
      reference_id: postId,
      metadata: { status, reason, type: 'appeal' },
      created_at: new Date().toISOString()
    });

    return res.json({ success: true, message: 'Notification sent successfully' });
  } catch (error) {
    console.error('Error in notifyAppealResolved:', error);
    return res.status(500).json({ error: 'Internal server error while sending notification', details: error.message, stack: error.stack });
  }
};
