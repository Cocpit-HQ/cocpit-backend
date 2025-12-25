const pool = require("../db/pool");

exports.followUser = async (req, res) => {
    const followerId = req.user.sub;
    const { id } = req.params; // following_id

    if (followerId === id) return res.status(400).json({ message: "Cannot follow yourself" });

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

exports.getConversations = async (req, res) => {
    const userId = req.user.sub;
    try {
        // Get conversations where user is a participant
        // Also fetch last message? Schema has `messages` table but no `last_message` in conversations.
        // We can join or just list conversations.
        const result = await pool.query(
            `
            SELECT c.*
            FROM conversations c
            JOIN conversation_participants cp ON c.conversation_id = cp.conversation_id
            WHERE cp.user_id = $1
            ORDER BY c.updated_at DESC
            `,
            [userId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error("Get conversations error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.sendMessage = async (req, res) => {
    const senderId = req.user.sub;
    const { id } = req.params; // conversation_id OR user_id to start new?
    // Let's assume ID is conversation_id. To start new, we might need a different endpoint or logic.
    // For MVP, assuming conversation exists.
    // Wait, typical flow: Open chat with User X -> Check if conv exists -> if not create -> then send.
    // Let's handle "Start Conversation" separately or here?
    // The plan says "Start conversation" is separate.

    const { text_content } = req.body;

    try {
         // Verify participation
         const partCheck = await pool.query(
             `SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2`,
             [id, senderId]
         );
         if (partCheck.rowCount === 0) return res.status(403).json({ message: "Not a participant" });

         const result = await pool.query(
             `
             INSERT INTO messages (conversation_id, sender_id, text_content)
             VALUES ($1, $2, $3)
             RETURNING *
             `,
             [id, senderId, text_content]
         );

         // Update conversation timestamp
         await pool.query(`UPDATE conversations SET updated_at = now() WHERE conversation_id = $1`, [id]);

         res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error("Send message error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.startConversation = async (req, res) => {
    const userId = req.user.sub;
    const { targetUserId } = req.body;

    try {
        // Check if 1-on-1 already exists
        // This is complex in SQL without explicit type. Assuming is_group=FALSE
        // We look for a conversation with exactly these 2 participants.
        // Simplified: Create new always or just check.
        // Let's create a new one for now or check.

        await pool.query('BEGIN');

        const convRes = await pool.query(`INSERT INTO conversations (is_group) VALUES (FALSE) RETURNING conversation_id`);
        const convId = convRes.rows[0].conversation_id;

        await pool.query(`INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2)`, [convId, userId]);
        await pool.query(`INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2)`, [convId, targetUserId]);

        await pool.query('COMMIT');

        res.status(201).json({ conversationId: convId });
    } catch (err) {
        await pool.query('ROLLBACK');
        console.error("Start conversation error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

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
