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
// New: Essential for LinkedIn-style networking
// router.post("/posts/:id/like", requireAuth, contentController.toggleLike);
// router.post("/posts/:id/comments", requireAuth, contentController.addComment);
// router.get("/posts/:id/comments", requireAuth, contentController.getComments);

// --- STORIES ---
router.get("/stories", requireAuth, contentController.getStories);
router.post("/stories", requireAuth, contentController.createStory);
// router.delete("/stories/:id", requireAuth, contentController.deleteStory);
router.post("/stories/:id/react", requireAuth, contentController.reactToStory);
router.post("/stories/:id/view", requireAuth, contentController.viewStory);




module.exports = router;
