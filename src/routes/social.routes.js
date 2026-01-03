const express = require("express");
const router = express.Router();
const socialController = require("../controllers/social.controller");
const { requireAuth } = require("../middlewares/auth.middleware");

// ----------------- FOLLOW -----------------

// Follow another user
router.post("/users/:id/follow", requireAuth, socialController.followUser); // Add logged-in user as follower

// Unfollow a user
router.delete("/users/:id/unfollow", requireAuth, socialController.unfollowUser); // Remove logged-in user from followers

// ----------------- CONVERSATIONS -----------------

// Get all conversations of logged-in user
router.get("/conversations", requireAuth, socialController.getConversations); // List user's conversations

// Start a new 1-on-1 conversation
router.post("/conversations", requireAuth, socialController.startConversation); // Create new conversation if not exists

// ----------------- MESSAGES -----------------

// Send a message to a user (auto-create 1-on-1 conversation if needed)
router.post("/messages", requireAuth, socialController.sendMessage); 
// Body: { "targetUserId": "123", "text_content": "Hello!" }

// Get all messages in a conversation
router.get("/conversations/:id/messages", requireAuth, socialController.getMessages); // Get messages for conversation

// Delete a message sent by logged-in user
router.delete("/messages/:id", requireAuth, socialController.deleteMessage); // Delete specific message

// ----------------- NOTIFICATIONS -----------------

// Get all notifications for logged-in user
router.get("/notifications", requireAuth, socialController.getNotifications); // Fetch notifications

// Mark a notification as read
router.patch("/notifications/:id/read", requireAuth, socialController.markNotificationRead); // Mark notification read

module.exports = router;

