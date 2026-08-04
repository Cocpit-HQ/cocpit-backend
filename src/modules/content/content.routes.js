const express = require("express");
const router = express.Router();
const contentController = require("./content.controller");
const { toggleSavePost, getSavedPosts, checkIfPostSaved, createFolder, getFolders, renameFolder, deleteFolder } = require("./savedPost.controller");
const { requireAuth, optionalAuth } = require("../../core/middlewares/auth.middleware");
const { validate } = require("../../core/middlewares/validation.middleware");
const postTagsController = require("./postTags.controller");
const { syncTagsSchema } = require("./postTags.schema");
const { commentOperationSchema, updateCommentSchema, hideCommentSchema, createPostSchema } = require("./content.schema");
const { uploadPostMedia, uploadCover } = require("../../core/middlewares/upload.middleware");
const achievementImageController = require("./achievementImage.controller");

// Feed & Discovery
router.get("/All/feeds", optionalAuth, contentController.getPublicFeed);
router.get("/users/me/posts", requireAuth, contentController.getMyPosts);
router.get("/users/me/posts/commented", requireAuth, contentController.getMyCommentedPosts);
router.get("/users/me/posts/private", requireAuth, contentController.getMyPrivatePosts);

// Posts (Image, Video, Article, Poll)
router.post("/post", requireAuth, uploadPostMedia, validate(createPostSchema), contentController.createPost);
router.get("/post/:id", requireAuth, contentController.getPostById);
router.put("/post/:id", requireAuth, uploadPostMedia, contentController.updatePostById);
router.delete("/post/:id", requireAuth, contentController.deletePost);

// Achievement Images
router.get("/achievement-images", requireAuth, achievementImageController.getAll);

// Post Tags
router.post("/posts/tags/sync", requireAuth, validate(syncTagsSchema), postTagsController.syncPostTags);
router.get("/posts/tags", requireAuth, postTagsController.getActivePostTags);
// Post Moderation
router.post("/post/:id/flag", requireAuth, contentController.flagPost);
// The moderation endpoint requires the exact orgId format to use our RBAC middleware
// Assuming it's hit as /api/organizations/:orgId/posts/:postId/moderate
const { requireOrgPermission } = require("../../core/middlewares/organization.auth.middleware");
router.delete("/organizations/:orgId/posts/:postId/moderate", requireAuth, requireOrgPermission("MANAGE_COMMENTS"), contentController.moderatePost);

// Save / Unsave
router.post("/posts/:postId/save", requireAuth, toggleSavePost);

// Saved Folders CRUD
router.post("/saved-folders", requireAuth, uploadCover.single("cover_image"), createFolder);
router.get("/saved-folders", requireAuth, getFolders);
router.put("/saved-folders/:folderId", requireAuth, uploadCover.single("cover_image"), renameFolder);
router.delete("/saved-folders/:folderId", requireAuth, deleteFolder);

router.get("/saved-posts", requireAuth, getSavedPosts);
router.get("/posts/:postId/saved", requireAuth, checkIfPostSaved);

// Poll Interaction
router.post("/post/:id/poll/vote", requireAuth, contentController.voteInPoll);
router.delete("/post/:id/poll/vote", requireAuth, contentController.removeVote);
router.get("/post/:id/poll/analytics", requireAuth, contentController.getPollAnalytics);

// Social Engagement
router.post("/post/:id/like", requireAuth, contentController.toggleLike);
router.get("/post/:id/likes", requireAuth, contentController.getPostLikes);
router.post("/post/:id/comments", requireAuth, contentController.addComment);
router.post("/comments/:commentId/like", requireAuth, contentController.toggleCommentLike);
router.post("/comments/:commentId/pin", requireAuth, contentController.toggleCommentPin);
router.put("/comments/:commentId", requireAuth, validate(updateCommentSchema), contentController.updateComment);
router.delete("/comments/:commentId", requireAuth, validate(commentOperationSchema), contentController.deleteComment);
router.get("/post/:id/comments", requireAuth, contentController.getComments);
router.post("/comments/:commentId/hide", requireAuth, validate(hideCommentSchema), contentController.hideComment);
router.delete("/comments/:commentId/hide", requireAuth, validate(commentOperationSchema), contentController.unhideComment);
router.get("/users/me/comments/hidden", requireAuth, contentController.getHiddenComments);

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


router.get("/debug-db", async (req, res) => {
    const pool = require("../../core/db/pool");
    try {
        const result = await pool.query("SELECT current_database(), inet_server_addr(), inet_client_addr()");
        res.json({
            database: result.rows[0].current_database,
            server_addr: result.rows[0].inet_server_addr,
            client_addr: result.rows[0].inet_client_addr,
            env_db_host: process.env.DB_HOST,
            env_db_name: process.env.DB_NAME
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
