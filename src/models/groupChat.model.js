const pool = require("../core/db/pool");

class GroupChatModel {
    static async createGroup({ adminId, name, description, avatarUrl }) {
        const result = await pool.query(
            `INSERT INTO conversations 
      (is_group, conversation_name, description, group_avatar, admin_id) 
      VALUES (true, $1, $2, $3, $4) 
      RETURNING *`,
            [name, description, avatarUrl, adminId]
        );
        return result.rows[0];
    }

    static async addMember({ groupId, userId, role = 'member' }) {
        // 1. Check if user is ALREADY an active member
        const activeRes = await pool.query(
            `SELECT * FROM conversation_participants 
             WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`,
            [groupId, userId]
        );

        if (activeRes.rowCount > 0) {
            return activeRes.rows[0];
        }

        // 2. If not active, always insert a NEW record for the new period
        const result = await pool.query(
            `INSERT INTO conversation_participants (conversation_id, user_id, role, joined_at, left_at) 
             VALUES ($1, $2, $3, now(), NULL) 
             RETURNING *`,
            [groupId, userId, role]
        );
        return result.rows[0];
    }

    static async removeMember(groupId, userId) {
        // Soft delete (leave) - Only update the ACTIVE membership
        await pool.query(
            `UPDATE conversation_participants 
             SET left_at = now(),
                 left_group_name = (SELECT conversation_name FROM conversations WHERE conversation_id = $1),
                 left_group_avatar = (SELECT group_avatar FROM conversations WHERE conversation_id = $1),
                 left_group_description = (SELECT description FROM conversations WHERE conversation_id = $1),
                 left_group_headline = (SELECT group_headline FROM conversations WHERE conversation_id = $1)
             WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`,
            [groupId, userId]
        );
    }

    static async hardDeleteMember(groupId, userId) {
        // Strict Hard Delete
        await pool.query(
            `DELETE FROM conversation_participants 
             WHERE conversation_id = $1 AND user_id = $2`,
            [groupId, userId]
        );
    }

    static async deleteMemberRow(groupId, userId) {
        // Hard delete
        await pool.query(
            `DELETE FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2`,
            [groupId, userId]
        );
    }

    static async deleteGroup(groupId) {
        await pool.query(`DELETE FROM conversations WHERE conversation_id = $1`, [groupId]);
    }

    static async createInvitation({ groupId, senderId, receiverId }) {
        const result = await pool.query(
            `INSERT INTO group_invitations (conversation_id, inviter_id, invitee_id, status) 
      VALUES ($1, $2, $3, 'pending') 
      ON CONFLICT (conversation_id, invitee_id) 
      DO UPDATE SET status = 'pending', inviter_id = $2, updated_at = now(), created_at = now()
      RETURNING *`,
            [groupId, senderId, receiverId]
        );
        return result.rows[0];
    }

    static async getInvitation({ groupId, receiverId }) {
        const result = await pool.query(
            `SELECT * FROM group_invitations WHERE conversation_id = $1 AND invitee_id = $2`,
            [groupId, receiverId]
        );
        return result.rows[0];
    }

    static async getInvitationById(invitationId) {
        const result = await pool.query(
            `SELECT * FROM group_invitations WHERE invitation_id = $1`,
            [invitationId]
        );
        return result.rows[0];
    }

    static async deleteInvitation(invitationId) {
        const result = await pool.query(
            `DELETE FROM group_invitations WHERE invitation_id = $1 RETURNING *`,
            [invitationId]
        );
        return result.rows[0];
    }

    static async updateInvitationStatus(invitationId, status) {
        const result = await pool.query(
            `UPDATE group_invitations SET status = $1, updated_at = now() 
      WHERE invitation_id = $2 
      RETURNING *`,
            [status, invitationId]
        );
        return result.rows[0];
    }

    static async getPendingInvitations(userId) {

        // Simplified query to test stability
        const result = await pool.query(
            `SELECT gi.invitation_id, gi.conversation_id, gi.status, gi.created_at,
              COALESCE(c.conversation_name, 'Unnamed Group') as group_name, 
              COALESCE(c.group_avatar) as group_avatar,
              u.full_name as inviter_name
       FROM group_invitations gi
       LEFT JOIN conversations c ON gi.conversation_id = c.conversation_id AND c.is_active = TRUE
       LEFT JOIN users u ON gi.inviter_id = u.user_id
       WHERE gi.invitee_id = $1 AND gi.status = 'pending'`,
            [userId]
        );

        return result.rows;
    }

    static async getGroupDetails(groupId) {
        const groupRes = await pool.query(
            `SELECT * FROM conversations WHERE conversation_id = $1 AND is_group = true AND is_active = TRUE`,
            [groupId]
        );
        return groupRes.rows[0];
    }

