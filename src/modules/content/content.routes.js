const express = require("express");
const router = express.Router();
const contentController = require("./content.controller");
const { toggleSavePost, getSavedPosts, checkIfPostSaved, createFolder, getFolders, renameFolder, deleteFolder } = require("./savedPost.controller");
const { requireAuth, optionalAuth } = require("../../core/middlewares/auth.middleware");

// Feed & Discovery
router.get("/All/feeds", optionalAuth, contentController.getPublicFeed);
router.get("/users/me/posts", requireAuth, contentController.getMyPosts);

// Posts (Image, Video, Article, Poll)
router.post("/post", requireAuth, contentController.createPost);
router.get("/post/:id", requireAuth, contentController.getPostById);
router.put("/post/:id", requireAuth, contentController.updatePostById);
router.delete("/post/:id", requireAuth, contentController.deletePost);

// Save / Unsave
router.post("/posts/:postId/save", requireAuth, toggleSavePost);

// Saved Folders CRUD
router.post("/saved-folders", requireAuth, createFolder);
router.get("/saved-folders", requireAuth, getFolders);
router.put("/saved-folders/:folderId", requireAuth, renameFolder);
router.delete("/saved-folders/:folderId", requireAuth, deleteFolder);

router.get("/saved-posts", requireAuth, getSavedPosts);
router.get("/posts/:postId/saved", requireAuth, checkIfPostSaved);

// Poll Interaction
router.post("/post/:id/poll/vote", requireAuth, contentController.voteInPoll);
router.delete("/post/:id/poll/vote", requireAuth, contentController.removeVote);
router.get("/post/:id/poll/analytics", requireAuth, contentController.getPollAnalytics);

// Social Engagement
router.post("/post/:id/like", requireAuth, contentController.toggleLike);
router.post("/post/:id/comments", requireAuth, contentController.addComment);
router.post("/comments/:commentId/like", requireAuth, contentController.toggleCommentLike);
router.post("/comments/:commentId/pin", requireAuth, contentController.toggleCommentPin);
router.put("/comments/:commentId", requireAuth, contentController.updateComment);
router.delete("/comments/:commentId", requireAuth, contentController.deleteComment);
router.get("/post/:id/comments", requireAuth, contentController.getComments);

// Stories
router.get("/stories/grouped", requireAuth, contentController.getGroupedStories);
router.get("/stories/recommendations", requireAuth, contentController.getStoryRecommendations);
router.get("/stories", requireAuth, contentController.getStories);
router.post("/story", requireAuth, contentController.createStory);
router.delete("/stories/:id", requireAuth, contentController.deleteStory);
router.post("/stories/:id/react", requireAuth, contentController.reactToStory);
router.post("/stories/:id/view", requireAuth, contentController.viewStory);
router.get("/stories/:id", requireAuth, contentController.getStoryDetailsById);
router.post("/stories/:id/comments", requireAuth, contentController.addStoryComment);
router.get("/stories/:id/comments", requireAuth, contentController.getStoryComments);
router.delete("/stories/comments/:comment_id", requireAuth, contentController.deleteStoryComment);

module.exports = router;
