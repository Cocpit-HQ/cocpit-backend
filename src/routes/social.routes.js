const express = require("express");
const router = express.Router();
const socialController = require("../controllers/social.controller");
const { requireAuth } = require("../middlewares/auth.middleware");

/* =====================================================
   FOLLOW (One-way)
   ===================================================== */
router.post("/users/:id/follow", requireAuth, socialController.followUser);
router.delete("/users/:id/unfollow", requireAuth, socialController.unfollowUser);
router.get("/users/:id/followers/count",  socialController.getFollowersCount);
router.get("/users/:id/followers", socialController.getFollowers);
// router.get("/users/:id/following", socialController.getFollowing);

/* =====================================================
   CONNECTIONS (Two-way – LinkedIn style)
   ===================================================== */
router.post("/users/:id/connect", requireAuth, socialController.sendConnectionRequest);
router.get("/connections/requests", requireAuth, socialController.getPendingRequests);
router.patch("/connections/:requestId", requireAuth, socialController.handleConnectionRequest); // accept / reject
router.get("/my/connections", requireAuth, socialController.getMyConnections);                // NEW
router.delete("/connections/:requestId", requireAuth, socialController.cancelConnectionRequest); // NEW
router.delete("/connections/user/:id", requireAuth, socialController.removeConnection);   // NEW
router.get("/users/:id/connections/count",  socialController.getConnectionCount);


/* =====================================================
   RELATIONSHIP STATUS (Frontend decision helper)
   ===================================================== */
// router.get("/users/:id/relationship", requireAuth, socialController.getRelationshipStatus); // NEW

/* =====================================================
   CONVERSATIONS
   ===================================================== */
router.get("/conversations", requireAuth, socialController.getConversations);
router.delete("/conversations/:id", requireAuth, socialController.deleteConversation);

/* =====================================================
   MESSAGES
   ===================================================== */
router.post("/messages", requireAuth, socialController.sendMessage);
router.get("/conversations/:id/messages", requireAuth, socialController.getMessages);
router.delete("/messages/:id", requireAuth, socialController.deleteMessage);
// router.patch("/messages/:id/read", requireAuth, socialController.markMessageRead);

/* =====================================================
   NOTIFICATIONS
   ===================================================== */
// router.get("/notifications", requireAuth, socialController.getNotifications);
// router.patch("/notifications/:id/read", requireAuth, socialController.markNotificationRead);
// router.patch("/notifications/read-all", requireAuth, socialController.markAllNotificationsRead);

module.exports = router;