    static async getGroupMembers(groupId, maxJoinedAt = null, viewerId = null) {
        const viewerParamIndex = maxJoinedAt ? '$3' : '$2';
        const blockCheckClause = viewerId ? `
            EXISTS (
                SELECT 1 FROM blocks b 
                WHERE (b.blocker_id = ${viewerParamIndex}::uuid AND b.blocked_id = COALESCE(u.user_id, c.org_id))
                   OR (b.blocked_id = ${viewerParamIndex}::uuid AND b.blocker_id = COALESCE(u.user_id, c.org_id))
            )
        ` : 'false';

        const blockedByMeClause = viewerId ? `
            EXISTS (
                SELECT 1 FROM blocks b 
                WHERE b.blocker_id = ${viewerParamIndex}::uuid AND b.blocked_id = COALESCE(u.user_id, c.org_id)
            )
        ` : 'false';

        const blockedByOtherClause = viewerId ? `
            EXISTS (
                SELECT 1 FROM blocks b 
                WHERE b.blocked_id = ${viewerParamIndex}::uuid AND b.blocker_id = COALESCE(u.user_id, c.org_id)
            )
        ` : 'false';

        const query = maxJoinedAt ?
            `SELECT * FROM (
                SELECT DISTINCT ON (COALESCE(u.user_id, c.org_id)) 
                    COALESCE(u.user_id, c.org_id) as user_id, 
                    u.account_name, u.account_name as username, 
                    CASE 
                        WHEN ${blockedByOtherClause} THEN (CASE WHEN c.org_id IS NOT NULL THEN 'Unknown Page' ELSE 'Unknown user' END)
                        WHEN u.is_deactivated = TRUE OR u.deletion_execute_at IS NOT NULL THEN 'Unknown User'
                        WHEN c.org_id IS NOT NULL AND (c.is_deleted = TRUE OR c.is_deactivated = TRUE) THEN 'Unknown Page'
                        ELSE COALESCE(c.name, u.full_name)
                    END as full_name,
                    CASE 
                        WHEN ${blockedByOtherClause} THEN NULL
                        WHEN u.is_deactivated = TRUE OR u.deletion_execute_at IS NOT NULL THEN NULL
                        WHEN c.org_id IS NOT NULL AND (c.is_deleted = TRUE OR c.is_deactivated = TRUE) THEN NULL
                        ELSE COALESCE(c.logo_url, u.avatar_url)
                    END as avatar_url,
                    CASE 
                        WHEN ${blockedByOtherClause} THEN 'User unavailable'
                        WHEN u.is_deactivated = TRUE OR u.deletion_execute_at IS NOT NULL THEN 'User unavailable'
                        ELSE u.headline
                    END as headline,
                    c.name as org_name, c.logo_url as org_logo, cp.joined_at, cp.role,
                    'accepted' as status,
                    false as "isPending",
                    CAST(NULL AS UUID) as invitation_id,
                    (${blockCheckClause}) as is_blocked,
                    (${blockedByMeClause}) as is_blocked_by_me,
                    (${blockedByOtherClause}) as is_blocked_by_other,
                    (COALESCE(u.is_deactivated, c.is_deactivated, false) = TRUE) as is_deactivated,
                    (u.deletion_execute_at IS NOT NULL OR COALESCE(c.is_deleted, false) = TRUE) as is_deleted,
                    ((${blockCheckClause}) OR COALESCE(u.is_deactivated, c.is_deactivated, false) = TRUE OR u.deletion_execute_at IS NOT NULL OR COALESCE(c.is_deleted, false) = TRUE) as is_unavailable
                 FROM conversation_participants cp
                 LEFT JOIN users u ON cp.user_id = u.user_id
                 LEFT JOIN organizations c ON cp.org_id = c.org_id
                 WHERE cp.conversation_id = $1 
                 AND cp.joined_at <= $2
                 AND (cp.left_at IS NULL OR cp.left_at > $2)
                 ORDER BY COALESCE(u.user_id, c.org_id), cp.joined_at DESC
             ) active_members` :
            `SELECT * FROM (
                SELECT DISTINCT ON (COALESCE(u.user_id, c.org_id)) 
                    COALESCE(u.user_id, c.org_id) as user_id, 
                    u.account_name, u.account_name as username, 
                    CASE 
                        WHEN ${blockedByOtherClause} THEN (CASE WHEN c.org_id IS NOT NULL THEN 'Unknown Page' ELSE 'Unknown user' END)
                        WHEN u.is_deactivated = TRUE OR u.deletion_execute_at IS NOT NULL THEN 'Unknown User'
                        WHEN c.org_id IS NOT NULL AND (c.is_deleted = TRUE OR c.is_deactivated = TRUE) THEN 'Unknown Page'
                        ELSE COALESCE(c.name, u.full_name)
                    END as full_name,
                    CASE 
                        WHEN ${blockedByOtherClause} THEN NULL
                        WHEN u.is_deactivated = TRUE OR u.deletion_execute_at IS NOT NULL THEN NULL
                        WHEN c.org_id IS NOT NULL AND (c.is_deleted = TRUE OR c.is_deactivated = TRUE) THEN NULL
                        ELSE COALESCE(c.logo_url, u.avatar_url)
                    END as avatar_url,
                    CASE 
                        WHEN ${blockedByOtherClause} THEN 'User unavailable'
                        WHEN u.is_deactivated = TRUE OR u.deletion_execute_at IS NOT NULL THEN 'User unavailable'
                        ELSE u.headline
                    END as headline,
                    c.name as org_name, c.logo_url as org_logo, cp.joined_at, cp.role,
                    'accepted' as status,
                    false as "isPending",
                    CAST(NULL AS UUID) as invitation_id,
                    (${blockCheckClause}) as is_blocked,
                    (${blockedByMeClause}) as is_blocked_by_me,
                    (${blockedByOtherClause}) as is_blocked_by_other,
                    (COALESCE(u.is_deactivated, c.is_deactivated, false) = TRUE) as is_deactivated,
                    (u.deletion_execute_at IS NOT NULL OR COALESCE(c.is_deleted, false) = TRUE) as is_deleted,
                    ((${blockCheckClause}) OR COALESCE(u.is_deactivated, c.is_deactivated, false) = TRUE OR u.deletion_execute_at IS NOT NULL OR COALESCE(c.is_deleted, false) = TRUE) as is_unavailable
                 FROM conversation_participants cp
                 LEFT JOIN users u ON cp.user_id = u.user_id
                 LEFT JOIN organizations c ON cp.org_id = c.org_id
                 WHERE cp.conversation_id = $1 AND cp.left_at IS NULL
                 ORDER BY COALESCE(u.user_id, c.org_id), cp.joined_at DESC
             ) active_members`;

        let params = [groupId];
        if (maxJoinedAt) params.push(maxJoinedAt);
        if (viewerId) params.push(viewerId);

        const result = await pool.query(query, params);
        return result.rows;
    }
    static async getParticipant(groupId, userId) {
        const query = `
            SELECT role, joined_at, left_at,
                   left_group_name, left_group_avatar,
                   left_group_description, left_group_headline 
            FROM conversation_participants 
            WHERE conversation_id = $1 AND user_id = $2
            ORDER BY joined_at DESC
            LIMIT 1
        `;
        const result = await pool.query(query, [groupId, userId]);
        return result.rows[0];
    }

