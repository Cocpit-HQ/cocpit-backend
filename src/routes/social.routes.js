const express = require("express");
const router = express.Router();
const socialController = require("../controllers/social.controller");
const { requireAuth } = require("../middlewares/auth.middleware");

/* =====================================================
   FOLLOW (One-way)
   ===================================================== */
router.post("/users/:id/follow", requireAuth, socialController.followUser);
router.delete("/users/:id/unfollow", requireAuth, socialController.unfollowUser);
router.get("/users/:id/followers/count", socialController.getFollowersCount);
router.get("/users/:id/followers", socialController.getFollowers);
router.get("/users/:id/following", socialController.getFollowing);

/* =====================================================
   CONNECTIONS (Two-way – LinkedIn style)
   ===================================================== */// Connection Requests
router.post('/users/:id/connect', requireAuth, socialController.sendConnectionRequest);
router.get('/users/:id/relationship', requireAuth, socialController.getRelationshipStatus); // New Endpoint
router.get('/connections/requests', requireAuth, socialController.getPendingRequests);
router.patch("/connections/:requestId", requireAuth, socialController.handleConnectionRequest); // accept / reject
router.get("/connections/history", requireAuth, socialController.getConnectionRequestHistory); // NEW History
router.get("/my/connections", requireAuth, socialController.getMyConnections);                // NEW
router.delete("/connections/:requestId", requireAuth, socialController.cancelConnectionRequest); // NEW
router.delete("/connections/user/:id", requireAuth, socialController.removeConnection);   // NEW
router.get("/users/:id/connections/count", socialController.getConnectionCount);


/* =====================================================
   RELATIONSHIP STATUS (Frontend decision helper)
   ===================================================== */
// router.get("/users/:id/relationship", requireAuth, socialController.getRelationshipStatus); // NEW

/* =====================================================
   BLOCKING
   ===================================================== */
router.post("/users/:id/block", requireAuth, socialController.blockUser);
router.delete("/users/:id/unblock", requireAuth, socialController.unblockUser);
router.get("/users/me/blocks", requireAuth, socialController.getBlockedUsers);


/* =====================================================
   CONVERSATIONS
   ===================================================== */
router.get("/conversations", requireAuth, socialController.getConversations);
router.delete("/conversations/:id", requireAuth, socialController.deleteConversation);

/* =====================================================
   MESSAGES
   ===================================================== */
router.post("/messages", requireAuth, require("../middlewares/upload").uploadChatMedia.array("images", 10), socialController.sendMessage);
router.post("/social/share", requireAuth, socialController.sharePostToConversations); // Batch Share
router.get("/conversations/:id/messages", requireAuth, socialController.getMessages);
router.delete("/messages/:messageId", requireAuth, require("../controllers/message.controller").deleteMessage);

router.delete("/messages/:id", requireAuth, socialController.deleteMessage);
router.patch("/messages/:messageId/edit", requireAuth, socialController.editMessage);

router.patch("/conversations/:conversationId/read", requireAuth, socialController.markConversationRead);
router.get("/messages/:messageId/seen-by", requireAuth, socialController.getMessageSeenBy);

// router.patch("/messages/:id/read", requireAuth, socialController.markMessageRead);

/* =====================================================
   NOTIFICATIONS
   ===================================================== */
router.get("/notifications", requireAuth, socialController.getNotifications);
router.patch("/notifications/:id/read", requireAuth, socialController.markNotificationRead);
// router.patch("/notifications/read-all", requireAuth, socialController.markAllNotificationsRead);

module.exports = router;
