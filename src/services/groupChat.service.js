const GroupChatModel = require("../models/groupChat.model");
const socketService = require("../services/socket.service"); // Assuming existing socket service
const pool = require("../db/pool"); // For specific queries if model isn't enough or for transactions

class GroupChatService {
    static async createGroup(adminId, { name, description, avatarUrl, members }) {
        // 1. Create Group
        const group = await GroupChatModel.createGroup({ adminId, name, description, avatarUrl });

        // 2. Add Admin as Member
        await GroupChatModel.addMember({ groupId: group.conversation_id, userId: adminId });

        // Get admin name for system message
        const adminRes = await pool.query(`SELECT full_name FROM users WHERE user_id = $1`, [adminId]);
        const adminName = adminRes.rows[0]?.full_name || "Admin";

        // System message: Group created
        await GroupChatModel.createMessage({
            groupId: group.conversation_id,
            senderId: null,
            content: `${adminName} created the group "${name}"`,
            type: 'system',
            actionType: 'create_group'
        });

        // 3. Invite other initial members
        if (members && Array.isArray(members) && members.length > 0) {
            for (const memberId of members) {
                // Skip if admin is accidentally included in members list
                if (memberId !== adminId) {
                    try {
                        // Use static call to inviteMember
                        await GroupChatService.inviteMember(adminId, group.conversation_id, memberId);
                    } catch (err) {
                        console.error(`[GroupChatService] Initial invite failed for user ${memberId}:`, err.message);
                    }
                }
            }
        }

        return group;
    }

    static async inviteMember(senderId, groupId, receiverId) {
        // Verify admin
        const group = await GroupChatModel.getGroupDetails(groupId);
        if (!group) throw new Error("Group not found");
        if (group.admin_id !== senderId) {
            throw new Error("Only admin can invite members");
        }

        // Check if already a member
        const members = await GroupChatModel.getGroupMembers(groupId);
        if (members.find(m => m.user_id === receiverId)) {
            throw new Error("User is already a member");
        }

        // Check if invitation exists
        const existing = await GroupChatModel.getInvitation({ groupId, receiverId });
        if (existing && existing.status === 'pending') {
            throw new Error("Invitation already sent");
        }

        // Create invitation
        const invitation = await GroupChatModel.createInvitation({ groupId, senderId, receiverId });

        // Notify user via socket
        socketService.notifyUser(receiverId, 'group_invite', {
            invitation_id: invitation.invitation_id, // Ensure these exist on the created object
            group_id: groupId
        });

        return invitation;
    }

    static async getPendingInvitations(userId) {
        return await GroupChatModel.getPendingInvitations(userId);
    }

    static async acceptInvitation(userId, invitationId) {
        const invitation = await GroupChatModel.getInvitationById(invitationId);
        if (!invitation) throw new Error("Invitation not found");
        if (invitation.invitee_id !== userId) throw new Error("Unauthorized");
        if (invitation.status !== 'pending') throw new Error("Invitation not pending");

        // Update status
        await GroupChatModel.updateInvitationStatus(invitationId, 'accepted');

        // Add member
        await GroupChatModel.addMember({ groupId: invitation.conversation_id, userId });

        // System message: "User joined"
        const userRes = await pool.query(`SELECT full_name FROM users WHERE user_id = $1`, [userId]);
        const userName = userRes.rows[0]?.full_name || "A new member";

        const systemMsg = await GroupChatModel.createMessage({
            groupId: invitation.conversation_id,
            senderId: invitation.inviter_id, // The inviter is the "adder"
            content: `${userName} was added to the group`, // Fallback text
            type: 'system',
            actionType: 'add',
            targetId: userId
        });




        // Broadcast system message
        const members = await GroupChatModel.getGroupMembers(invitation.conversation_id);
        members.forEach(member => {
            socketService.notifyUser(member.user_id, 'new_message', {
                ...systemMsg,
                sender_name: 'System',
                is_system: true,
                conversation_id: invitation.conversation_id // Ensure conversation_id is present
            });
        });

        return { success: true, groupId: invitation.conversation_id };
    }

    static async rejectInvitation(userId, invitationId) {
        const invitation = await GroupChatModel.getInvitationById(invitationId);
        if (!invitation) throw new Error("Invitation not found");
        if (invitation.invitee_id !== userId) throw new Error("Unauthorized");

        await GroupChatModel.updateInvitationStatus(invitationId, 'rejected');
        return { success: true };
    }

    static async leaveGroup(userId, groupId) {
        // Get user name before removal
        const userRes = await pool.query(`SELECT full_name FROM users WHERE user_id = $1`, [userId]);
        const userName = userRes.rows[0]?.full_name || "A member";

        // Remove member (Soft delete via model update)
        await GroupChatModel.removeMember(groupId, userId);

        // System message: "User left"
        const systemMsg = await GroupChatModel.createMessage({
            groupId,
            senderId: userId, // The user is the actor
            content: `${userName} left the group`,
            type: 'system',
            actionType: 'leave',
            targetId: userId // Or null
        });




        const members = await GroupChatModel.getGroupMembers(groupId);
        members.forEach(member => {
            socketService.notifyUser(member.user_id, 'new_message', {
                ...systemMsg,
                sender_name: 'System',
                is_system: true,
                conversation_id: groupId
            });
        });

        return { success: true };
    }

