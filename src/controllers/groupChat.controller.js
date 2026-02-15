const GroupChatService = require("../services/groupChat.service");

exports.createGroup = async (req, res) => {
    try {
        const adminId = req.user.sub || req.user.user_id; // Check auth middleware formatting
        const { name, description, avatarUrl, members } = req.body;

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
        const { content } = req.body;

        let files = [];
        if (req.files) {
            if (Array.isArray(req.files)) {
                files = req.files;
            } else {
                files = Object.values(req.files).flat();
            }
        }

        // Process files to determine type
        let media = [];
        let messageType = 'text';

        if (files && files.length > 0) {
            media = files.map(file => {
                let type = 'image';
                if (file.mimetype.startsWith('video/')) type = 'video';
                if (file.mimetype === 'application/pdf') type = 'document';
                return { url: file.path, type };
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

        await GroupChatService.sendMessage(senderId, groupId, content, messageType, media, previewText);
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
