/**
 * Universal Share Routes
 *
 * POST /api/share                                — Universal share
 * GET  /api/entity/preview/:entityType/:entityId — Preview metadata
 */

const express = require("express");
const router = express.Router();
const shareController = require("./share.controller");
const { requireAuth } = require("../../core/middlewares/auth.middleware");

// Universal share endpoint
router.post("/share", requireAuth, shareController.share);

// Entity preview metadata endpoint
router.get("/entity/preview/:entityType/:entityId", requireAuth, shareController.getPreview);

// Batch preview metadata endpoint
router.post("/entity/preview/batch", requireAuth, shareController.batchGetPreview);

// Legacy: Profile sharing in DM (moved from messaging routes)
router.post("/messages/share-profile", requireAuth, shareController.shareProfileInDM);

// Legacy: Share profile via notification + DM (moved from social routes)
router.post("/profile/share", requireAuth, shareController.shareProfile);

// Legacy: Batch share post to conversations (moved from social routes)
router.post("/social/share", requireAuth, shareController.sharePostToConversations);

// Share to Feed (repost) — delegates to content.controller.createPost
router.post("/share/feed", requireAuth, shareController.shareToFeed);

// Share to Story — delegates to content.controller.createStory
router.post("/share/story", requireAuth, shareController.shareToStory);

// Share Job to Story
router.post("/share/job-to-story", requireAuth, shareController.shareJobToStory);

// Share users list for share component (priority ordered)
router.get("/share/users", requireAuth, shareController.getShareUsers);

module.exports = router;

