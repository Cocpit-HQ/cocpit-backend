const express = require("express");
const router = express.Router();
const chatSessionCtrl = require("./chatSession.controller");
const groupChatCtrl = require("./groupChat.controller");
const messageCtrl = require("./message.controller");
const { requireAuth } = require("../../core/middlewares/auth.middleware");
const { uploadAvatar } = require("../../core/middlewares/upload.middleware");
const { sessionRateLimiter } = require("../../core/utils/sessionRateLimiter");
const groupAdminMiddleware = require("../../core/middlewares/groupAdmin.middleware");

// ═══════ Organization Chat Sessions ═══════
router.post("/organization-chat-sessions/claim", requireAuth, sessionRateLimiter("session:claim"), chatSessionCtrl.claimSession);
router.post("/organization-chat-sessions/release", requireAuth, chatSessionCtrl.releaseSession);
router.post("/organization-chat-sessions/takeover", requireAuth, sessionRateLimiter("session:takeover"), chatSessionCtrl.takeoverSession);
router.get("/organization-chat-sessions/active", requireAuth, chatSessionCtrl.getActiveSession);
router.get("/organization-chat-sessions/history", requireAuth, chatSessionCtrl.getSessionHistory);
router.get("/organization-chat-sessions/:sessionId/messages", requireAuth, chatSessionCtrl.getSessionMessages);

// Legacy aliases
router.post("/company-chat-sessions/claim", requireAuth, sessionRateLimiter("session:claim"), chatSessionCtrl.claimSession);
router.post("/company-chat-sessions/release", requireAuth, chatSessionCtrl.releaseSession);
router.post("/company-chat-sessions/takeover", requireAuth, sessionRateLimiter("session:takeover"), chatSessionCtrl.takeoverSession);
router.get("/company-chat-sessions/active", requireAuth, chatSessionCtrl.getActiveSession);
router.get("/company-chat-sessions/history", requireAuth, chatSessionCtrl.getSessionHistory);
router.get("/company-chat-sessions/:sessionId/messages", requireAuth, chatSessionCtrl.getSessionMessages);

// ═══════ Group Chat ═══════
router.post("/groups", requireAuth, uploadAvatar.single("avatar"), groupChatCtrl.createGroup);
router.get("/groups/invitations", requireAuth, groupChatCtrl.getPendingInvitations);
router.post("/groups/invitation/respond", requireAuth, groupChatCtrl.respondInvitation);

// Admin-only
router.post("/groups/:groupId/invite", requireAuth, groupAdminMiddleware.requireGroupAdmin, groupChatCtrl.inviteMember);
router.get("/groups/:groupId/invitations", requireAuth, groupAdminMiddleware.requireGroupAdmin, groupChatCtrl.getGroupInvitations);
router.delete("/groups/:groupId/invitations/:invitationId", requireAuth, groupAdminMiddleware.requireGroupAdmin, groupChatCtrl.cancelInvitation);
router.delete("/groups/:groupId/members/:userId", requireAuth, groupAdminMiddleware.requireGroupAdmin, groupChatCtrl.removeMember);
router.post("/groups/:groupId/members/:userId/promote", requireAuth, groupAdminMiddleware.requireGroupAdmin, groupChatCtrl.promoteToAdmin);
router.post("/groups/:groupId/members/:userId/demote", requireAuth, groupAdminMiddleware.requireGroupAdmin, groupChatCtrl.demoteAdmin);
router.put("/groups/:groupId/avatar", requireAuth, groupAdminMiddleware.requireGroupAdmin, groupChatCtrl.updateGroupAvatar);
router.put("/groups/:groupId/details", requireAuth, groupAdminMiddleware.requireGroupAdmin, uploadAvatar.single("avatar"), groupChatCtrl.updateGroupDetails);
router.patch("/groups/:groupId/role", requireAuth, groupAdminMiddleware.requireGroupAdmin, groupChatCtrl.updateMemberRole);

router.get("/groups/:groupId", requireAuth, groupChatCtrl.getGroupDetails);
router.delete("/groups/:groupId", requireAuth, groupChatCtrl.deleteGroup);
router.post("/groups/:groupId/leave", requireAuth, groupChatCtrl.leaveGroup);
router.post("/groups/:groupId/messages", requireAuth, require("../../core/middlewares/upload.middleware").uploadChatMedia.fields([
    { name: "images", maxCount: 10 },
    { name: "videos", maxCount: 5 },
    { name: "documents", maxCount: 5 }
]), groupChatCtrl.sendMessage);

// Read Receipts
router.post("/groups/:groupId/read", requireAuth, groupChatCtrl.markGroupMessagesAsRead);
router.get("/groups/:groupId/messages/:messageId/read", requireAuth, groupChatCtrl.getMessageReadReceipts);

// ═══════ Chat Request Actions ═══════
router.put("/conversations/:conversationId/accept", requireAuth, groupChatCtrl.acceptChatRequest);
router.put("/conversations/:conversationId/decline", requireAuth, groupChatCtrl.declineChatRequest);

// ═══════ Messaging User Search ═══════
router.get("/messaging/search/users", requireAuth, groupChatCtrl.searchUsersForMessaging);

module.exports = router;
