const pool = require("../db/pool");

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

    static async addMember({ groupId, userId, role = 'member', status = 'joined' }) {
        // Note: 'role' and 'status' columns might need to be added to conversation_participants if not present.
        // Based on my migration, I didn't add role/status to participants, I relied on group_invitations for status.
        // But for the admin adding themselves, or accepting invite, we insert into participants.
        // If table doesn't have role/status, we just insert.
        // Let's assume standard join for now.
        const result = await pool.query(
            `INSERT INTO conversation_participants (conversation_id, user_id) 
      VALUES ($1, $2) 
      ON CONFLICT (conversation_id, user_id) 
      DO UPDATE SET left_at = NULL, joined_at = now()
      RETURNING *`,
            [groupId, userId]
        );
        return result.rows[0];
    }

    static async removeMember(groupId, userId) {
        // Soft delete (leave)
        await pool.query(
            `UPDATE conversation_participants SET left_at = now() WHERE conversation_id = $1 AND user_id = $2`,
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
      DO UPDATE SET status = 'pending', inviter_id = $2, updated_at = now()
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
              COALESCE(c.conversation_name, c.name, 'Unnamed Group') as group_name, 
              COALESCE(c.group_avatar, c.avatar_url) as group_avatar,
              u.full_name as inviter_name
       FROM group_invitations gi
       LEFT JOIN conversations c ON gi.conversation_id = c.conversation_id
       LEFT JOIN users u ON gi.inviter_id = u.user_id
       WHERE gi.invitee_id = $1 AND gi.status = 'pending'`,
            [userId]
        );

        return result.rows;
    }

    static async getGroupDetails(groupId) {
        const groupRes = await pool.query(
            `SELECT * FROM conversations WHERE conversation_id = $1 AND is_group = true`,
            [groupId]
        );
        return groupRes.rows[0];
    }

    static async getGroupMembers(groupId) {
        const result = await pool.query(
            `SELECT u.user_id, u.full_name, u.avatar_url, u.headline, cp.joined_at, cp.left_at 
       FROM conversation_participants cp
       JOIN users u ON cp.user_id = u.user_id
       WHERE cp.conversation_id = $1 AND cp.left_at IS NULL`,
            [groupId]
        );
        return result.rows;
    }
    static async createMessage({ groupId, senderId, content, type = 'text', actionType = null, targetId = null }) {
        const result = await pool.query(
            `INSERT INTO messages (conversation_id, sender_id, text_content, message_type, action_type, target_id) 
       VALUES ($1, $2, $3, $4, $5, $6) 
       RETURNING *`,
            [groupId, senderId, content, type, actionType, targetId]
        );
        return result.rows[0];
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
}

module.exports = GroupChatModel;
