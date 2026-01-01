const express = require("express");
const router = express.Router();
const contentController = require("../controllers/content.controller");
const { requireAuth } = require("../middlewares/auth.middleware");

/**
 * @swagger
 * tags:
 *   name: Content
 *   description: Feed, Posts, and Stories
 */

// Feed
/**
 * @swagger
 * /api/feed:
 *   get:
 *     summary: Get user feed
 *     tags: [Content]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: User feed content
 */
router.get("/feed", requireAuth, contentController.getFeed);

// Posts
/**
 * @swagger
 * /api/posts:
 *   post:
 *     summary: Create a new post
 *     tags: [Content]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       201:
 *         description: Post created
 */
router.post("/posts", requireAuth, contentController.createPost);

/**
 * @swagger
 * /api/posts/{id}:
 *   get:
 *     summary: Get post by ID
 *     tags: [Content]
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
 *         description: Post details
 */
router.get("/posts/:id", requireAuth, contentController.getPostById);
// router.delete("/posts/:id", requireAuth, contentController.deletePost);

// Categories
// router.get("/categories", requireAuth, contentController.getCategories);
/**
 * @swagger
 * /api/categories:
 *   post:
 *     summary: Create a post category
 *     tags: [Content]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       201:
 *         description: Category created
 */
router.post("/categories", requireAuth, contentController.createPostCategory);

// Media
/**
 * @swagger
 * /api/posts/{id}/media:
 *   post:
 *     summary: Upload media for a post
 *     tags: [Content]
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
 *         description: Media uploaded
 */
router.post("/posts/:id/media", requireAuth, contentController.handlePostMedia);
// router.delete("/media/:id", requireAuth, contentController.deletePostMedia);


// Stories
/**
 * @swagger
 * /api/stories:
 *   get:
 *     summary: Get active stories
 *     tags: [Content]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of stories
 */
router.get("/stories", requireAuth, contentController.getStories);

//create story
/**
 * @swagger
 * /api/stories:
 *   post:
 *     summary: Create a new story
 *     tags: [Content]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       201:
 *         description: Story created
 */
router.post("/stories", requireAuth, contentController.createStory);

//react 
/**
 * @swagger
 * /api/stories/{id}/react:
 *   post:
 *     summary: React to a story
 *     tags: [Content]
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
 *         description: Reaction recorded
 */
router.post("/stories/:id/react", requireAuth, contentController.reactToStory);

//view
/**
 * @swagger
 * /api/stories/{id}/view:
 *   post:
 *     summary: Mark story as viewed
 *     tags: [Content]
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
 *         description: Story view recorded
 */
router.post("/stories/:id/view", requireAuth, contentController.viewStory);



module.exports = router;
