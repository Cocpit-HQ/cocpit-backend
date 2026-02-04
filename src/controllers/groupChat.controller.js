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
        const { content, type = 'text' } = req.body;

        // Use pool directly or service. Using pool for consistency with other message inserts if generic service doesn't exist.
        // But better to use a service method.
        // Let's assume we can insert via model.
        // Helper model method needed? Or just query here.
        // "clean file separation". Logic in service.
        await GroupChatService.sendMessage(senderId, groupId, content, type);
        res.status(201).json({ success: true });
    } catch (err) {
        console.error("SendMessage Error:", err);
        res.status(500).json({ message: err.message });
    }
}

exports.getGroupDetails = async (req, res) => {
    try {
        const { groupId } = req.params;
        const details = await GroupChatService.getGroupDetails(groupId);
        if (!details) return res.status(404).json({ message: "Group not found" });
        res.json(details);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
}

exports.getGroupInvitations = async (req, res) => {
    try {
        const { groupId } = req.params;
        const invitations = await GroupChatService.getGroupInvitations(groupId);
        res.json(invitations);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
}

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

        if (!avatarUrl) return res.status(400).json({ message: "Avatar URL is required" });

        const group = await GroupChatService.updateGroupAvatar(userId, groupId, avatarUrl);
        res.json(group);
    } catch (err) {
        console.error("Update Group Avatar Error:", err);
        res.status(403).json({ message: err.message });
    }
}
