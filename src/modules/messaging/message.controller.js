const pool = require("../../core/db/pool");
const socketService = require("../../core/infrastructure/socket.service");
const GroupChatService = require("../../services/groupChat.service"); // If logic is shared or similar

exports.deleteMessage = async (req, res) => {
    const { messageId } = req.params;
    const { deleteForEveryone } = req.body; // boolean
    const userId = req.user.sub || req.user.user_id;

    try {
        const client = await pool.connect();
        try {
            await client.query("BEGIN");

            // 1. Fetch message details
            const msgRes = await client.query(
                `SELECT * FROM messages WHERE message_id = $1`,
                [messageId]
            );

            if (msgRes.rowCount === 0) {
                await client.query("ROLLBACK");
                return res.status(404).json({ message: "Message not found" });
            }

            const message = msgRes.rows[0];

            // 2. Validate permissions
            // Only sender can delete for everyone
            if (deleteForEveryone && message.sender_id !== userId) {
                await client.query("ROLLBACK");
                return res.status(403).json({ message: "You can only delete your own messages for everyone" });
            }

            // Ideally check if user is participant of conversation (though accessing message implies it usually)
            // But let's skip for brevity or enhance security later if needed.

            if (deleteForEveryone) {
                // DELETE FOR EVERYONE
                // 1. Delete associated media
                await client.query("DELETE FROM message_media WHERE message_id = $1", [messageId]);

                // 2. Soft delete: Update message content
                // Keep the row, mark as deleted
                await client.query(
                    `UPDATE messages 
                     SET is_deleted_for_everyone = TRUE, 
                         deleted_at = NOW()
                     WHERE message_id = $1`,
                    [messageId]
                );

                // Notify via Socket
                // We need conversation ID to room targeting
                const conversationId = message.conversation_id;

                // Construct socket payload
                const socketPayload = {
                    messageId,
                    conversationId,
                    deleteType: 'everyone',
                    deletedAt: new Date().toISOString()
                };

                // Emit to room
                socketService.notifyConversation(conversationId, "message_deleted", socketPayload);

                // Emit conversation-updated to refresh sidebar
                socketService.notifyConversation(conversationId, "conversation-updated", {
                    conversationId,
                    lastMessage: "This message was deleted", // Simple placeholder, frontend fetches real state or uses this
                    updatedAt: new Date().toISOString()
                });

            } else {
                // DELETE FOR ME
                // Insert into message_delete table
                await client.query(
                    `INSERT INTO message_delete (message_id, user_id) 
                     VALUES ($1, $2) 
                     ON CONFLICT (message_id, user_id) DO NOTHING`,
                    [messageId, userId]
                );

                // Notify via Socket (Only to the user)
                const socketPayload = {
                    messageId,
                    conversationId: message.conversation_id,
                    deleteType: 'me',
                    deletedAt: new Date().toISOString()
                };

                socketService.notifyUser(userId, "message_deleted", socketPayload);

                // Emit conversation-updated to refresh sidebar for THIS user
                socketService.notifyUser(userId, "conversation-updated", {
                    conversationId: message.conversation_id,
                    lastMessage: null, // Let frontend fetch or use previous
                    updatedAt: new Date().toISOString()
                });
            }

            await client.query("COMMIT");
            res.json({ success: true, message: "Message deleted" });

        } catch (err) {
            await client.query("ROLLBACK");
            throw err;
        } finally {
            client.release();
        }
    } catch (err) {
        console.error("Delete message error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};
