const express = require("express");
const router = express.Router();
const hashtagController = require("./hashtag.controller");
const { requireAuth, optionalAuth } = require("../../core/middlewares/auth.middleware");

// Discover posts by hashtag
router.get("/posts/hashtag/:tag", optionalAuth, hashtagController.getHashtagPosts);

// Search hashtags
router.get("/hashtags/search", requireAuth, hashtagController.searchHashtags);

// Trending hashtags
router.get("/hashtags/trending", requireAuth, hashtagController.getTrendingHashtags);

module.exports = router;
