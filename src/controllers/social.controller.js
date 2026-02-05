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
        const result = await pool.query(
            `INSERT INTO followers (follower_id, following_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING *`,
            [followerId, id]
        );

        if (result.rowCount > 0) {
            // Get follower info for notification
            const followerRes = await pool.query(
                `SELECT full_name, avatar_url FROM users WHERE user_id = $1`,
                [followerId]
            );
            const follower = followerRes.rows[0];

            const notificationData = {
                type: "follow",
                text: `${follower.full_name} started following you`,
                from: followerId,
                senderName: follower.full_name,
                senderAvatar: follower.avatar_url,
                referenceId: followerId, // Link to profile
                time: "Just now"
            };

            // Notify via socket
            socketService.notifyUser(id, "notification", notificationData);

            // Persist notification
            await pool.query(
                `INSERT INTO notifications (user_id, sender_id, type, text, reference_id) 
                 VALUES ($1, $2, $3, $4, $5)`,
                [id, followerId, "follow", notificationData.text, followerId]
            );
        }

        res.status(200).json({ message: "Followed successfully" });
    } catch (err) {
        console.error("Follow user error:", err);
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
        res.status(200).json({
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
    -- Block Status
    CASE WHEN c.is_group THEN false ELSE EXISTS(SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = u.user_id) END as is_blocked_by_me,
    CASE WHEN c.is_group THEN false ELSE EXISTS(SELECT 1 FROM blocks WHERE blocker_id = u.user_id AND blocked_id = $1) END as is_blocked_by_other,

    -- Name logic: Use group name if group, else other user's name
    CASE 
        WHEN c.is_group THEN c.conversation_name 
        WHEN EXISTS(SELECT 1 FROM blocks WHERE blocker_id = u.user_id AND blocked_id = $1) THEN 'User not found'
        ELSE u.full_name 
    END AS other_user_name,
    
    -- Avatar logic: Use group avatar if group, else other user's avatar
    CASE 
        WHEN c.is_group THEN c.group_avatar 
        WHEN EXISTS(SELECT 1 FROM blocks WHERE blocker_id = u.user_id AND blocked_id = $1) THEN NULL
        ELSE u.avatar_url 
    END AS other_user_avatar,
    
    -- Other user ID (only for 1-on-1)
    u.user_id AS other_user_id,
    u.headline AS other_user_headline,
    
    -- Get the most recent message
    m.text_content AS last_message_text
FROM conversations c
JOIN conversation_participants cp ON c.conversation_id = cp.conversation_id
-- For 1-on-1, join the other participant. For groups, this might return multiple or we skip via logic.
-- Using LEFT JOIN and conditional checks.
LEFT JOIN conversation_participants cp_other ON c.conversation_id = cp_other.conversation_id 
    AND cp_other.user_id != $1 AND c.is_group = FALSE
LEFT JOIN users u ON cp_other.user_id = u.user_id

LEFT JOIN LATERAL (
    SELECT text_content FROM messages 
    WHERE conversation_id = c.conversation_id 
    ORDER BY created_at DESC LIMIT 1
) m ON true

WHERE cp.user_id = $1
-- Ensure distinct conversations (fix for potential multiple rows if join logic leaks)
-- Actually, if is_group=FALSE, cp_other matches 1 row (unless multi-party DM which we don't support yet).
-- If is_group=TRUE, cp_other is NULL due to condition.
ORDER BY c.updated_at DESC;
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
    const { targetUserId, text_content, shared_post_id } = req.body;

    if (!targetUserId || (!text_content && !shared_post_id)) {
        return res.status(400).json({ message: "targetUserId and content (text or shared post) are required" });
    }

    if (senderId === targetUserId)
        return res.status(400).json({ message: "Cannot send message to yourself" });

    // Check Block Status
    try {
        const { checkBlockStatus } = require("../utils/blockCheck");
        const isBlocked = await checkBlockStatus(senderId, targetUserId);
        if (isBlocked) {
            return res.status(404).json({ message: "User not found" }); // Masked 404
        }
    } catch (e) {
        console.error("Block check failed", e);
    }

    const client = await pool.connect();
    try {
        // Verify sender and target users exist
        const senderRes = await client.query(
            `SELECT full_name, avatar_url FROM users WHERE user_id = $1`,
            [senderId]
        );
        if (senderRes.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: "Sender not found." });
        }
        const { full_name: senderName, avatar_url: senderAvatar } = senderRes.rows[0];

        const targetUserExists = await client.query(
            `SELECT 1 FROM users WHERE user_id = $1`,
            [targetUserId]
        );
        if (targetUserExists.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: "Target user not found." });
        }

        await client.query('BEGIN');
        let conversationId;

        // Check if 1-on-1 conversation exists
        const existingConv = await client.query(
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

            const convRes = await client.query(
                `INSERT INTO conversations (is_group) VALUES (FALSE) RETURNING conversation_id`
            );
            conversationId = convRes.rows[0].conversation_id;

            await client.query(
                `INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2), ($1, $3)`,
                [conversationId, senderId, targetUserId]
            );
        }

        // Insert the message
        const msgRes = await client.query(
            `INSERT INTO messages (conversation_id, sender_id, text_content, shared_post_id)
                 VALUES ($1, $2, $3, $4) RETURNING *`,
            [conversationId, senderId, text_content || '', shared_post_id || null]
        );

        // Fetch shared post details if applicable for immediate socket update
        let sharedPostData = null;
        if (shared_post_id) {
            const spRes = await client.query(`
                SELECT 
                    p.post_id, p.content, p.created_at, 
                    json_build_object('full_name', u.full_name, 'avatar_url', u.avatar_url) as author,
                    (SELECT json_agg(json_build_object('url', url, 'media_type', media_type)) FROM post_media WHERE post_id = p.post_id) as media
                FROM posts p
                JOIN users u ON p.author_id = u.user_id
                WHERE p.post_id = $1
            `, [shared_post_id]);
            if (spRes.rowCount > 0) sharedPostData = spRes.rows[0];
        }

        // Update conversation timestamp
        await client.query(
            `UPDATE conversations SET updated_at = now() WHERE conversation_id = $1`,
            [conversationId]
        );
        await client.query('COMMIT');

        const messageData = {
            ...msgRes.rows[0],
            shared_post: sharedPostData,
            sender_name: senderName,
            sender_avatar: senderAvatar
        };

        // Notify target user via service
        socketService.notifyUser(targetUserId, "newMessage", messageData);
        socketService.notifyUser(targetUserId, "notification", {
            type: "message",
            from: senderId,
            senderName,
            senderAvatar,
            conversationId,
        });

        res.status(201).json({
            conversationId,
            message: "Message sent successfully",
            data: msgRes.rows[0]
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Error in sendMessage:", err); // Added error logging
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
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
        // 1. Check participation AND get joined_at + is_group
        const partCheck = await pool.query(
            `SELECT cp.joined_at, c.is_group 
             FROM conversation_participants cp
             JOIN conversations c ON cp.conversation_id = c.conversation_id
             WHERE cp.conversation_id = $1 AND cp.user_id = $2`,
            [conversation_id, userId]
        );

        if (partCheck.rowCount === 0)
            return res.status(403).json({ message: "Not a participant" });

        const { joined_at, is_group } = partCheck.rows[0];

        // 2. Fetch messages (Filtered by join time if group)
        const result = await pool.query(
            `SELECT 
                m.message_id,
                m.conversation_id,
                m.sender_id,
                m.created_at,
                m.read_at,
                u.full_name as sender_name,
                u.avatar_url as sender_avatar,
                CASE 
                    WHEN EXISTS (SELECT 1 FROM blocks WHERE blocker_id = $4 AND blocked_id = m.sender_id) THEN true 
                    ELSE false 
                END as is_blocked,
                CASE 
                    WHEN EXISTS (SELECT 1 FROM blocks WHERE blocker_id = $4 AND blocked_id = m.sender_id) THEN 'Message hidden'
                    ELSE m.text_content 
                END as text_content,
                CASE 
                    WHEN m.shared_post_id IS NOT NULL 
                         AND NOT EXISTS (SELECT 1 FROM blocks WHERE blocker_id = $4 AND blocked_id = m.sender_id)
                         AND NOT EXISTS (
                            SELECT 1 FROM blocks b 
                            WHERE (b.blocker_id = $4 AND b.blocked_id = sp.author_id)
                               OR (b.blocker_id = sp.author_id AND b.blocked_id = $4)
                         )
                    THEN
                        json_build_object(
                            'post_id', sp.post_id,
                            'content', sp.content,
                            'author', json_build_object('full_name', au.full_name, 'avatar_url', au.avatar_url),
                            'media', (SELECT json_agg(json_build_object('url', url, 'media_type', media_type)) FROM post_media WHERE post_id = sp.post_id)
                        )
                    ELSE NULL 
                END AS shared_post
             FROM messages m
             LEFT JOIN users u ON m.sender_id = u.user_id
             LEFT JOIN posts sp ON m.shared_post_id = sp.post_id
             LEFT JOIN users au ON sp.author_id = au.user_id
             WHERE m.conversation_id = $1 
             AND ($2::boolean = false OR m.created_at >= $3)
             ORDER BY m.created_at ASC`,
            [conversation_id, is_group, joined_at, userId]
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
            `SELECT n.*, 
                    u.full_name as actor_name, 
                    u.avatar_url as actor_avatar 
             FROM notifications n 
             LEFT JOIN users u ON n.sender_id = u.user_id 
             WHERE n.user_id = $1 
             AND NOT EXISTS (SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = n.sender_id)
             ORDER BY n.created_at DESC`,
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
    RETURNING * `,
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

// Batch share post to multiple conversations
exports.sharePostToConversations = async (req, res) => {
    const senderId = req.user.sub;
    const { postId, targetUserIds, message } = req.body;

    if (!postId || !targetUserIds || !Array.isArray(targetUserIds) || targetUserIds.length === 0) {
        return res.status(400).json({ message: "postId and targetUserIds (array) are required" });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Fetch sender info once
        const senderRes = await client.query(
            `SELECT full_name, avatar_url FROM users WHERE user_id = $1`,
            [senderId]
        );
        if (senderRes.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: "Sender not found" });
        }
        const { full_name: senderName, avatar_url: senderAvatar } = senderRes.rows[0];

        // 2. Fetch shared post details once
        let sharedPostData = null;
        const spRes = await client.query(`
    SELECT
    p.post_id, p.content, p.created_at,
        json_build_object('full_name', u.full_name, 'avatar_url', u.avatar_url) as author,
        (SELECT json_agg(json_build_object('url', url, 'media_type', media_type)) FROM post_media WHERE post_id = p.post_id) as media
            FROM posts p
            JOIN users u ON p.author_id = u.user_id
            WHERE p.post_id = $1
        `, [postId]);

        if (spRes.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: "Shared post not found" });
        }
        sharedPostData = spRes.rows[0];

        const results = [];

        // 3. Process each target user
        for (const targetUserId of targetUserIds) {
            if (targetUserId === senderId) continue; // Skip self

            // A. Check/Create Conversation
            let conversationId;
            const existingConv = await client.query(
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
                const convRes = await client.query(
                    `INSERT INTO conversations(is_group) VALUES(FALSE) RETURNING conversation_id`
                );
                conversationId = convRes.rows[0].conversation_id;

                await client.query(
                    `INSERT INTO conversation_participants(conversation_id, user_id) VALUES($1, $2), ($1, $3)`,
                    [conversationId, senderId, targetUserId]
                );
            }

            // B. Insert Message
            const msgRes = await client.query(
                `INSERT INTO messages(conversation_id, sender_id, text_content, shared_post_id)
    VALUES($1, $2, $3, $4) RETURNING * `,
                [conversationId, senderId, message || '', postId]
            );

            // C. Update Conversation Timestamp
            await client.query(
                `UPDATE conversations SET updated_at = now() WHERE conversation_id = $1`,
                [conversationId]
            );

            // D. Notify (Fire and forget, but keep data for it)
            const mData = { ...msgRes.rows[0], shared_post: sharedPostData };
            results.push({ targetUserId, conversationId, messageData: mData });
        }

        await client.query('COMMIT');

        // 4. Send socket notifications (after commit)
        results.forEach(({ targetUserId, conversationId, messageData }) => {
            socketService.notifyUser(targetUserId, "newMessage", messageData);
            socketService.notifyUser(targetUserId, "notification", {
                type: "message",
                from: senderId,
                senderName,
                senderAvatar,
                conversationId,
                text: "Shared a post"
            });
        });

        res.status(200).json({
            message: "Shared successfully",
            sentCount: results.length
        });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Batch share error:", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

/* =====================================================
   BLOCKING
   ===================================================== */
exports.blockUser = async (req, res) => {
    const userId = req.user.sub;
    const targetId = req.params.id;

    if (userId === targetId) {
        return res.status(400).json({ message: "Cannot block yourself" });
    }

    try {
        const BlockModel = require("../models/block.model");
        const { checkBlockStatus } = require("../utils/blockCheck");

        // Use the model to block
        await BlockModel.blockUser(userId, targetId);

        // Also remove any existing connections logic?
        // Ideally blocking should unfollow/unconnect. 
        // Let's do that for consistency.
        await pool.query(
            `DELETE FROM followers WHERE(follower_id = $1 AND following_id = $2) OR(follower_id = $2 AND following_id = $1)`,
            [userId, targetId]
        );
        await pool.query(
            `DELETE FROM connections WHERE(user_id = $1 AND connected_user_id = $2) OR(user_id = $2 AND connected_user_id = $1)`,
            [userId, targetId]
        );
        // Also delete pending requests
        await pool.query(
            `DELETE FROM connection_requests WHERE(sender_id = $1 AND receiver_id = $2) OR(sender_id = $2 AND receiver_id = $1)`,
            [userId, targetId]
        );

        res.json({ message: "User blocked successfully" });
    } catch (err) {
        console.error("Block user error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.unblockUser = async (req, res) => {
    const userId = req.user.sub;
    const targetId = req.params.id;

    try {
        const BlockModel = require("../models/block.model");
        await BlockModel.unblockUser(userId, targetId);
        res.json({ message: "User unblocked successfully" });
    } catch (err) {
        console.error("Unblock user error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.getBlockedUsers = async (req, res) => {
    const userId = req.user.sub;
    try {
        const BlockModel = require("../models/block.model");
        // Get list of users *I* have blocked
        const blockedUsers = await BlockModel.getBlockedUsersDetails(userId);
        res.json(blockedUsers);
    } catch (err) {
        console.error("Get blocked users error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};
