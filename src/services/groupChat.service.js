const GroupChatModel = require("../models/groupChat.model");
const socketService = require("../core/infrastructure/socket.service"); // Assuming existing socket service
const pool = require("../core/db/pool"); // For specific queries if model isn't enough or for transactions
const { listConversationMuteStates } = require("./conversationMute.service");
const fs = require("fs");
const path = require("path");

// Helper function for relative time format
const timeAgo = (date) => {
    const seconds = Math.floor((new Date() - new Date(date)) / 1000);
    let interval = seconds / 31536000;
    if (interval > 1) return Math.floor(interval) + "y";
    interval = seconds / 2592000;
    if (interval > 1) return Math.floor(interval) + "mo";
    interval = seconds / 86400;
    if (interval > 1) return Math.floor(interval) + "d";
    interval = seconds / 3600;
    if (interval > 1) return Math.floor(interval) + "h";
    interval = seconds / 60;
    if (interval > 1) return Math.floor(interval) + "m";
    return Math.floor(seconds) + "s";
};

let pendingGroupInvitationsSql = null;

function getPendingGroupInvitationsSql() {
    if (pendingGroupInvitationsSql) return pendingGroupInvitationsSql;

    try {
        const controllerPath = path.join(__dirname, "../modules/social/social.controller.js");
        const controllerContent = fs.readFileSync(controllerPath, "utf8");

        const queryRegex = /const pendingGroupInvitations\s*=\s*await\s+pool\.query\(\s*`([\s\S]+?)`\s*,\s*\[userId\]\s*\);/;
        const match = controllerContent.match(queryRegex);

        if (match) {
            const rawSql = match[1];
            // Narrow query to the specific invitation and conversation
            pendingGroupInvitationsSql = rawSql.replace(
                /WHERE\s+gi\.invitee_id\s*=\s*\$1/,
                "WHERE gi.invitee_id = $1 AND gi.conversation_id = $2"
            );
        } else {
            console.error("[GroupChatService] Failed to extract SQL query: Regex match not found.");
        }
    } catch (err) {
        console.error("[GroupChatService] Error reading social.controller.js for query extraction:", err);
    }

    return pendingGroupInvitationsSql;
}


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

        // RBAC Check: Must be active admin
        const members = await GroupChatModel.getGroupMembers(groupId);
        const inviter = members.find(m => m.user_id == senderId);
        if (!inviter || inviter.role !== 'admin') {
            throw new Error("Only an active group admin can invite members");
        }

        // Check if already a member
        if (members.find(m => m.user_id == receiverId)) {
            throw new Error("User is already a member");
        }

        // Check if invitation exists
        const existing = await GroupChatModel.getInvitation({ groupId, receiverId });
        if (existing && existing.status === 'pending') {
            throw new Error("Invitation already sent");
        }

        // Create invitation
        const invitation = await GroupChatModel.createInvitation({ groupId, senderId, receiverId });

        const requestConversationPayload = {
            ...group,
            is_blocked_by_me: false,
            is_blocked_by_other: false,
            other_user_name: group.conversation_name || 'Group Chat',
            other_user_avatar: group.group_avatar || null,
            other_user_id: groupId,
            other_user_headline: inviter.full_name || null,
            other_user_slug: null,
            other_user_type: 'USER',
            is_active: false,
            is_muted: false,
            muted_until: null,
            is_deleted_user: false,
            last_message_id: null,
            last_message_text: `${inviter.full_name || 'A member'} invited you to join the group`,
            last_message_at: invitation.updated_at || invitation.created_at || new Date().toISOString(),
            replyMessageId: null,
            reply_message: null,
            invitation_id: invitation.invitation_id,
            request_source: 'group_invitation',
            onlineStatus: 'offline',
            is_requesting: true,
            timeAgo: timeAgo(invitation.updated_at || invitation.created_at || new Date().toISOString()),
            unread_count: 0
        };

        // Notify user via socket
        const sql = getPendingGroupInvitationsSql();
        if (sql) {
            try {
                const result = await pool.query(sql, [receiverId, groupId]);
                if (result.rows.length > 0) {
                    const row = result.rows[0];
                    const isRequestingRaw = true;
                    const conversationPayload = {
                        ...row,
                        onlineStatus: 'offline',
                        is_requesting: isRequestingRaw && (row.created_by === receiverId) ? false : isRequestingRaw,
                        timeAgo: timeAgo(row.updated_at),
                        unread_count: 0
                    };
                    socketService.notifyUser(receiverId, 'group_invite', conversationPayload);
                } else {
                    console.warn(`[GroupChatService] No invitation record found in DB for receiverId: ${receiverId}, groupId: ${groupId}`);
                    socketService.notifyUser(receiverId, 'group_invite', requestConversationPayload);
                }
            } catch (err) {
                console.error("[GroupChatService] Failed to fetch group invite conversation payload:", err);
                socketService.notifyUser(receiverId, 'group_invite', requestConversationPayload);
            }
        } else {
            socketService.notifyUser(receiverId, 'group_invite', requestConversationPayload);
        }

        return invitation;
    }

    static async cancelInvitation(adminId, groupId, invitationId) {
        // 1. Group existence check
        const group = await GroupChatModel.getGroupDetails(groupId);
        if (!group) throw new Error("Group not found");

        // 2. RBAC Check: Must be active admin
        const members = await GroupChatModel.getGroupMembers(groupId);
        const updater = members.find(m => m.user_id == adminId);
        if (!updater || updater.role !== 'admin') {
            throw new Error("Only an active group admin can cancel invitations");
        }

        // 3. Fetch invitation
        const invitation = await GroupChatModel.getInvitationById(invitationId);
        if (!invitation) throw new Error("Invitation not found");

        // 4. Verify group match
        if (invitation.conversation_id != groupId) {
            throw new Error("Invitation does not belong to this group");
        }

        // 5. Verify status is pending
        if (invitation.status !== 'pending') {
            throw new Error(`Cannot cancel invitation with status: ${invitation.status}`);
        }

        // 6. Delete invitation (hard delete)
        const deletedInvitation = await GroupChatModel.deleteInvitation(invitationId);

        // 7. Notify invitee via socket to remove/update their list
        socketService.notifyUser(invitation.invitee_id, 'invitation_update', {
            groupId: invitation.conversation_id,
            invitationId,
            status: 'cancelled'
        });

        return { success: true, message: "Invitation cancelled successfully", invitation: deletedInvitation };
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
                conversation_id: invitation.conversation_id, // Ensure conversation_id is present
                isGroup: true
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
        const client = await pool.connect();
        let inTransaction = false;
        try {
            await client.query('BEGIN');
            inTransaction = true;
            console.log(`[GroupChatService] User ${userId} leaving group ${groupId}`);

            // 0. Lock Conversation to prevent race conditions
            await client.query(`SELECT 1 FROM conversations WHERE conversation_id = $1 AND is_active = TRUE FOR UPDATE`, [groupId]);

            // 1. Get user name and role before leaving
            const memberRes = await client.query(
                `SELECT cp.role, u.full_name 
                 FROM conversation_participants cp
                 JOIN users u ON cp.user_id = u.user_id
                 WHERE cp.conversation_id = $1 AND cp.user_id = $2`,
                [groupId, userId]
            );

            if (memberRes.rowCount === 0) {
                console.log(`[GroupChatService] User ${userId} already left or not in group ${groupId}`);
                await client.query('ROLLBACK');
                return { success: true };
            }

            const { role, full_name: userName } = memberRes.rows[0];
            console.log(`[GroupChatService] User ${userId} is currently ${role}`);

            // 2. Create system message FIRST: "User left" 
            const leaveMsgRes = await client.query(
                `INSERT INTO messages (conversation_id, sender_id, text_content, message_type, action_type, target_id) 
                 VALUES ($1, $2, $3, 'system', 'leave', $2) 
                 RETURNING *`,
                [groupId, userId, `${userName} left the group`]
            );

            await client.query(
                `UPDATE conversations SET updated_at = now(), last_message = $2, last_message_at = now() WHERE conversation_id = $1`,
                [groupId, `${userName} left the group`]
            );

            await client.query('COMMIT');
            inTransaction = false;

            // 3. Broadcast system message to all current members including the leaving user
            const leaveMsg = leaveMsgRes.rows[0];
            const enrichedLeaveMsg = {
                ...leaveMsg,
                sender_name: 'System',
                is_system: true,
                conversation_id: groupId,
                isGroup: true
            };
            socketService.notifyConversation(groupId, 'new_message', enrichedLeaveMsg);
            socketService.notifyUser(userId, 'new_message', enrichedLeaveMsg);

            // 4. Begin second transaction for removal and promotion logic
            await client.query('BEGIN');
            inTransaction = true;

            // Lock Conversation to prevent race conditions during deletion/promotion
            await client.query(`SELECT 1 FROM conversations WHERE conversation_id = $1 AND is_active = TRUE FOR UPDATE`, [groupId]);

            // Dynamic Admin Promotion (Perform BEFORE updating the row)
            // Fetch current group owner info
            const groupRes = await client.query(
                `SELECT admin_id FROM conversations WHERE conversation_id = $1 AND is_active = TRUE`,
                [groupId]
            );
            const currentOwnerId = groupRes.rows[0]?.admin_id;
            const isOwner = currentOwnerId === userId;
            const promotedMembers = [];

            if (role === 'admin') {
                // Count OTHER ACTIVE admins
                const adminCountRes = await client.query(
                    `SELECT COUNT(*)::int as count
                     FROM conversation_participants
                     WHERE conversation_id = $1 
                     AND role = 'admin' 
                     AND user_id != $2
                     AND left_at IS NULL`, // CRITICAL: Only count active admins
                    [groupId, userId]
                );

                console.log(`[GroupChatService] Other active admins count: ${adminCountRes.rows[0].count}`);

                // If 0 other admins, we MUST promote someone
                if (adminCountRes.rows[0].count === 0) {
                    console.log(`[GroupChatService] No other admins. Looking for oldest active member...`);

                    const candidatesRes = await client.query(
                        `SELECT cp.user_id, u.full_name 
                         FROM conversation_participants cp
                         JOIN users u ON cp.user_id = u.user_id
                         WHERE cp.conversation_id = $1 
                         AND cp.user_id != $2
                         AND cp.left_at IS NULL
                         ORDER BY cp.joined_at ASC
                         LIMIT 1`,
                        [groupId, userId]
                    );

                    if (candidatesRes.rowCount > 0) {
                        const candidate = candidatesRes.rows[0];
                        console.log(`[GroupChatService] Promoting candidate: ${candidate.user_id} (${candidate.full_name})`);

                        // Promote to admin
                        await client.query(
                            `UPDATE conversation_participants 
                             SET role = 'admin' 
                             WHERE conversation_id = $1 AND user_id = $2`,
                            [groupId, candidate.user_id]
                        );

                        // Update group owner
                        await client.query(
                            `UPDATE conversations SET admin_id = $1 WHERE conversation_id = $2`,
                            [candidate.user_id, groupId]
                        );

                        // System message for promotion
                        const promoMsgRes = await client.query(
                            `INSERT INTO messages (conversation_id, sender_id, text_content, message_type, action_type, target_id) 
                             VALUES ($1, NULL, $2, 'system', 'promote', $3) 
                             RETURNING *`,
                            [groupId, `${candidate.full_name} was promoted to admin`, candidate.user_id]
                        );

                        promotedMembers.push({
                            user_id: candidate.user_id,
                            full_name: candidate.full_name,
                            message: promoMsgRes.rows[0]
                        });
                    } else {
                        console.log(`[GroupChatService] No candidates found. Group will have no admin.`);
                        // Group empty or only inactive members?
                        await client.query(
                            `UPDATE conversations SET admin_id = NULL WHERE conversation_id = $1`,
                            [groupId]
                        );
                    }
                } else if (isOwner) {
                    // Reassign ownership to another existing admin
                    console.log(`[GroupChatService] User was owner but other admins exist. Reassigning ownership.`);
                    const otherAdminRes = await client.query(
                        `SELECT user_id FROM conversation_participants 
                         WHERE conversation_id = $1 
                         AND role = 'admin' 
                         AND user_id != $2
                         AND left_at IS NULL
                         ORDER BY joined_at ASC
                         LIMIT 1`,
                        [groupId, userId]
                    );
                    if (otherAdminRes.rowCount > 0) {
                        await client.query(
                            `UPDATE conversations SET admin_id = $1 WHERE conversation_id = $2`,
                            [otherAdminRes.rows[0].user_id, groupId]
                        );
                    }
                }
            }

            // SOFT DELETE Member (Update left_at)
            await client.query(
                `UPDATE conversation_participants 
                 SET left_at = NOW(), role = 'member',
                     left_group_name = (SELECT conversation_name FROM conversations WHERE conversation_id = $1),
                     left_group_avatar = (SELECT group_avatar FROM conversations WHERE conversation_id = $1),
                     left_group_description = (SELECT description FROM conversations WHERE conversation_id = $1),
                     left_group_headline = (SELECT group_headline FROM conversations WHERE conversation_id = $1)
                 WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`,
                [groupId, userId]
            );
            console.log(`[GroupChatService] User ${userId} marked as left (soft delete)`);

            await client.query('COMMIT');
            inTransaction = false;

            // 5. Send leave confirmation to leaving user (so they can close their panel)
            socketService.notifyUser(userId, 'memberLeft', { groupId, userId });

            // 6. Notify remaining members about membership change
            socketService.notifyConversation(groupId, 'memberLeft', { groupId, userId });

            // Handle promotions notifications
            promotedMembers.forEach(promo => {
                socketService.notifyConversation(groupId, 'group_role_update', {
                    groupId,
                    userId: promo.user_id,
                    role: 'admin',
                    updatedBy: 'System'
                });

                socketService.notifyConversation(groupId, 'new_message', {
                    ...promo.message,
                    sender_name: 'System',
                    is_system: true,
                    conversation_id: groupId,
                    isGroup: true
                });
            });

            // Force socket leave
            socketService.leaveConversation(userId, groupId);

            return { success: true };
        } catch (err) {
            console.error(`[GroupChatService] Leave group error:`, err);
            if (inTransaction) {
                try {
                    await client.query('ROLLBACK');
                } catch (rollbackErr) {
                    console.error("Failed to rollback transaction:", rollbackErr);
                }
            }
            throw err;
        } finally {
            client.release();
        }
    }

    static async removeMember(adminId, groupId, targetUserId) {
        // 1. Verify group exists
        const group = await GroupChatModel.getGroupDetails(groupId);
        if (!group) throw new Error("Group not found");

        if (adminId === targetUserId) throw new Error("Admin cannot remove themselves. Use leave instead.");

        // RBAC Check: Must be active admin
        const members = await GroupChatModel.getGroupMembers(groupId);
        const adminMember = members.find(m => m.user_id == adminId);
        if (!adminMember || adminMember.role !== 'admin') {
            throw new Error("Only an active group admin can remove members");
        }

        // 2. Safety Rule: If target is admin, check if they are the last admin
        const targetMember = members.find(m => m.user_id == targetUserId);

        if (targetMember && targetMember.role === 'admin') {
            const adminCount = await GroupChatModel.getAdminCount(groupId);
            if (adminCount <= 1) {
                throw new Error("Cannot remove the last admin from the group");
            }
        }

        // 2. Get target user name
        const userRes = await pool.query(`SELECT full_name FROM users WHERE user_id = $1`, [targetUserId]);
        const userName = userRes.rows[0]?.full_name || "A member";

        // 3. System message: "X was removed by Admin"
        const systemMsg = await GroupChatModel.createMessage({
            groupId,
            senderId: adminId, // Admin is the actor
            content: `${userName} was removed by Admin`,
            type: 'system',
            actionType: 'remove',
            targetId: targetUserId
        });

        // 4. Notify everyone including the removed user (since they are still in the members list)
        members.forEach(member => {
            socketService.notifyUser(member.user_id, 'new_message', {
                ...systemMsg,
                sender_name: 'System',
                is_system: true,
                conversation_id: groupId,
                isGroup: true
            });
        });

        // 5. Remove member (Soft Delete)
        await GroupChatModel.removeMember(groupId, targetUserId);

        // 6. Notify the person who was removed specifically if they have socket
        socketService.notifyUser(targetUserId, 'removed_from_group', { groupId });

        // 7. Force socket to leave room
        socketService.leaveConversation(targetUserId, groupId);

        return { success: true };
    }

    static async deleteGroup(userId, groupId) {
        // "Delete Group" for user = Leave (if active) + Delete history (remove row)

        // Check if user is currently a member (active)
        const members = await GroupChatModel.getGroupMembers(groupId);
        const isMember = members.find(m => m.user_id == userId);

        if (isMember) {
            // If active, leave first (soft delete + notify)
            await this.leaveGroup(userId, groupId);
        }

        // Now hard delete the participant row so it disappears from their list
        // (Assuming 'conversations' list query joins on participants)
        await GroupChatModel.deleteMemberRow(groupId, userId);

        return { success: true };
    }

    static async getGroupDetails(userId, groupId) {
        const group = await GroupChatModel.getGroupDetails(groupId);
        if (!group) return null;

        // Try to identify the requesting user's status for UI hints (optional)
        const participant = await GroupChatModel.getParticipant(groupId, userId);
        
        // Always fetch active members for the mention system to work correctly
        const members = await GroupChatModel.getGroupMembers(groupId) || [];
        
        if (participant && participant.left_at !== null) {
            return {
                ...group,
                conversation_name: participant.left_group_name || group.conversation_name,
                group_avatar: participant.left_group_avatar || group.group_avatar,
                description: participant.left_group_description || group.description,
                group_headline: participant.left_group_headline || group.group_headline,
                members,
                is_inactive: true,
                left_at: participant.left_at
            };
        }

        return { 
            ...group, 
            members, 
            is_inactive: false,
            left_at: null
        };
    }
    static async sendMessage(senderId, groupId, content, type, media = [], previewText = null, replyMessageId = null) {
        // 1. Verify user is member of group
        const members = await GroupChatModel.getGroupMembers(groupId);
        // console.log("Group Members:", members);

        if (!members.find(m => m.user_id == senderId)) {
            console.error("User not member:", senderId);
            throw new Error("User is not a member of this group");
        }

        // Extract mentions (@Username)
        let mentionedUsernames = [];
        if (content) {
            const mentionMatches = content.match(/@([a-zA-Z0-9_]+)/g);
            mentionedUsernames = mentionMatches ? mentionMatches.map(m => m.substring(1)) : [];
        }

        // 2. Create message
        const message = await GroupChatModel.createMessage({ groupId, senderId, content, type, previewText, replyMessageId });

        // 3. Insert Media
        let mediaRecords = [];
        if (media.length > 0) {
            mediaRecords = await GroupChatModel.addMessageMedia(message.message_id, media);
        }

        let replyMessageData = null;
        if (replyMessageId) {
            const rmRes = await pool.query(`
                SELECT 
                    rm.message_id, 
                    rm.text_content, 
                    rm.message_type,
                    COALESCE(rc.name, ru.full_name, 'Deleted User') as sender_name
                FROM messages rm
                LEFT JOIN users ru ON rm.sender_id = ru.user_id
                LEFT JOIN organizations rc ON rm.author_org_id = rc.org_id
                WHERE rm.message_id = $1
            `, [replyMessageId]);
            if (rmRes.rowCount > 0) replyMessageData = rmRes.rows[0];
        }

        // 4. Emit socket event
        // Enriched message for frontend (needs sender details)
        const sender = members.find(m => m.user_id == senderId);
        const activeAcceptedMembers = members.filter(m => m.status === 'accepted' && m.user_id != senderId);
        const active_member_count = activeAcceptedMembers.length;

        const enrichedMessage = {
            ...message,
            replyMessageId: replyMessageId || null,
            reply_message: replyMessageData,
            media: mediaRecords, // Include media in socket event
            sender_name: sender.full_name,
            sender_avatar: sender.avatar_url,
            is_own: false, // Will be determined by client
            active_member_count,
            delivered_count: active_member_count,
            seen_count: 0
        };

        // Notify all members via room broadcast for the message itself
        socketService.notifyConversation(groupId, 'new_message', enrichedMessage);

        const muteStates = await listConversationMuteStates(pool, groupId);
        const mutedMemberIds = new Set(
            muteStates.filter((state) => state.userId && state.isMuted).map((state) => state.userId)
        );
        
        // Handle Mentions
        const mentionedGroupMembers = [];
        if (mentionedUsernames.length > 0) {
            // Filter group members by account_name (case insensitive)
            for (const member of members) {
                if (
                    member.user_id !== senderId && 
                    member.account_name && 
                    mentionedUsernames.some(u => u.toLowerCase() === member.account_name.toLowerCase())
                ) {
                    mentionedGroupMembers.push(member);
                }
            }

            for (const mentionedMember of mentionedGroupMembers) {
                if (mutedMemberIds.has(mentionedMember.user_id)) {
                    continue;
                }

                // Here we avoid checking block status for group chats, but we can if we want to. For now skip.
                const notifText = `${sender.full_name} mentioned you in a group chat`;
                const meta = {
                    message_id: message.message_id,
                    conversation_id: groupId,
                    isGroup: true
                };

                await pool.query(
                    `INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata) 
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                    [mentionedMember.user_id, senderId, 'mention', notifText, groupId, JSON.stringify(meta)]
                );
            }
        }

        // Notify list update (MessagingPage listens to this) via individual notifications
        members.forEach(member => {
            // Suppress notification toast for the sender themselves
            if (member.user_id !== senderId) {
                if (mutedMemberIds.has(member.user_id)) {
                    return;
                }

                // If the user was mentioned, override default message notification with a mention one
                const isMentioned = mentionedGroupMembers.some(m => m.user_id === member.user_id);
                
                socketService.notifyUser(member.user_id, 'notification', {
                    type: isMentioned ? 'mention' : 'message',
                    from: senderId,
                    senderName: sender.full_name,
                    senderAvatar: sender.avatar_url,
                    conversationId: groupId,
                    isGroup: true,
                    text: isMentioned ? `${sender.full_name} mentioned you in a group chat` : (previewText || content) // Use previewText if available
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
        const member = members.find(m => m.user_id == userId);

        if (!member || member.role !== 'admin') {
            throw new Error("Only admin can view invitations");
        }

        return await GroupChatModel.getGroupInvitations(groupId);
    }

    static async promoteToAdmin(adminId, groupId, targetUserId) {
        return this.updateMemberRole(adminId, groupId, targetUserId, 'admin');
    }

    static async demoteAdmin(adminId, groupId, targetUserId) {
        // ... existing legacy demoteAdmin code ...
        // Forward to new generic method or keep as alias? 
        // For now, let's keep the new method separate and robust.
        return this.updateMemberRole(adminId, groupId, targetUserId, 'member');
    }

    static async updateMemberRole(adminId, groupId, targetUserId, newRole) {
        // 1. Verify group exists
        const group = await GroupChatModel.getGroupDetails(groupId);
        if (!group) throw new Error("Group not found");

        if (adminId === targetUserId) {
            throw new Error("Admins cannot change their own role");
        }

        // 2. RBAC Check: Must be active admin
        const members = await GroupChatModel.getGroupMembers(groupId);
        const adminMember = members.find(m => m.user_id == adminId);
        if (!adminMember || adminMember.role !== 'admin') {
            throw new Error("Only an active group admin can manage roles");
        }

        // 3. Verify target is in group
        const targetMember = members.find(m => m.user_id == targetUserId);
        if (!targetMember) {
            throw new Error("User is not in the group");
        }

        // 4. Validate Role Transition
        if (targetMember.role === newRole) {
            throw new Error(`User is already a ${newRole}`);
        }

        if (newRole !== 'admin' && newRole !== 'member') {
            throw new Error("Invalid role specified");
        }

        // 5. Safety Rule: Cannot demote the last admin
        if (targetMember.role === 'admin' && newRole === 'member') {
            const adminCount = await GroupChatModel.getAdminCount(groupId);
            if (adminCount <= 1) {
                throw new Error("Cannot demote the last admin of the group");
            }
        }

        // 6. Update role
        await GroupChatModel.updateMemberRole(groupId, targetUserId, newRole);

        // 7. Notify members via Socket
        // We broadcast to the specific group room
        // Payload: groupId, targetUserId, newRole, updatedBy
        const payload = {
            groupId,
            userId: targetUserId,
            targetUserId: targetUserId, // redundant but clear
            newRole,
            updatedBy: adminId
        };

        // Use io.to(groupId).emit logic via helper. 
        // socketService.notifyConversation broadcasts to the room.
        // We use 'groupRoleUpdated' event name.
        socketService.notifyConversation(groupId, 'group_role_update', payload);

        // 8. Create and broadcast System Message
        let systemMsgContent = "";
        if (newRole === 'admin') {
            systemMsgContent = `${targetMember.full_name} is now a group admin`;
        } else {
            systemMsgContent = `${targetMember.full_name} is no longer a group admin`;
        }

        const systemMsg = await GroupChatModel.createMessage({
            groupId,
            senderId: null, // System message
            content: systemMsgContent,
            type: 'system',
            actionType: 'role_update',
            targetId: targetUserId
        });

        // Broadcast system message
        const enrichedMsg = {
            ...systemMsg,
            sender_name: 'System',
            is_system: true,
            conversation_id: groupId,
            isGroup: true
        };
        socketService.notifyConversation(groupId, 'new_message', enrichedMsg);

        return { success: true, message: "Role updated successfully" };
    }
    static async updateGroupAvatar(userId, groupId, avatarUrl) {
        // Group existence check
        const group = await GroupChatModel.getGroupDetails(groupId);
        if (!group) throw new Error("Group not found");

        // RBAC Check: Must be active admin
        const members = await GroupChatModel.getGroupMembers(groupId);
        const updater = members.find(m => m.user_id == userId);
        if (!updater || updater.role !== 'admin') {
            throw new Error("Only an active group admin can update the group icon");
        }

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
        members.forEach(member => {
            // Notify about group update (avatar)
            socketService.notifyUser(member.user_id, 'group_updated', updatedGroup);

            // Notify about system message
            socketService.notifyUser(member.user_id, 'new_message', {
                ...systemMsg,
                sender_name: 'System',
                is_system: true,
                conversation_id: groupId,
                isGroup: true
            });
        });

        return updatedGroup;
    }

    static async updateGroupDetails(userId, groupId, updateData) {
        // 1. Group existence check
        const group = await GroupChatModel.getGroupDetails(groupId);
        if (!group) throw new Error("Group not found");

        // 2. RBAC Check: Must be active admin
        const members = await GroupChatModel.getGroupMembers(groupId);
        const updater = members.find(m => m.user_id == userId);
        if (!updater || updater.role !== 'admin') {
            throw new Error("Only an active group admin can update group details");
        }

        // 3. Update details
        const updatedGroup = await GroupChatModel.updateGroupDetails(groupId, updateData);

        // 4. System message
        const userRes = await pool.query(`SELECT full_name FROM users WHERE user_id = $1`, [userId]);
        const userName = userRes.rows[0]?.full_name || "Admin";

        const systemMsg = await GroupChatModel.createMessage({
            groupId,
            senderId: userId,
            content: `${userName} updated group details`,
            type: 'system',
            actionType: 'update_group_details'
        });

        // 5. Notify members
        members.forEach(member => {
            // Notify about group update
            socketService.notifyUser(member.user_id, 'group_updated', updatedGroup);

            // Notify about system message
            socketService.notifyUser(member.user_id, 'new_message', {
                ...systemMsg,
                sender_name: 'System',
                is_system: true,
                conversation_id: groupId,
                isGroup: true
            });
        });

        return updatedGroup;
    }

    static async markGroupMessagesAsRead(userId, groupId) {
        // 1. Verify user is member
        const members = await GroupChatModel.getGroupMembers(groupId);
        if (!members.find(m => m.user_id == userId)) {
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
            const member = members.find(m => m.user_id == userId);

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
        if (!members.find(m => m.user_id == userId)) {
            throw new Error("User is not a member of this group");
        }

        // 2. Get read receipts
        return await GroupChatModel.getReadReceipts(messageId);
    }
}

module.exports = GroupChatService;
