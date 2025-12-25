const express = require("express");
const router = express.Router();
const socialController = require("../controllers/social.controller");
const { requireAuth } = require("../middlewares/auth.middleware");

// Following
router.post("/users/:id/follow", requireAuth, socialController.followUser);

// Messaging
router.get("/conversations", requireAuth, socialController.getConversations);
router.post("/conversations", requireAuth, socialController.startConversation);
router.post("/conversations/:id/messages", requireAuth, socialController.sendMessage);

// Notifications
router.get("/notifications", requireAuth, socialController.getNotifications);

module.exports = router;