    static async getAdminCount(groupId) {
        const query = `
            SELECT COUNT(*)::int as count
            FROM conversation_participants
            WHERE conversation_id = $1 AND role = 'admin' AND left_at IS NULL
        `;
        const result = await pool.query(query, [groupId]);
        return result.rows[0].count;
    }

    static async updateMemberRole(groupId, userId, role) {
        const query = `
            UPDATE conversation_participants
            SET role = $3
            WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL
            RETURNING *
        `;
        const result = await pool.query(query, [groupId, userId, role]);
        return result.rows[0];
    }
    static async createMessage({
        groupId,
        senderId,
        content,
        type = 'text',
        actionType = null,
        targetId = null,
        previewText = null,
        replyMessageId = null,
        shared_post_id = null,
        shared_profile_id = null,
        shared_profile_type = null,
        entity_type = null,
        entity_id = null
    }) {
        const result = await pool.query(
            `INSERT INTO messages (
                conversation_id, sender_id, text_content, message_type, action_type, target_id, replied_msg_id,
                shared_post_id, shared_profile_id, shared_profile_type, entity_type, entity_id
             ) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) 
             RETURNING *`,
            [
                groupId, senderId, content, type, actionType, targetId, replyMessageId,
                shared_post_id, shared_profile_id, shared_profile_type, entity_type, entity_id
            ]
        );

        // Update conversation timestamp and last message for sorting
        // Use previewText if provided, otherwise content
        const lastMessageText = previewText !== null ? previewText : content;

        await pool.query(
            `UPDATE conversations 
             SET updated_at = now(),
                 last_message = $2,
                 last_message_at = now()
             WHERE conversation_id = $1`,
            [groupId, lastMessageText]
        );

        return result.rows[0];
    }

