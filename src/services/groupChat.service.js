const GroupChatModel = require("../models/groupChat.model");
const socketService = require("../services/socket.service"); // Assuming existing socket service
const pool = require("../db/pool"); // For specific queries if model isn't enough or for transactions

class GroupChatService {
    static async createGroup(adminId, { name, description, avatarUrl, members }) {
        // 1. Create Group
        const group = await GroupChatModel.createGroup({ adminId, name, description, avatarUrl });

        // 2. Add Admin as Member
        await GroupChatModel.addMember({ groupId: group.conversation_id, userId: adminId, role: 'admin' });

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
        // Group existence check
        const group = await GroupChatModel.getGroupDetails(groupId);
        if (!group) throw new Error("Group not found");

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

        // Notify Admin of invitation update (to remove from pending)
        const group = await GroupChatModel.getGroupDetails(invitation.conversation_id);
        if (group && group.admin_id) {
            socketService.notifyUser(group.admin_id, 'invitation_update', {
                groupId: invitation.conversation_id,
                invitationId,
                status: 'accepted'
            });
        }

        return { success: true, groupId: invitation.conversation_id };
    }

    static async rejectInvitation(userId, invitationId) {
        const invitation = await GroupChatModel.getInvitationById(invitationId);
        if (!invitation) throw new Error("Invitation not found");
        if (invitation.invitee_id !== userId) throw new Error("Unauthorized");

        await GroupChatModel.updateInvitationStatus(invitationId, 'rejected');

        // Notify Admin
        const group = await GroupChatModel.getGroupDetails(invitation.conversation_id);
        if (group && group.admin_id) {
            socketService.notifyUser(group.admin_id, 'invitation_update', {
                groupId: invitation.conversation_id,
                invitationId,
                status: 'rejected'
            });
        }

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




        // Broadcast system message
        const members = await GroupChatModel.getGroupMembers(groupId);
        members.forEach(member => {
            socketService.notifyUser(member.user_id, 'new_message', {
                ...systemMsg,
                sender_name: 'System',
                is_system: true,
                conversation_id: groupId
            });
        });

        // Force socket to leave room
        socketService.leaveConversation(userId, groupId);

        return { success: true };
    }

