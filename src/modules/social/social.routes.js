const express = require("express");
const router = express.Router();
const socialController = require("./social.controller");
const messageController = require("../messaging/message.controller");
const { requireAuth } = require("../../core/middlewares/auth.middleware");
const { requireCompanyPermission } = require("../../core/middlewares/company.auth.middleware");

// Follow (One-way)
router.post("/users/:id/follow", requireAuth, socialController.followUser);
router.delete("/users/:id/unfollow", requireAuth, socialController.unfollowUser);
router.get("/users/:id/followers/count", socialController.getFollowersCount);
router.get("/users/:id/followers", socialController.getFollowers);
router.get("/users/:id/following", socialController.getFollowing);

// Company Follow
router.post("/companies/:companyId/follow", requireAuth, socialController.followCompany);
router.delete("/companies/:companyId/unfollow", requireAuth, socialController.unfollowCompany);
router.get("/companies/:companyId/relationship", requireAuth, socialController.getCompanyRelationship);
router.get("/companies/:companyId/followers", socialController.getCompanyFollowers);
router.delete("/companies/:companyId/followers/:followerId", requireAuth, requireCompanyPermission("MANAGE_MEMBERS"), socialController.removeCompanyFollower);

// Company Connections
router.post("/companies/:companyId/connect/:userId", requireAuth, requireCompanyPermission("MANAGE_CONNECTIONS"), socialController.sendCompanyConnectionRequest);
router.patch("/companies/:companyId/connect/handle", requireAuth, socialController.handleCompanyConnectionRequest);
router.delete("/companies/:companyId/connect/:userId/cancel", requireAuth, requireCompanyPermission("MANAGE_CONNECTIONS"), socialController.cancelCompanyConnectionRequest);
router.delete("/companies/:companyId/connections/:userId", requireAuth, socialController.removeCompanyConnection);
router.get("/companies/:companyId/connection-status/:userId", requireAuth, socialController.getCompanyConnectionStatus);

// Connections (Two-way)
router.post("/users/:id/connect", requireAuth, socialController.sendConnectionRequest);
router.get("/users/:id/relationship", requireAuth, socialController.getRelationshipStatus);
router.get("/connections/requests", requireAuth, socialController.getPendingRequests);
router.patch("/connections/:requestId", requireAuth, socialController.handleConnectionRequest);
router.get("/connections/history", requireAuth, socialController.getConnectionRequestHistory);
router.get("/my/connections", requireAuth, socialController.getMyConnections);
router.delete("/connections/:requestId", requireAuth, socialController.cancelConnectionRequest);
router.delete("/connections/user/:id", requireAuth, socialController.removeConnection);
router.get("/users/:id/connections/count", socialController.getConnectionCount);
router.get("/users/:id/stats", socialController.getProfileStats);

// Blocking
router.post("/users/:id/block", requireAuth, socialController.blockUser);
router.delete("/users/:id/unblock", requireAuth, socialController.unblockUser);
router.get("/users/me/blocks", requireAuth, socialController.getBlockedUsers);

// Conversations
router.get("/conversations", requireAuth, socialController.getConversations);
router.delete("/conversations/:id", requireAuth, socialController.deleteConversation);

// Messages
router.post("/messages", requireAuth, require("../../core/middlewares/upload.middleware").uploadChatMedia.array("images", 10), socialController.sendMessage);
router.post("/social/share", requireAuth, socialController.sharePostToConversations);
router.get("/conversations/:id/messages", requireAuth, socialController.getMessages);
router.delete("/messages/:messageId", requireAuth, messageController.deleteMessage);

router.delete("/messages/:id", requireAuth, socialController.deleteMessage);
router.patch("/messages/:messageId/edit", requireAuth, socialController.editMessage);

router.patch("/conversations/:conversationId/read", requireAuth, socialController.markConversationRead);
router.get("/messages/:messageId/seen-by", requireAuth, socialController.getMessageSeenBy);

// Notifications
router.get("/notifications", requireAuth, socialController.getNotifications);
router.patch("/notifications/:id/read", requireAuth, socialController.markNotificationRead);
router.patch("/notifications/read-all", requireAuth, socialController.markAllNotificationsRead);

module.exports = router;
