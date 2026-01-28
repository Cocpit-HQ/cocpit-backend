const express = require("express");
const router = express.Router();
const contentController = require("../controllers/content.controller");
const { requireAuth, optionalAuth } = require("../middlewares/auth.middleware");

// --- FEED & DISCOVERY ---
router.get("/All/feeds", optionalAuth, contentController.getPublicFeed);
router.get("/users/me/posts", requireAuth, contentController.getMyPosts);

// --- POSTS (Handles Image, Video, Article, Poll) ---
router.post("/post", requireAuth, contentController.createPost);
router.get("/post/:id", requireAuth, contentController.getPostById);
router.put("/post/:id", requireAuth, contentController.updatePostById);
router.delete("/post/:id", requireAuth, contentController.deletePost);
// router.post("/post/:id/share", requireAuth, contentController.sharePost);
// post share story share

// --- POLL INTERACTION ---
// --- POLL INTERACTION ---
router.post("/post/:id/poll/vote", requireAuth, contentController.voteInPoll);
router.delete("/post/:id/poll/vote", requireAuth, contentController.removeVote);
router.get("/post/:id/poll/analytics", requireAuth, contentController.getPollAnalytics);

// --- SOCIAL ENGAGEMENT ---
router.post("/post/:id/like", requireAuth, contentController.toggleLike);
router.post("/post/:id/comments", requireAuth, contentController.addComment);
router.put("/post/comments/:comment_id", requireAuth, contentController.updateComment);
router.delete("/post/comments/:comment_id", requireAuth, contentController.deleteComment)
router.get("/post/:id/comments", requireAuth, contentController.getComments);

// --- STORIES ---
router.get("/stories/grouped", requireAuth, contentController.getGroupedStories);
router.get("/stories", requireAuth, contentController.getStories);
router.post("/story", requireAuth, contentController.createStory);
router.delete("/stories/:id", requireAuth, contentController.deleteStory);
router.post("/stories/:id/react", requireAuth, contentController.reactToStory);
router.post("/stories/:id/view", requireAuth, contentController.viewStory);
router.get('/stories/:id', requireAuth, contentController.getStoryDetailsById)
router.post("/stories/:id/comments", requireAuth, contentController.addStoryComment);
router.get("/stories/:id/comments", requireAuth, contentController.getStoryComments);
router.delete("/stories/comments/:comment_id", requireAuth, contentController.deleteStoryComment);

module.exports = router;
