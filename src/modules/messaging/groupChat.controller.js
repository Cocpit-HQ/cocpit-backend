const GroupChatService = require("../../services/groupChat.service");
const pool = require("../../core/db/pool");

exports.createGroup = async (req, res) => {
    try {
        const adminId = req.user.sub || req.user.user_id; // Check auth middleware formatting
        const { name, description } = req.body;
        let { avatarUrl, members } = req.body;

        // Extract avatar from file if uploaded (same as onboarding/profile pattern)
        if (req.file) {
            avatarUrl = req.file.path.replace(/\\/g, "/");
        }

        // Parse members if sent as JSON string (common for FormData)
        if (typeof members === 'string') {
            try {
                members = JSON.parse(members);
            } catch (e) {
                console.error("Failed to parse members:", e);
            }
        }

        if (!name) return res.status(400).json({ message: "Group name is required" });

        const group = await GroupChatService.createGroup(adminId, { name, description, avatarUrl, members });
        res.status(201).json(group);
    } catch (err) {
        console.error("Create Group Error:", err);
        res.status(500).json({ message: err.message });
    }
};

exports.inviteMember = async (req, res) => {
    try {
        const senderId = req.user.sub || req.user.user_id;
        const { groupId, receiverId } = req.body;
        console.log("Invite Member Payload:", { senderId, groupId, receiverId, body: req.body });

        if (!groupId || !receiverId) {
            console.error("Missing fields:", { groupId, receiverId, body: req.body });
            return res.status(400).json({ message: "Missing fields", received: req.body, groupId, receiverId });
        }

        const invitation = await GroupChatService.inviteMember(senderId, groupId, receiverId);
        res.status(201).json(invitation);
    } catch (err) {
        console.error("Invite Member Error:", err);
        res.status(400).json({ message: err.message });
    }
};

exports.cancelInvitation = async (req, res) => {
    try {
        const adminId = req.user.sub || req.user.user_id;
        const { groupId, invitationId } = req.params;

        if (!groupId || !invitationId) {
            return res.status(400).json({ message: "groupId and invitationId are required" });
        }

        const result = await GroupChatService.cancelInvitation(adminId, groupId, invitationId);
        res.status(200).json(result);
    } catch (err) {
        console.error("Cancel Invitation Error:", err);
        if (err.message === "Group not found" || err.message === "Invitation not found") {
            return res.status(404).json({ message: err.message });
        }
        if (err.message === "Only an active group admin can cancel invitations" || err.message === "Invitation does not belong to this group") {
            return res.status(403).json({ message: err.message });
        }
        if (err.message.startsWith("Cannot cancel invitation with status:")) {
            return res.status(400).json({ message: err.message });
        }
        res.status(500).json({ message: err.message });
    }
};

exports.getPendingInvitations = async (req, res) => {
    try {
        const userId = req.user.sub || req.user.user_id;

        const invitations = await GroupChatService.getPendingInvitations(userId);

        res.json(invitations);
    } catch (err) {
        console.error("Get Pending Invitations Error:", err);
        res.status(500).json({ message: err.message });
    }
};

