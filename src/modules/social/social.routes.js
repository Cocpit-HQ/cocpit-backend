const express = require("express");
const router = express.Router();
const socialController = require("./social.controller");
const messageController = require("../messaging/message.controller");
const { requireAuth } = require("../../core/middlewares/auth.middleware");
const { requireOrgPermission, requireCompanyPermission } = require("../../core/middlewares/organization.auth.middleware");

// Follow (One-way)
router.post("/users/:id/follow", requireAuth, socialController.followUser);
router.delete("/users/:id/unfollow", requireAuth, socialController.unfollowUser);
router.get("/users/:id/followers/count", socialController.getFollowersCount);
router.get("/users/:id/followers", socialController.getFollowers);
router.get("/users/:id/following", socialController.getFollowing);
router.delete("/users/followers/:followerId", requireAuth, socialController.removeFollower);

// Company/Organization Follow
router.post("/organizations/:orgId/follow", requireAuth, socialController.followCompany);
router.delete("/organizations/:orgId/unfollow", requireAuth, socialController.unfollowCompany);
router.get("/organizations/:orgId/relationship", requireAuth, socialController.getCompanyRelationship);
router.get("/organizations/:orgId/followers", socialController.getCompanyFollowers);
router.delete("/organizations/:orgId/followers/:followerId", requireAuth, requireOrgPermission("MANAGE_MEMBERS"), socialController.removeCompanyFollower);

// Organization Following Entities
router.post("/organizations/:orgId/following/users/:userId", requireAuth, requireOrgPermission("MANAGE_COMPANY"), socialController.organizationFollowUser);
router.delete("/organizations/:orgId/following/users/:userId", requireAuth, requireOrgPermission("MANAGE_COMPANY"), socialController.organizationUnfollowUser);
router.post("/organizations/:orgId/following/organizations/:targetOrgId", requireAuth, requireOrgPermission("MANAGE_COMPANY"), socialController.organizationFollowOrganization);
router.delete("/organizations/:orgId/following/organizations/:targetOrgId", requireAuth, requireOrgPermission("MANAGE_COMPANY"), socialController.organizationUnfollowOrganization);
router.get("/organizations/:orgId/following", socialController.getOrganizationFollowing);



// Company/Organization Connections
router.post("/companies/:companyId/connect/:userId", requireAuth, requireCompanyPermission("MANAGE_CONNECTIONS"), socialController.sendCompanyConnectionRequest);
router.patch("/companies/:companyId/connect/handle", requireAuth, socialController.handleCompanyConnectionRequest);
router.delete("/companies/:companyId/connect/:userId/cancel", requireAuth, requireCompanyPermission("MANAGE_CONNECTIONS"), socialController.cancelCompanyConnectionRequest);
router.delete("/companies/:companyId/connections/:userId", requireAuth, socialController.removeCompanyConnection);
router.get("/companies/:companyId/connection-status/:userId", requireAuth, socialController.getCompanyConnectionStatus);

// Organization Connection Aliases
router.post("/organizations/:orgId/connect/:userId", requireAuth, requireOrgPermission("MANAGE_CONNECTIONS"), socialController.sendCompanyConnectionRequest);
router.patch("/organizations/:orgId/connect/handle", requireAuth, socialController.handleCompanyConnectionRequest);
router.delete("/organizations/:orgId/connect/:userId/cancel", requireAuth, requireOrgPermission("MANAGE_CONNECTIONS"), socialController.cancelCompanyConnectionRequest);
router.delete("/organizations/:orgId/connections/:userId", requireAuth, socialController.removeCompanyConnection);
router.get("/organizations/:orgId/connection-status/:userId", requireAuth, socialController.getCompanyConnectionStatus);

// Connections (Two-way)
router.post("/users/:id/connect", requireAuth, socialController.sendConnectionRequest);
router.get("/users/:id/relationship", requireAuth, socialController.getRelationshipStatus);
// NOTE: counts and suggestions MUST be declared before /requests to avoid route shadowing
router.get("/connections/counts", requireAuth, socialController.getConnectionCounts);
router.get("/connections/suggestions", requireAuth, socialController.getConnectionSuggestions);
router.get("/connections/requests", requireAuth, socialController.getPendingRequests);
router.patch("/connections/:requestId", requireAuth, socialController.handleConnectionRequest);
router.get("/connections/history", requireAuth, socialController.getConnectionRequestHistory);

router.get("/my/connections", requireAuth, socialController.getMyConnections);
router.get("/users/:id/connections", socialController.getConnections);
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
router.get("/conversations/:conversationId/mute", requireAuth, socialController.getConversationMuteState);
router.patch("/conversations/:conversationId/mute", requireAuth, socialController.updateConversationMuteState);
router.patch("/conversations/:conversationId/unmute", requireAuth, socialController.unmuteConversation);
router.patch("/conversations/:conversationId/category", requireAuth, socialController.toggleJobChatCategory);
router.patch("/conversations/:conversationId/job-status", requireAuth, socialController.toggleJobChatCategory);

// Messages
router.post("/messages", requireAuth, require("../../core/middlewares/upload.middleware").uploadChatMedia.array("images", 10), socialController.sendMessage);
router.get("/conversations/:id/messages", requireAuth, socialController.getMessages);
router.delete("/messages/:messageId", requireAuth, messageController.deleteMessage);

router.delete("/messages/:id", requireAuth, socialController.deleteMessage);
router.patch("/messages/:messageId/edit", requireAuth, socialController.editMessage);

// Reactions
router.post("/messages/:messageId/reactions", requireAuth, socialController.upsertReaction);


router.patch("/conversations/:conversationId/read", requireAuth, socialController.markConversationRead);
router.get("/messages/:messageId/seen-by", requireAuth, socialController.getMessageSeenBy);

// Notifications
router.get("/notifications", requireAuth, socialController.getNotifications);
router.patch("/notifications/:id/read", requireAuth, socialController.markNotificationRead);
router.patch("/notifications/read-all", requireAuth, socialController.markAllNotificationsRead);
router.delete("/notifications/bulk", requireAuth, socialController.deleteNotificationsBulk);
router.delete("/notifications/:id", requireAuth, socialController.deleteNotification);

// Check if job/offer context has already been sent in conversation
router.get("/conversations/:conversationId/check-context", requireAuth, socialController.checkContextSent);

module.exports = router;
