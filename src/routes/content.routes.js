const express = require("express");
const router = express.Router();
const contentController = require("../controllers/content.controller");
const { requireAuth } = require("../middlewares/auth.middleware");

// --- FEED & DISCOVERY ---
router.get("/All/feeds", requireAuth, contentController.getPublicFeed);
router.get("/Personal/feed", requireAuth, contentController.getPersonalizedFeed);

// --- POSTS (Handles Image, Video, Article, Poll) ---
router.post("/post", requireAuth, contentController.createPost);
router.get("/post/:id", requireAuth, contentController.getPostById);
router.put("/post/:id", requireAuth, contentController.updatePostById);
router.delete("/post/:id", requireAuth, contentController.deletePost);


// --- POLL INTERACTION ---
router.post("/post/:id/poll/vote", requireAuth, contentController.voteInPoll);

// --- SOCIAL ENGAGEMENT ---
router.post("/post/:id/like", requireAuth, contentController.toggleLike);
router.post("/post/:id/comments", requireAuth, contentController.addComment);
router.put("/post/comments/:comment_id", requireAuth, contentController.updateComment);
router.delete("/post/comments/:comment_id", requireAuth, contentController.deleteComment)
router.get("/post/:id/comments", requireAuth, contentController.getComments);

// --- STORIES ---
router.get("/stories", requireAuth, contentController.getStories);
router.post("/story", requireAuth, contentController.createStory);
router.delete("/stories/:id", requireAuth, contentController.deleteStory);
router.post("/stories/:id/react", requireAuth, contentController.reactToStory);
router.post("/stories/:id/view", requireAuth, contentController.viewStory);
router.get('/stories/:id', requireAuth, contentController.getStoryDetailsById)




module.exports = router;
