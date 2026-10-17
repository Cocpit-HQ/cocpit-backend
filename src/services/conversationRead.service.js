const pool = require("../core/db/pool");
const socketService = require("../core/infrastructure/socket.service");

async function markConversationAsRead({ conversationId, userId, companyId = null }) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const participation = await client.query(
      `
      UPDATE conversation_participants
      SET last_read_at = NOW()
      WHERE conversation_id = $1
      AND (
        ($3::uuid IS NOT NULL AND org_id = $3)
        OR
        ($3::uuid IS NULL AND user_id = $2)
      )
      AND left_at IS NULL
      RETURNING last_read_at
      `,
      [conversationId, userId, companyId]
    );

    if (participation.rowCount === 0) {
      // Check if there is a pending group invitation for this user/conversation
      const groupInvitationCheck = await client.query(
        `
        UPDATE group_invitations
        SET updated_at = NOW()
        WHERE conversation_id = $1 AND invitee_id = $2 AND status = 'pending'
        RETURNING updated_at
        `,
        [conversationId, userId]
      );

      if (groupInvitationCheck.rowCount > 0) {
        await client.query("COMMIT");
        const readAt = groupInvitationCheck.rows[0].updated_at || new Date().toISOString();
        
        socketService.notifyUser(userId, "invitation_update", {
          conversationId,
          isRead: true,
          readAt,
        });

        return {
          readAt,
          readCount: 1,
          messageIds: [],
        };
      }

      const err = new Error("Conversation not found or access denied");
      err.statusCode = 404;
      throw err;
    }

    const unreadMessagesRes = await client.query(
      `
      SELECT m.message_id
      FROM messages m
      JOIN conversation_participants cp
        ON cp.conversation_id = m.conversation_id
      WHERE m.conversation_id = $1
      AND (
        ($3::uuid IS NOT NULL AND cp.org_id = $3)
        OR
        ($3::uuid IS NULL AND cp.user_id = $2)
      )
      AND cp.left_at IS NULL
      AND m.created_at >= cp.joined_at
      AND (
        ($3::uuid IS NOT NULL AND (m.author_org_id != $3 OR m.author_org_id IS NULL))
        OR
        ($3::uuid IS NULL AND (m.author_org_id IS NOT NULL OR m.sender_id != $2 OR m.sender_id IS NULL))
      )
      AND NOT EXISTS (
        SELECT 1
        FROM message_reads mr
        WHERE mr.message_id = m.message_id
        AND mr.user_id = $2
      )
      `,
      [conversationId, userId, companyId]
    );

    const unreadMsgIds = unreadMessagesRes.rows.map((r) => r.message_id);

    if (unreadMsgIds.length > 0) {
      const values = unreadMsgIds
        .map((_, idx) => `($${idx * 2 + 1}, $${idx * 2 + 2})`)
        .join(", ");
      const params = [];
      unreadMsgIds.forEach((msgId) => {
        params.push(msgId, userId);
      });

      await client.query(
        `INSERT INTO message_reads (message_id, user_id) VALUES ${values} ON CONFLICT DO NOTHING`,
        params
      );

      await client.query(
        `
        UPDATE messages
        SET read_at = NOW()
        WHERE message_id = ANY($1)
        AND read_at IS NULL
        `,
        [unreadMsgIds]
      );
    }

    await client.query("COMMIT");

    const readAt = participation.rows[0].last_read_at || new Date().toISOString();

    if (unreadMsgIds.length > 0) {
      socketService.notifyConversation(conversationId, "messages_seen", {
        conversationId,
        readerId: userId,
        messageIds: unreadMsgIds,
        readAt,
      });
    }

    return {
      readAt,
      readCount: unreadMsgIds.length,
      messageIds: unreadMsgIds,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  markConversationAsRead,
};

