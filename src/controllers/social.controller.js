const { stat } = require("node:fs");
const pool = require("../db/pool");
const { connected } = require("node:process");
const { formatDistanceToNow } = require('date-fns');
const timeAgo = require("./../utils/timeAgo")
const socketService = require("../services/socket.service");

// Follow another user
exports.followUser = async (req, res) => {
    const followerId = req.user.sub;
    const { id } = req.params; // following_id

    if (followerId === id)
        return res.status(400).json({ message: "Cannot follow yourself" });

    try {
        await pool.query(
            `INSERT INTO followers (follower_id, following_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [followerId, id]
        );
        res.status(200).json({ message: "Followed successfully" });
    } catch (err) {
        res.status(500).json({ message: "Internal server error" });
    }
};

// Unfollow a user
exports.unfollowUser = async (req, res) => {
    const followerId = req.user.sub;
    const { id } = req.params; //following_id

    try {
        const result = await pool.query(
            `DELETE FROM followers WHERE follower_id = $1 AND following_id = $2 RETURNING *`,
            [followerId, id]
        );

        if (result.rowCount === 0)
            return res.status(404).json({ message: "You are not following this user" });

        res.json({ message: "Unfollowed successfully" });
    } catch (err) {
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.getFollowers = async (req, res) => {
    const userId = req.params.id;

    try {
        const result = await pool.query(
            `SELECT u.user_id, u.full_name, u.avatar_url, u.headline, f.created_at 
            FROM followers f JOIN users u ON f.follower_id = u.user_id 
            WHERE f.following_id = $1 ORDER BY f.created_at DESC`,
            [userId]
        );

        const formattedConnections = result.rows.map(row => {
            const timeAgo = formatDistanceToNow(new Date(row.created_at), {
                addSuffix: true
            }).replace(/^about\s+/i, '');

            return {
                ...row,
                timeAgo: `connected ${timeAgo}`
            };
        });


        res.json(formattedConnections);
    } catch (err) {
        res.status(500).json({ message: "Internal server error" });
    }
}

exports.getFollowersCount = async (req, res) => {
    const userId = req.params.id;

    try {
        const result = await pool.query(
            `SELECT COUNT(*) FROM followers WHERE following_id = $1`,
            [userId]
        );
        res.json({ followers_count: result.rows[0].count });
    }
    catch (err) {
        res.status(500).json({ message: "Internal server error" });
    }

};

//    CONNECTIONS (Two-way)
exports.sendConnectionRequest = async (req, res) => {
    const senderId = req.user.sub;
    const receiverId = req.params.id;

    if (!receiverId) {
        return res.status(400).json({ message: "Invalid request" });
    }

    if (senderId === receiverId) {
        return res.status(400).json({ message: "You cannot connect with yourself" });
    }

    try {
        // Prevent request if already connected
        const alreadyConnected = await pool.query(
            `
      SELECT 1 FROM connections
      WHERE user_id = $1 AND connected_user_id = $2
      `,
            [senderId, receiverId]
        );

        if (alreadyConnected.rowCount > 0) {
            return res.status(400).json({ message: "Already connected" });
        }

        // Blocked within last 30 days → deny
        const recentBlock = await pool.query(
            `
      SELECT 1
      FROM connection_requests
      WHERE
        (
          (sender_id = $1 AND receiver_id = $2)
          OR
          (sender_id = $2 AND receiver_id = $1)
        )
        AND status = 'blocked'
        AND responded_at >= NOW() - INTERVAL '1 days' 
      `, //30 days at production level
            [senderId, receiverId]
        );

        if (recentBlock.rowCount > 0) {
            return res.status(403).json({
                message: "You cannot send a connection request yet"
            });
        }

        // Remove old (expired) blocked record
        await pool.query(
            `
      DELETE FROM connection_requests
      WHERE
        (
          (sender_id = $1 AND receiver_id = $2)
          OR
          (sender_id = $2 AND receiver_id = $1)
        )
        AND status = 'blocked'
        AND responded_at < NOW() - INTERVAL '30 days'
      `,
            [senderId, receiverId]
        );

        // Insert request (DB handles duplicates safely)
        await pool.query(
            `
      INSERT INTO connection_requests (sender_id, receiver_id)
      VALUES ($1, $2)
      `,
            [senderId, receiverId]
        );

        return res.status(201).json({ message: "Connection request sent" });

    } catch (err) {
        // Same or reverse pending request
        if (err.code === '23505') {
            return res.status(400).json({
                message: "Connection request already exists"
            });
        }

        console.error("Send connection error:", err);
        return res.status(500).json({ message: "Internal server error" });
    }
};

exports.getPendingRequests = async (req, res) => {
    const receiver_id = req.user.sub;

    try {
        const result = await pool.query(
            `
      SELECT 
        cr.request_id,
        u.user_id,
        u.full_name,
        u.avatar_url,
        u.headline
      FROM connection_requests cr
      JOIN users u ON cr.sender_id = u.user_id
      WHERE cr.receiver_id = $1
        AND cr.status = 'pending'
      ORDER BY cr.created_at DESC
      `,
            [receiver_id]
        );

        return res.status(200).json(result.rows);

    } catch (err) {
        console.error("Get pending requests error:", err);
        return res.status(500).json({ message: "Internal server error" });
    }
};

exports.handleConnectionRequest = async (req, res) => {
    const requestId = req.params.requestId;
    const { status } = req.body; // 'connected' or 'blocked'
    const userId = req.user.sub;

    if (!['connected', 'blocked'].includes(status)) {
        return res.status(400).json({ message: "Invalid status" });
    }

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        // Fetch request & authorize receiver
        const reqRes = await client.query(
            `
      SELECT sender_id, receiver_id
      FROM connection_requests
      WHERE request_id = $1 AND status = 'pending'
      `,
            [requestId]
        );

        if (reqRes.rowCount === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ message: "Request not found" });
        }

        const { sender_id, receiver_id } = reqRes.rows[0];

        if (receiver_id !== userId) {
            await client.query("ROLLBACK");
            return res.status(403).json({ message: "Not authorized" });
        }

        // Reject
        if (status === 'blocked') {
            await client.query(
                `
        UPDATE connection_requests
        SET status = 'blocked', responded_at = NOW()
        WHERE request_id = $1
        `,
                [requestId]
            );

            await client.query("COMMIT");
            return res.status(200).json({
                message: "Connection request blocked",
                connected: false
            });
        }

        // Accept → create mutual connections
        await client.query(
            `
      INSERT INTO connections (user_id, connected_user_id)
      VALUES ($1, $2), ($2, $1)
      ON CONFLICT DO NOTHING
      `,
            [sender_id, receiver_id]
        );

        // Delete request
        await client.query(
            `DELETE FROM connection_requests WHERE request_id = $1`,
            [requestId]
        );

        await client.query("COMMIT");
        return res.status(200).json({
            message: "Connection established",
            connected: true
        });

    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Handle connection error:", err);
        return res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

exports.cancelConnectionRequest = async (req, res) => {
    const requestId = req.params.requestId;
    const userId = req.user.sub;

    try {
        // Fetch request & ensure it is pending
        const reqRes = await pool.query(
            `
      SELECT sender_id
      FROM connection_requests
      WHERE request_id = $1
        AND status = 'pending'
      `,
            [requestId]
        );

        if (reqRes.rowCount === 0) {
            return res
                .status(404)
                .json({ message: "Pending connection request not found" });
        }

        // Only sender can cancel
        if (reqRes.rows[0].sender_id !== userId) {
            return res.status(403).json({ message: "Not authorized" });
        }

        // Delete request
        await pool.query(
            `
      DELETE FROM connection_requests
      WHERE request_id = $1
      `,
            [requestId]
        );

        return res.status(200).json({ message: "Connection request canceled" });

    } catch (err) {
        console.error("Cancel connection request error:", err);
        return res.status(500).json({ message: "Internal server error" });
    }
};

exports.removeConnection = async (req, res) => {
    const userId = req.user.sub;
    const another_user_id = req.params.id;

    try {
        const result = await pool.query(
            `DELETE FROM connections WHERE (user_id = $1 AND connected_user_id = $2) OR (user_id = $2 AND connected_user_id = $1) RETURNING *`,
            [userId, another_user_id]
        );

        if (result.rowCount === 0)
            return res.status(404).json({ message: "You are not connected with this user" });

        res.json({ message: "Connection removed successfully" });
    }
    catch (err) {
        res.status(500).json({ message: "Internal server error" });
    }

}

exports.getMyConnections = async (req, res) => {
    const userId = req.user.sub;

    try {

        const result = await pool.query(`select u.user_id, u.full_name , u.avatar_url, u.headline, 
             c.created_at from connections c 
                join users u on c.connected_user_id = u.user_id where c.user_id = $1`, [userId])

        const formattedConnections = result.rows.map(row => {
            const timeAgo = formatDistanceToNow(new Date(row.updated_at), {
                addSuffix: true
            }).replace(/^about\s+/i, '');

            return {
                ...row,
                timeAgo: timeAgo
            }
        });

        res.json(formattedConnections);

        res.status(200).json(result.rows)
    } catch (err) {
        res.status(500).json({ message: "Internal server error" });
    }
}

exports.getConnectionCount = async (req, res) => {
    const userId = req.params.id;

    try {
        const result = await pool.query(
            `SELECT COUNT(*) FROM connections WHERE user_id = $1`,
            [userId]
        );
        res.json({
            connection_count: result.rows[0].count,
            userId: userId
        });
    }
    catch (err) {
        res.status(500).json({ message: "Internal server error" });
    }
}

// Get all conversations of logged-in user
exports.getConversations = async (req, res) => {
    const userId = req.user.sub;

    try {
        const result = await pool.query(
            `
SELECT 
    c.*,
    -- Get the other participant's info
    u.full_name AS other_user_name,
    u.avatar_url AS other_user_avatar,
    -- Get the most recent message
    m.text_content AS last_message_text
FROM conversations c
JOIN conversation_participants cp ON c.conversation_id = cp.conversation_id
JOIN conversation_participants cp_other ON c.conversation_id = cp_other.conversation_id 
    AND cp_other.user_id != $1 -- $1 is the Logged-in User ID
JOIN users u ON cp_other.user_id = u.user_id
LEFT JOIN LATERAL (
    SELECT text_content FROM messages 
    WHERE conversation_id = c.conversation_id 
    ORDER BY created_at DESC LIMIT 1
) m ON true
WHERE cp.user_id = $1;
  `, [userId]
        );

        const unreadCountsResult = await pool.query(
            `  SELECT 
    m.conversation_id,
    COUNT(*)::int AS unread_count
  FROM messages m
  JOIN conversation_participants cp
    ON cp.conversation_id = m.conversation_id
  WHERE cp.user_id = $1
    AND m.sender_id <> $1
    AND m.read_at IS NULL
  GROUP BY m.conversation_id
  `, [userId]
        );

        const unreadMap = {};
        for (const row of unreadCountsResult.rows) {
            unreadMap[row.conversation_id] = row.unread_count;
        }

        const conversationsWithUnread = result.rows.map(c => ({
            ...c,
            timeAgo: timeAgo(c.updated_at),
            unread_count: unreadMap[c.conversation_id] || 0

        }));

        res.json(conversationsWithUnread);

    } catch (err) {
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.deleteConversation = async (req, res) => {
    const conversationId = req.params.id;
    const userId = req.user.sub;

    try {
        // We delete from 'conversations' but only if the 'userId' is a participant
        const result = await pool.query(
            `DELETE FROM conversations 
             WHERE conversation_id = $1 
             AND EXISTS (
                 SELECT 1 FROM conversation_participants 
                 WHERE conversation_id = $1 AND user_id = $2
             )
             RETURNING *`,
            [conversationId, userId]
        );

        if (result.rowCount === 0) {
            // This triggers if the ID is wrong OR if the user isn't a participant
            return res.status(404).json({ message: "Conversation not found or access denied" });
        }

        res.status(200).json({ message: "Conversation deleted successfully", userId: userId, conversationId: conversationId });
    } catch (err) {
        console.error("Delete conversation error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};
// Send a message to a user (auto-create 1-on-1 conversation if needed)
exports.sendMessage = async (req, res) => {
    const senderId = req.user.sub;
    const { targetUserId, text_content } = req.body;

    if (senderId === targetUserId)
        return res.status(400).json({ message: "Cannot send message to yourself" });

    try {
        await pool.query('BEGIN');
        let conversationId;

        // Check if 1-on-1 conversation exists
        const existingConv = await pool.query(
            `SELECT c.conversation_id
             FROM conversations c
             JOIN conversation_participants cp1 ON c.conversation_id = cp1.conversation_id AND cp1.user_id = $1
             JOIN conversation_participants cp2 ON c.conversation_id = cp2.conversation_id AND cp2.user_id = $2
             WHERE c.is_group = FALSE`,
            [senderId, targetUserId]
        );

        if (existingConv.rowCount > 0) {
            conversationId = existingConv.rows[0].conversation_id;
        } else {
            // Create new 1-on-1 conversation in a transaction

            const convRes = await pool.query(
                `INSERT INTO conversations (is_group) VALUES (FALSE) RETURNING conversation_id`
            );
            conversationId = convRes.rows[0].conversation_id;

            await pool.query(
                `INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2), ($1, $3)`,
                [conversationId, senderId, targetUserId]
            );
        }

        // Insert the message
        const msgRes = await pool.query(
            `INSERT INTO messages (conversation_id, sender_id, text_content)
             VALUES ($1, $2, $3) RETURNING *`,
            [conversationId, senderId, text_content]
        );

        // Update conversation timestamp
        await pool.query(
            `UPDATE conversations SET updated_at = now() WHERE conversation_id = $1`,
            [conversationId]
        );
        await pool.query('COMMIT');

        // Notify target user via service
        socketService.notifyUser(targetUserId, "newMessage", msgRes.rows[0]);
        socketService.notifyUser(targetUserId, "notification", {
            type: "message",
            from: senderId,
            conversationId,
        });

        res.status(201).json({
            conversationId,
            message: "Message sent successfully",
            data: msgRes.rows[0]
        });
    } catch (err) {
        await pool.query('ROLLBACK');
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.markConversationRead = async (req, res) => {
  const userId = req.user.sub;
  const { conversationId } = req.params;

  try {
    const result = await pool.query(
      `
      UPDATE messages
      SET read_at = NOW()
      WHERE conversation_id = $1
        AND sender_id != $2
        AND read_at IS NULL
      RETURNING message_id
      `,
      [conversationId, userId]
    );

    // 🔔 Emit read receipt
    socketService.notifyConversation(conversationId, "messagesRead", {
      conversationId,
      readerId: userId,
      messageIds: result.rows.map(r => r.message_id),
    });

    res.json({
      message: "Messages marked as read",
      count: result.rowCount,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Internal server error" });
  }
};

// Get all messages in a conversation
exports.getMessages = async (req, res) => {
    const userId = req.user.sub;
    const conversation_id = req.params.id;

    try {
        const partCheck = await pool.query(
            `SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2`,
            [conversation_id, userId]
        );

        if (partCheck.rowCount === 0)
            return res.status(403).json({ message: "Not a participant" });

        const result = await pool.query(
            `SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
            [conversation_id]
        );

        res.json(result.rows);
    } catch (err) {
        console.error("Get messages error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

// Delete a message sent by logged-in user
exports.deleteMessage = async (req, res) => {
    const userId = req.user.sub;
    const message_id = req.params.id;

    try {
        const result = await pool.query(
            `DELETE FROM messages WHERE message_id = $1 AND sender_id = $2 RETURNING *`,
            [message_id, userId]
        );

        if (result.rowCount === 0)
            return res.status(404).json({ message: "Message not found" });
        const { conversation_id } = result.rows[0];

        // 🔥 Notify all participants
        socketService.notifyConversation(conversation_id, "messageDeleted", {
            messageId: message_id,
            conversationId: conversation_id,
        });

        res.json({ message: "Message deleted successfully" });
    } catch (err) {
        res.status(500).json({ message: "Internal server error" });
    }
};

// Get all notifications for logged-in user
exports.getNotifications = async (req, res) => {
    const userId = req.user.sub;

    try {
        const result = await pool.query(
            `SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC`,
            [userId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error("Get notifications error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

// Mark a notification as read
exports.markNotificationRead = async (req, res) => {
  const userId = req.user.sub;
  const { id } = req.params;

  try {
    const result = await pool.query(
      `UPDATE notifications 
       SET is_read = TRUE 
       WHERE notification_id = $1 AND user_id = $2 
       RETURNING *`,
      [id, userId]
    );

    if (result.rowCount === 0)
      return res.status(404).json({ message: "Notification not found" });

    socketService.notifyUser(userId, "notificationRead", {
      notificationId: id,
    });

    res.json({
      message: "Notification marked as read",
      notification: result.rows[0],
    });
  } catch (err) {
    res.status(500).json({ message: "Internal server error" });
  }
};