    static async removeMember(adminId, groupId, targetUserId) {
        // 1. Verify admin
        const group = await GroupChatModel.getGroupDetails(groupId);
        if (!group) throw new Error("Group not found");
        if (group.admin_id !== adminId) throw new Error("Only admin can remove members");
        if (adminId === targetUserId) throw new Error("Admin cannot remove themselves. Use leave instead.");

        // 2. Get target user name
        const userRes = await pool.query(`SELECT full_name FROM users WHERE user_id = $1`, [targetUserId]);
        const userName = userRes.rows[0]?.full_name || "A member";

        // 3. Remove member
        await GroupChatModel.removeMember(groupId, targetUserId);

        // 4. System message: "X was removed by Admin"
        const systemMsg = await GroupChatModel.createMessage({
            groupId,
            senderId: adminId, // Admin is the actor
            content: `${userName} was removed by Admin`,
            type: 'system',
            actionType: 'remove',
            targetId: targetUserId
        });




        // 5. Notify everyone including the removed user (so they see they were removed?)
        // Actually, notify current members.
        const members = await GroupChatModel.getGroupMembers(groupId);

        // Notify the person who was removed specifically if they have socket
        socketService.notifyUser(targetUserId, 'removed_from_group', { groupId });

        members.forEach(member => {
            socketService.notifyUser(member.user_id, 'new_message', {
                ...systemMsg,
                sender_name: 'System',
                is_system: true,
                conversation_id: groupId
            });
        });

        return { success: true };
    }

    static async deleteGroup(userId, groupId) {
        // "Delete Group" for user = Leave (if active) + Delete history (remove row)

        // Check if user is currently a member (active)
        const members = await GroupChatModel.getGroupMembers(groupId);
        const isMember = members.find(m => m.user_id === userId);

        if (isMember) {
            // If active, leave first (soft delete + notify)
            await this.leaveGroup(userId, groupId);
        }

        // Now hard delete the participant row so it disappears from their list
        // (Assuming 'conversations' list query joins on participants)
        await GroupChatModel.deleteMemberRow(groupId, userId);

        return { success: true };
    }

    static async getGroupDetails(groupId) {
        const group = await GroupChatModel.getGroupDetails(groupId);
        if (!group) return null;
        const members = await GroupChatModel.getGroupMembers(groupId);
        return { ...group, members };
    }
    static async sendMessage(senderId, groupId, content, type) {
        // 1. Verify user is member of group
        const members = await GroupChatModel.getGroupMembers(groupId);
        // console.log("Group Members:", members);

        if (!members.find(m => m.user_id === senderId)) {
            console.error("User not member:", senderId);
            throw new Error("User is not a member of this group");
        }

        // 2. Create message
        const message = await GroupChatModel.createMessage({ groupId, senderId, content, type });

        // 3. Emit socket event
        // Enriched message for frontend (needs sender details)
        const sender = members.find(m => m.user_id === senderId);
        const enrichedMessage = {
            ...message,
            sender_name: sender.full_name,
            sender_avatar: sender.avatar_url,
            is_own: false // Will be determined by client
        };

        // Notify all members
        members.forEach(member => {
            socketService.notifyUser(member.user_id, 'new_message', enrichedMessage);
        });

        return message;
    }

    static async getGroupInvitations(groupId) {
        return await GroupChatModel.getGroupInvitations(groupId);
    }
    static async updateGroupAvatar(userId, groupId, avatarUrl) {
        // 1. Verify admin
        const group = await GroupChatModel.getGroupDetails(groupId);
        if (!group) throw new Error("Group not found");
        if (group.admin_id !== userId) {
            throw new Error("Only admin can update group avatar");
        }

        // 2. Update avatar
        const updatedGroup = await GroupChatModel.updateGroupAvatar(groupId, avatarUrl);

        // 3. System message
        const userRes = await pool.query(`SELECT full_name FROM users WHERE user_id = $1`, [userId]);
        const userName = userRes.rows[0]?.full_name || "Admin";

        const systemMsg = await GroupChatModel.createMessage({
            groupId,
            senderId: userId,
            content: `${userName} updated the group icon`,
            type: 'system',
            actionType: 'update_avatar'
        });

        // 4. Notify members
        const members = await GroupChatModel.getGroupMembers(groupId);
        members.forEach(member => {
            // Notify about group update (avatar)
            socketService.notifyUser(member.user_id, 'group_updated', updatedGroup);

            // Notify about system message
            socketService.notifyUser(member.user_id, 'new_message', {
                ...systemMsg,
                sender_name: 'System',
                is_system: true,
                conversation_id: groupId
            });
        });

        return updatedGroup;
    }
}

module.exports = GroupChatService;
