const pool = require("../db/pool");

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
        console.error("Follow error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

// Unfollow a user
exports.unfollowUser = async (req, res) => {
    const followerId = req.user.sub;
    const { id } = req.params;

    try {
        const result = await pool.query(
            `DELETE FROM followers WHERE follower_id = $1 AND following_id = $2 RETURNING *`,
            [followerId, id]
        );

        if (result.rowCount === 0) 
            return res.status(404).json({ message: "You are not following this user" });

        res.json({ message: "Unfollowed successfully" });
    } catch (err) {
        console.error("Unfollow error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

// Get all conversations of logged-in user
exports.getConversations = async (req, res) => {
    const userId = req.user.sub;

    try {
        const result = await pool.query(
            `SELECT c.*
             FROM conversations c
             JOIN conversation_participants cp ON c.conversation_id = cp.conversation_id
             WHERE cp.user_id = $1
             ORDER BY c.updated_at DESC`,
            [userId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error("Get conversations error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

// Start a new 1-on-1 conversation
exports.startConversation = async (req, res) => {
    const senderId = req.user.sub;
    const { targetUserId } = req.body;

    if (senderId === targetUserId)
        return res.status(400).json({ message: "Cannot start a conversation with yourself" });

    try {
        let conversationId;
        let isNew = false;

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
            isNew = true;
            await pool.query('BEGIN');
            try {
                const convRes = await pool.query(
                    `INSERT INTO conversations (is_group) VALUES (FALSE) RETURNING conversation_id`
                );
                conversationId = convRes.rows[0].conversation_id;

                await pool.query(
                    `INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2), ($1, $3)`,
                    [conversationId, senderId, targetUserId]
                );

                await pool.query('COMMIT');
            } catch (err) {
                await pool.query('ROLLBACK');
                throw err;
            }
        }

        res.status(isNew ? 201 : 200).json({
            message: isNew ? "Conversation created successfully" : "Conversation already exists",
            conversationId
        });

    } catch (err) {
        console.error("Start conversation error:", err);
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
            await pool.query('BEGIN');
            try {
                const convRes = await pool.query(
                    `INSERT INTO conversations (is_group) VALUES (FALSE) RETURNING conversation_id`
                );
                conversationId = convRes.rows[0].conversation_id;

                await pool.query(
                    `INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2), ($1, $3)`,
                    [conversationId, senderId, targetUserId]
                );

                await pool.query('COMMIT');
            } catch (err) {
                await pool.query('ROLLBACK');
                throw err;
            }
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

        res.status(201).json({ 
            conversationId,
            message: "Message sent successfully",
            data: msgRes.rows[0]
        });
    } catch (err) {
        console.error("Send message error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

// Get all messages in a conversation
exports.getMessages = async (req, res) => {
    const userId = req.user.sub;
    const { id } = req.params;

    try {
        const partCheck = await pool.query(
            `SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2`,
            [id, userId]
        );

        if (partCheck.rowCount === 0) 
            return res.status(403).json({ message: "Not a participant" });

        const result = await pool.query(
            `SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
            [id]
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
    const { id } = req.params;

    try {
        const result = await pool.query(
            `DELETE FROM messages WHERE message_id = $1 AND sender_id = $2 RETURNING *`,
            [id, userId]
        );

        if (result.rowCount === 0) 
            return res.status(404).json({ message: "Message not found or not authorized" });

        res.json({ message: "Message deleted successfully" });
    } catch (err) {
        console.error("Delete message error:", err);
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
            `UPDATE notifications SET is_read = TRUE WHERE notification_id = $1 AND user_id = $2 RETURNING *`,
            [id, userId]
        );

        if (result.rowCount === 0) 
            return res.status(404).json({ message: "Notification not found" });

        res.json({ message: "Notification marked as read", notification: result.rows[0] });
    } catch (err) {
        console.error("Mark notification read error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};
