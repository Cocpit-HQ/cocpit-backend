const express = require("express");
const router = express.Router();
const socialController = require("../controllers/social.controller");
const { requireAuth } = require("../middlewares/auth.middleware");

/**
 * @swagger
 * tags:
 *   name: Social
 *   description: Social features (Following, Messaging, Notifications)
 */

// Following
/**
 * @swagger
 * /api/users/{id}/follow:
 *   post:
 *     summary: Follow a user
 *     tags: [Social]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: User followed
 */
router.post("/users/:id/follow", requireAuth, socialController.followUser);

// Messaging
/**
 * @swagger
 * /api/conversations:
 *   get:
 *     summary: Get user conversations
 *     tags: [Social]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of conversations
 */
router.get("/conversations", requireAuth, socialController.getConversations);

/**
 * @swagger
 * /api/conversations:
 *   post:
 *     summary: Start a new conversation
 *     tags: [Social]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       201:
 *         description: Conversation started
 */
router.post("/conversations", requireAuth, socialController.startConversation);

/**
 * @swagger
 * /api/conversations/{id}/messages:
 *   post:
 *     summary: Send a message to a conversation
 *     tags: [Social]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       201:
 *         description: Message sent
 */
router.post("/conversations/:id/messages", requireAuth, socialController.sendMessage);

// Notifications
/**
 * @swagger
 * /api/notifications:
 *   get:
 *     summary: Get user notifications
 *     tags: [Social]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of notifications
 */
router.get("/notifications", requireAuth, socialController.getNotifications);

module.exports = router;