exports.respondInvitation = async (req, res) => {
    try {
        const userId = req.user.sub || req.user.user_id;
        const { invitationId, action } = req.body; // action: 'accept' | 'reject'

        if (action === 'accept') {
            const result = await GroupChatService.acceptInvitation(userId, invitationId);
            res.json(result);
        } else if (action === 'reject') {
            const result = await GroupChatService.rejectInvitation(userId, invitationId);
            res.json(result);
        } else {
            res.status(400).json({ message: "Invalid action" });
        }
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
}

exports.leaveGroup = async (req, res) => {
    try {
        const userId = req.user.sub || req.user.user_id;
        const { groupId } = req.params;
        await GroupChatService.leaveGroup(userId, groupId);
        res.json({ message: "Left group successfully" });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
}

exports.deleteGroup = async (req, res) => {
    try {
        const userId = req.user.sub || req.user.user_id;
        const { groupId } = req.params;
        await GroupChatService.deleteGroup(userId, groupId);
        res.json({ message: "Group deleted" });
    } catch (err) {
        res.status(403).json({ message: err.message });
    }
}

exports.sendMessage = async (req, res) => {
    try {
        const senderId = req.user.sub || req.user.user_id;
        const { groupId } = req.params;
        const {
            content,
            replyMessageId,
            shared_post_id,
            shared_profile_id,
            shared_profile_type,
            entity_type,
            entity_id
        } = req.body;

        let files = [];
        if (req.files) {
            if (Array.isArray(req.files)) {
                files = req.files;
            } else {
                files = Object.values(req.files).flat();
            }
        }

        const isDocumentMimetype = (mimetype) => mimetype === 'application/pdf'
            || mimetype === 'application/msword'
            || mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

        // Process files to determine type
        let media = [];
        let messageType = 'text';

        if (files && files.length > 0) {
            media = files.map(file => {
                let type = 'image';
                if (file.mimetype.startsWith('video/')) type = 'video';
                if (isDocumentMimetype(file.mimetype)) type = 'document';
                return { url: file.path, type, name: file.originalname };
            });

            // If only one file, set message type to that file's type (or text if mixed? usually keep as text/image depending on UI)
            // But we have 'message_type' column.
            // If it has content, it's text with attachments.
            // If no content, it's media message.
            if (!content) {
                if (media.length === 1) messageType = media[0].type;
                else messageType = 'image'; // Default to image/media type for multiple
            }
        }

        // Generate preview text if content is empty
        const previewText = content
            ? content
            : (media.length > 0
                ? (media.length > 1 ? `${media.length} attachments` : (media[0].type === 'video' ? 'Sent a video' : (media[0].type === 'document' ? 'Sent a document' : 'Sent a photo')))
                : 'Message');

        await GroupChatService.sendMessage(
            senderId,
            groupId,
            content,
            messageType,
            media,
            previewText,
            replyMessageId,
            shared_post_id,
            shared_profile_id,
            shared_profile_type,
            entity_type,
            entity_id
        );
        res.status(201).json({ success: true });
    } catch (err) {
        console.error("SendMessage Error:", err);
        res.status(500).json({ message: err.message });
    }
}

exports.getGroupDetails = async (req, res) => {
    try {
        const userId = req.user.sub || req.user.user_id;
        const { groupId } = req.params;
        const details = await GroupChatService.getGroupDetails(userId, groupId);
        if (!details) return res.status(404).json({ message: "Group not found" });
        res.json(details);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
}
exports.getGroupInvitations = async (req, res) => {
    try {
        const userId = req.user.sub || req.user.user_id;
        const { groupId } = req.params;
        const invitations = await GroupChatService.getGroupInvitations(userId, groupId);
        res.json(invitations);
    } catch (err) {
        if (err.message === "Only admin can view invitations" || err.message.includes("Only admin")) {
            return res.status(403).json({ message: err.message });
        }
        res.status(500).json({ message: err.message });
    }
};

exports.promoteToAdmin = async (req, res) => {
    try {
        const userId = req.user.sub || req.user.user_id;
        const { groupId, userId: targetUserId } = req.params;

        await GroupChatService.promoteToAdmin(userId, groupId, targetUserId);
        res.json({ success: true, message: "Member promoted to admin" });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

exports.updateMemberRole = async (req, res) => {
    try {
        const adminId = req.user.sub || req.user.user_id;
        const { groupId } = req.params;
        const { targetUserId, newRole } = req.body;

        if (!targetUserId || !newRole) {
            return res.status(400).json({ message: "targetUserId and newRole are required" });
        }

        const result = await GroupChatService.updateMemberRole(adminId, groupId, targetUserId, newRole);
        res.json(result);
    } catch (err) {
        res.status(403).json({ message: err.message });
    }
};

exports.demoteAdmin = async (req, res) => {
    try {
        const userId = req.user.sub || req.user.user_id;
        const { groupId, userId: targetUserId } = req.params;

        await GroupChatService.demoteAdmin(userId, groupId, targetUserId);
        res.json({ success: true, message: "Admin demoted to member" });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

exports.removeMember = async (req, res) => {
    try {
        const adminId = req.user.sub || req.user.user_id;
        const { groupId, userId } = req.params;

        await GroupChatService.removeMember(adminId, groupId, userId);
        res.json({ success: true, message: "Member removed" });
    } catch (err) {
        res.status(403).json({ message: err.message });
    }
}

exports.updateGroupAvatar = async (req, res) => {
    try {
        const userId = req.user.sub || req.user.user_id;
        const { groupId } = req.params;
        const { avatarUrl } = req.body;

        if (avatarUrl === undefined) return res.status(400).json({ message: "Avatar URL is required" });

        const group = await GroupChatService.updateGroupAvatar(userId, groupId, avatarUrl);
        res.json(group);
    } catch (err) {
        console.error("Update Group Avatar Error:", err);
        res.status(403).json({ message: err.message });
    }
}

exports.updateGroupDetails = async (req, res) => {
    try {
        // Part D — Extract and validate
        const userId = req.user.sub || req.user.user_id;
        const { groupId } = req.params;
        const { name, headline, description } = req.body;
        let { avatar } = req.body;

        // Extract avatar from file if uploaded
        if (req.file) {
            avatar = req.file.path.replace(/\\/g, "/");
        }

        if (!groupId) {
            return res.status(400).json({
                success: false,
                message: "Group ID is required"
            });
        }

        if (name === undefined && headline === undefined && description === undefined && avatar === undefined) {
            return res.status(400).json({
                success: false,
                message: "At least one field is required to update"
            });
        }

        if (name !== undefined && !name.trim()) {
            return res.status(400).json({
                success: false,
                message: "Group name cannot be empty"
            });
        }

        // Part E — Build update object dynamically
        const updateFields = {};
        if (name !== undefined) updateFields.name = name.trim();
        if (headline !== undefined) updateFields.headline = headline.trim();
        if (description !== undefined) updateFields.description = description.trim();
        if (avatar !== undefined) updateFields.avatar = avatar;

        // Use same DB update pattern as updateGroupAvatar
        const updatedGroup = await GroupChatService.updateGroupDetails(userId, groupId, updateFields);

        if (!updatedGroup) {
            return res.status(404).json({
                success: false,
                message: "Group not found"
            });
        }

        // Part F — Response (match updateGroupAvatar pattern exactly)
        return res.status(200).json({
            success: true,
            data: updatedGroup,
            message: "Group details updated successfully"
        });

    } catch (err) {
        // Match exact error handling from updateGroupAvatar
        console.error("Update Group Details Error:", err);
        res.status(403).json({
            success: false,
            message: err.message
        });
    }
}

exports.markGroupMessagesAsRead = async (req, res) => {
    try {
        const userId = req.user.sub || req.user.user_id;
        const { groupId } = req.params;

        const result = await GroupChatService.markGroupMessagesAsRead(userId, groupId);
        res.json(result);
    } catch (err) {
        console.error("Mark Messages Read Error:", err);
        if (err.message === "User is not a member of this group") {
            return res.status(403).json({ message: err.message });
        }
        res.status(500).json({ message: err.message });
    }
}

exports.getMessageReadReceipts = async (req, res) => {
    try {
        const userId = req.user.sub || req.user.user_id;
        const { groupId, messageId } = req.params;

        const receipts = await GroupChatService.getMessageReadReceipts(userId, groupId, messageId);
        res.json(receipts);
    } catch (err) {
        console.error("Get Read Receipts Error:", err);
        res.status(500).json({ message: err.message });
    }
}

exports.acceptChatRequest = async (req, res) => {
    try {
        const userId = req.user.sub || req.user.user_id;
        const { conversationId } = req.params;

        if (!conversationId) {
            return res.status(400).json({ message: "conversationId is required" });
        }

        const result = await pool.query(
            `UPDATE conversations
             SET is_requesting = FALSE, updated_at = now()
             WHERE conversation_id = $1
             RETURNING *`,
            [conversationId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ message: "Conversation not found" });
        }

        return res.status(200).json({ success: true, message: "Chat request accepted", data: result.rows[0] });
    } catch (err) {
        console.error("Accept Chat Request Error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.declineChatRequest = async (req, res) => {
    try {
        const userId = req.user.sub || req.user.user_id;
        const { conversationId } = req.params;

        if (!conversationId) {
            return res.status(400).json({ message: "conversationId is required" });
        }

        const result = await pool.query(
            `UPDATE conversations
             SET is_active = FALSE, updated_at = now()
             WHERE conversation_id = $1
             RETURNING *`,
            [conversationId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ message: "Conversation not found" });
        }

        return res.status(200).json({ success: true, message: "Chat request declined", data: result.rows[0] });
    } catch (err) {
        console.error("Decline Chat Request Error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

/**
 * GET /messaging/search/users
 *
 * Searches users for messaging with priority ordering:
 *   1 — Connected users (connections table)
 *   2 — Following users (followers table, not in connections)
 *   3 — All other users
 *
 * Supports optional text filter (q), cursor-based pagination (cursor), and limit.
 *
 * Cursor pattern matches event.controller.js:
 *   - Fetch limit + 1 rows
 *   - If more rows than limit: hasMore = true, pop extra, encode last row's user_id + priority as base64 cursor
 *   - If <= limit rows: hasMore = false, nextCursor = null
 *
 * Response: { success, data, nextCursor, hasMore }
 */
exports.searchUsersForMessaging = async (req, res) => {
    try {
        const userId = req.user.sub || req.user.user_id;
        const { q, cursor, limit: limitParam } = req.query;

        // --- Input sanitization ---
        const searchTerm = (typeof q === "string" && q.trim().length > 0)
            ? q.trim().replace(/^['"]|['"]$/g, "")
            : null;
        const limitNum = Math.min(parseInt(limitParam) || 20, 100); // cap at 100

        // --- Decode cursor ---
        let cursorUserId = null;
        let cursorPriority = null;
        if (cursor) {
            try {
                const decoded = Buffer.from(cursor, "base64").toString("ascii");
                const [cPriority, cUserId] = decoded.split("_");
                if (cPriority && cUserId) {
                    cursorPriority = parseInt(cPriority);
                    cursorUserId = cUserId;
                }
            } catch (_) { /* invalid cursor — ignore, start from beginning */ }
        }

        // --- Build query parameters ---
        // $1 = current userId (always)
        // $2 = likeTerm (only when searchTerm present)
        // remaining = cursor params if present
        const values = [userId];
        let likeTermIdx = null;
        let nameFilter = "";

        if (searchTerm) {
            values.push(`%${searchTerm}%`);
            likeTermIdx = values.length; // $2
            nameFilter = `AND (u.full_name ILIKE $${likeTermIdx} OR u.account_name ILIKE $${likeTermIdx})`;
        }

        // Cursor WHERE clause
        let cursorClause = "";
        if (cursorPriority !== null && cursorUserId) {
            values.push(cursorPriority);
            const cPriorityIdx = values.length;
            values.push(cursorUserId);
            const cUserIdIdx = values.length;
            // Rows come AFTER the cursor: higher priority number or same priority with later created_at
            // Since we sort by (priority ASC, created_at DESC), "after cursor" means:
            //   priority > cursorPriority
            //   OR priority = cursorPriority AND user_id < cursorUserId (using user_id as tiebreak since created_at may not be stable)
            cursorClause = `AND (
                deduped_results.priority > $${cPriorityIdx}
                OR (deduped_results.priority = $${cPriorityIdx} AND deduped_results.user_id > $${cUserIdIdx}::uuid)
            )`;
        }

        // Limit: fetch one extra to detect next page
        values.push(limitNum + 1);
        const limitIdx = values.length;

        const queryText = `
            SELECT * FROM (
                SELECT DISTINCT ON (user_id)
                    user_id, full_name, account_name, headline, avatar_url, created_at,
                    priority
                FROM (
                    SELECT
                        u.user_id,
                        u.full_name,
                        u.account_name,
                        u.headline,
                        u.avatar_url,
                        u.created_at,
                        CASE
                            -- 1. Connections
                            WHEN EXISTS (SELECT 1 FROM connections c WHERE (c.user_id = $1 AND c.connected_user_id = u.user_id) OR (c.connected_user_id = $1 AND c.user_id = u.user_id)) THEN 1
                            -- 2. Followers (They follow me)
                            WHEN EXISTS (SELECT 1 FROM followers f WHERE f.following_id = $1 AND f.follower_id = u.user_id) THEN 2
                            -- 3. Following (I follow them)
                            WHEN EXISTS (SELECT 1 FROM followers f WHERE f.follower_id = $1 AND f.following_id = u.user_id) THEN 3
                            ELSE 4
                        END AS priority
                    FROM users u
                    WHERE u.user_id != $1
                      AND u.full_name IS NOT NULL AND TRIM(u.full_name) <> ''
                      AND u.account_name IS NOT NULL AND TRIM(u.account_name) <> ''
                    ${nameFilter}
                    AND NOT EXISTS (
                        SELECT 1 FROM blocks b
                        WHERE (b.blocker_id = $1 AND b.blocked_id = u.user_id)
                           OR (b.blocker_id = u.user_id AND b.blocked_id = $1)
                    )
                ) AS unsorted_results
                ORDER BY user_id, priority ASC
            ) AS deduped_results
            WHERE 1=1
            ${cursorClause}
            ORDER BY priority ASC, created_at DESC, user_id ASC
            LIMIT $${limitIdx}
        `;

        const result = await pool.query(queryText, values);
        const items = result.rows;

        // --- Cursor pagination (matches event.controller.js pattern exactly) ---
        let nextCursor = null;
        let hasMore = false;

        if (items.length > limitNum) {
            hasMore = true;
            items.pop(); // remove the extra row
            const lastItem = items[items.length - 1];
            // Encode cursor as base64: "priority_userId"
            nextCursor = Buffer.from(`${lastItem.priority}_${lastItem.user_id}`).toString("base64");
        }

        return res.status(200).json({
            success: true,
            data: items,
            nextCursor,
            hasMore,
        });
    } catch (err) {
        console.error("Search Users For Messaging Error:", err);
        return res.status(500).json({ message: "Internal server error" });
    }
};