    static async removeMember(adminId, groupId, targetUserId) {
        // 1. Verify group exists
        const group = await GroupChatModel.getGroupDetails(groupId);
        if (!group) throw new Error("Group not found");

        if (adminId === targetUserId) throw new Error("Admin cannot remove themselves. Use leave instead.");

        // 2. Safety Rule: If target is admin, check if they are the last admin
        const members = await GroupChatModel.getGroupMembers(groupId);
        const targetMember = members.find(m => m.user_id === targetUserId);

        if (targetMember && targetMember.role === 'admin') {
            const adminCount = await GroupChatModel.getAdminCount(groupId);
            if (adminCount <= 1) {
                throw new Error("Cannot remove the last admin from the group");
            }
        }

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
        const remainingMembers = await GroupChatModel.getGroupMembers(groupId);

        // Notify the person who was removed specifically if they have socket
        socketService.notifyUser(targetUserId, 'removed_from_group', { groupId });

        remainingMembers.forEach(member => {
            socketService.notifyUser(member.user_id, 'new_message', {
                ...systemMsg,
                sender_name: 'System',
                is_system: true,
                conversation_id: groupId
            });
        });

        // Force socket to leave room
        socketService.leaveConversation(targetUserId, groupId);

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
    static async sendMessage(senderId, groupId, content, type, media = [], previewText = null) {
        // 1. Verify user is member of group
        const members = await GroupChatModel.getGroupMembers(groupId);
        // console.log("Group Members:", members);

        if (!members.find(m => m.user_id === senderId)) {
            console.error("User not member:", senderId);
            throw new Error("User is not a member of this group");
        }

        // 2. Create message
        const message = await GroupChatModel.createMessage({ groupId, senderId, content, type, previewText });

        // 3. Insert Media
        let mediaRecords = [];
        if (media.length > 0) {
            mediaRecords = await GroupChatModel.addMessageMedia(message.message_id, media);
        }

        // 4. Emit socket event
        // Enriched message for frontend (needs sender details)
        const sender = members.find(m => m.user_id === senderId);
        const enrichedMessage = {
            ...message,
            media: mediaRecords, // Include media in socket event
            sender_name: sender.full_name,
            sender_avatar: sender.avatar_url,
            is_own: false // Will be determined by client
        };

        // Notify all members
        // Notify all members via room broadcast for the message itself
        socketService.notifyConversation(groupId, 'new_message', enrichedMessage);

        // Notify list update (MessagingPage listens to this) via individual notifications
        members.forEach(member => {
            // Suppress notification toast for the sender themselves
            if (member.user_id !== senderId) {
                socketService.notifyUser(member.user_id, 'notification', {
                    type: 'message',
                    from: senderId,
                    senderName: sender.full_name,
                    senderAvatar: sender.avatar_url,
                    conversationId: groupId,
                    isGroup: true,
                    text: previewText || content // Use previewText if available
                });
            }
        });

        return { ...message, media: mediaRecords };
    }

    static async getGroupInvitations(userId, groupId) {
        // 1. Verify admin
        const group = await GroupChatModel.getGroupDetails(groupId);
        if (!group) throw new Error("Group not found");

        // Check if requester is admin (either creator or promoted admin)
        const members = await GroupChatModel.getGroupMembers(groupId);
        const member = members.find(m => m.user_id === userId);

        if (!member || member.role !== 'admin') {
            throw new Error("Only admin can view invitations");
        }

        return await GroupChatModel.getGroupInvitations(groupId);
    }

    static async promoteToAdmin(adminId, groupId, targetUserId) {
        // 1. Verify requester is admin
        const members = await GroupChatModel.getGroupMembers(groupId);
        const adminMember = members.find(m => m.user_id === adminId);

        if (!adminMember || adminMember.role !== 'admin') {
            throw new Error("Only admin can promote members");
        }

        // 2. Verify target is in group
        const targetMember = members.find(m => m.user_id === targetUserId);
        if (!targetMember) {
            throw new Error("User is not in the group");
        }

        if (targetMember.role === 'admin') {
            throw new Error("User is already an admin");
        }

        // 3. Update role
        await GroupChatModel.updateMemberRole(groupId, targetUserId, 'admin');

        // 4. Notify all members
        const updatedMembers = members.map(m =>
            m.user_id === targetUserId ? { ...m, role: 'admin' } : m
        );

        updatedMembers.forEach(member => {
            socketService.notifyUser(member.user_id, 'group_role_update', {
                groupId,
                userId: targetUserId,
                role: 'admin'
            });

            // Send system message
            socketService.notifyUser(member.user_id, 'new_message', {
                conversation_id: groupId,
                sender_id: null,
                sender_name: 'System',
                text_content: `${adminMember.full_name} made ${targetMember.full_name} a group admin`,
                message_type: 'system',
                created_at: new Date().toISOString(),
                is_system: true
            });
        });

        await GroupChatModel.createMessage({
            groupId,
            senderId: adminId,
            content: `${adminMember.full_name} made ${targetMember.full_name} a group admin`,
            type: 'system',
            actionType: 'promote',
            targetId: targetUserId
        });

        return { success: true };
    }

    static async demoteAdmin(adminId, groupId, targetUserId) {
        // 1. Verify requester is admin
        const members = await GroupChatModel.getGroupMembers(groupId);
        const adminMember = members.find(m => m.user_id === adminId);

        if (!adminMember || adminMember.role !== 'admin') {
            throw new Error("Only admin can demote members");
        }

        // 2. Verify target is in group
        const targetMember = members.find(m => m.user_id === targetUserId);
        if (!targetMember) {
            throw new Error("User is not in the group");
        }

        if (targetMember.role !== 'admin') {
            throw new Error("User is not an admin");
        }

        // 3. Safety Rule: Cannot demote the last admin
        const adminCount = await GroupChatModel.getAdminCount(groupId);
        if (adminCount <= 1) {
            throw new Error("Cannot demote the last admin of the group");
        }

        // 4. Update role
        await GroupChatModel.updateMemberRole(groupId, targetUserId, 'member');

        // 5. Notify members
        members.forEach(member => {
            socketService.notifyUser(member.user_id, 'group_role_update', {
                groupId,
                userId: targetUserId,
                role: 'member'
            });

            socketService.notifyUser(member.user_id, 'new_message', {
                conversation_id: groupId,
                sender_id: null,
                sender_name: 'System',
                text_content: `${adminMember.full_name} removed ${targetMember.full_name} as admin`,
                message_type: 'system',
                created_at: new Date().toISOString(),
                is_system: true
            });
        });

        await GroupChatModel.createMessage({
            groupId,
            senderId: adminId,
            content: `${adminMember.full_name} removed ${targetMember.full_name} as admin`,
            type: 'system',
            actionType: 'demote',
            targetId: targetUserId
        });

        return { success: true };
    }
    static async updateGroupAvatar(userId, groupId, avatarUrl) {
        // Group existence check
        const group = await GroupChatModel.getGroupDetails(groupId);
        if (!group) throw new Error("Group not found");

        // 2. Update avatar
        const updatedGroup = await GroupChatModel.updateGroupAvatar(groupId, avatarUrl);

        // 3. System message
        const userRes = await pool.query(`SELECT full_name FROM users WHERE user_id = $1`, [userId]);
        const userName = userRes.rows[0]?.full_name || "Admin";

        const systemMsg = await GroupChatModel.createMessage({
            groupId,
            senderId: userId,
            content: avatarUrl ? `${userName} updated the group icon` : `${userName} removed the group icon`,
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

    static async markGroupMessagesAsRead(userId, groupId) {
        // 1. Verify user is member
        const members = await GroupChatModel.getGroupMembers(groupId);
        if (!members.find(m => m.user_id === userId)) {
            throw new Error("User is not a member of this group");
        }

        // 2. Mark messages as read
        const newlyReadMessages = await GroupChatModel.markMessagesAsRead(userId, groupId);

        // 3. Notify other members if any messages were newly read
        if (newlyReadMessages.length > 0) {
            // We can emit a 'messages_read' event to the group (conversation room)
            // Payload needs to say "User X read these messages"
            // But usually we just say "User X read up to message Y" or "User X read messages [ids]"

            // Let's emit "messages_read" with the user and the list of message IDs
            const messageIds = newlyReadMessages.map(m => m.message_id);

            // Fetch user details for the event
            const member = members.find(m => m.user_id === userId);

            members.forEach(m => {
                // Don't notify self (optional, but good practice to reduce noise, though frontend might use it to confirm)
                // if (m.user_id !== userId) {
                socketService.notifyUser(m.user_id, 'messages_read', {
                    conversation_id: groupId,
                    user_id: userId,
                    user_name: member.full_name,
                    user_avatar: member.avatar_url,
                    message_ids: messageIds,
                    read_at: new Date().toISOString()
                });
                //}
            });
        }

        return { success: true, readCount: newlyReadMessages.length };
    }

    static async getMessageReadReceipts(userId, groupId, messageId) {
        // 1. Verify user is member
        const members = await GroupChatModel.getGroupMembers(groupId);
        if (!members.find(m => m.user_id === userId)) {
            throw new Error("User is not a member of this group");
        }

        // 2. Get read receipts
        return await GroupChatModel.getReadReceipts(messageId);
    }
}

module.exports = GroupChatService;