    static async addMessageMedia(messageId, mediaRecords) {
        if (!mediaRecords || mediaRecords.length === 0) return [];

        const values = mediaRecords.map(m => [messageId, m.url, m.type, m.name]);
        const placeholders = values.map((_, i) => `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`).join(', ');
        const flatValues = values.flat();

        const result = await pool.query(
            `INSERT INTO message_media (message_id, url, media_type, filename)
             VALUES ${placeholders}
             RETURNING url, media_type, filename`,
            flatValues
        );
        return result.rows;
    }

    static async getGroupInvitations(groupId) {
        const result = await pool.query(
            `SELECT gi.invitation_id, gi.invitee_id, gi.status, gi.created_at,
                    u.full_name as invitee_name, u.avatar_url as invitee_avatar
             FROM group_invitations gi
             JOIN users u ON gi.invitee_id = u.user_id
             WHERE gi.conversation_id = $1 AND gi.status = 'pending'`,
            [groupId]
        );
        return result.rows;
    }
    static async updateGroupAvatar(groupId, avatarUrl) {
        const result = await pool.query(
            `UPDATE conversations 
             SET group_avatar = $1 
             WHERE conversation_id = $2 
             RETURNING *`,
            [avatarUrl, groupId]
        );
        return result.rows[0];
    }

    static async updateGroupDetails(groupId, { name, headline, description, avatar }) {
        const fields = [];
        const values = [];
        let idx = 1;

        if (name !== undefined) {
            fields.push(`conversation_name = $${idx++}`);
            values.push(name);
        }
        if (headline !== undefined) {
            fields.push(`group_headline = $${idx++}`);
            values.push(headline);
        }
        if (description !== undefined) {
            fields.push(`description = $${idx++}`);
            values.push(description);
        }
        if (avatar !== undefined) {
            fields.push(`group_avatar = $${idx++}`);
            values.push(avatar);
        }

        if (fields.length === 0) return null;

        fields.push(`updated_at = now()`);
        values.push(groupId);

        const query = `
            UPDATE conversations 
            SET ${fields.join(", ")} 
            WHERE conversation_id = $${idx} 
            RETURNING *
        `;

        const result = await pool.query(query, values);
        return result.rows[0];
    }
    static async updateGroupOwner(groupId, newAdminId) {
        await pool.query(
            `UPDATE conversations SET admin_id = $2 WHERE conversation_id = $1`,
            [groupId, newAdminId]
        );
    }

    // --- Read Receipts ---

    static async markMessagesAsRead(userId, groupId) {
        // 1. Insert into message_reads
        // Only mark messages sent AFTER the user joined the group (prevents
        // late-joining members from appearing in "Read by" for older messages)
        const result = await pool.query(
            `INSERT INTO message_reads (message_id, user_id, read_at)
             SELECT m.message_id, $1, NOW()
             FROM messages m
             JOIN conversation_participants cp
               ON cp.conversation_id = m.conversation_id
               AND cp.user_id = $1
               AND cp.left_at IS NULL
             WHERE m.conversation_id = $2
               AND m.sender_id != $1
               AND m.created_at >= cp.joined_at
               AND m.message_type != 'system'
             ON CONFLICT (message_id, user_id) DO NOTHING
             RETURNING message_id`,
            [userId, groupId]
        );

        // 2. Update conversation_participants last_read_at (Fixes sidebar count)
        await pool.query(
            `UPDATE conversation_participants
             SET last_read_at = NOW()
             WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`,
            [groupId, userId]
        );

        return result.rows;
    }

    static async getReadReceipts(messageId) {
        const result = await pool.query(
            `SELECT u.user_id, u.full_name, u.avatar_url, mr.read_at
             FROM message_reads mr
             JOIN users u ON mr.user_id = u.user_id
             WHERE mr.message_id = $1
             ORDER BY mr.read_at ASC`,
            [messageId]
        );
        return result.rows;
    }

    static async getUnreadCount(userId, groupId) {
        // Count messages in this group sent by others that don't have a read entry
        const result = await pool.query(
            `SELECT COUNT(*)
              FROM messages m
              JOIN conversation_participants cp ON m.conversation_id = cp.conversation_id
              WHERE m.conversation_id = $2
                AND cp.user_id = $1
                AND cp.left_at IS NULL
                AND m.sender_id != $1
                AND m.created_at >= cp.joined_at
                AND NOT EXISTS (
                    SELECT 1 FROM message_reads mr
                    WHERE mr.message_id = m.message_id
                      AND mr.user_id = $1
                )`,
            [userId, groupId]
        );
        return parseInt(result.rows[0].count, 10);
    }
}

module.exports = GroupChatModel;
