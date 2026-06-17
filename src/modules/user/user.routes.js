const express = require("express");
const router = express.Router();
const userController = require("./user.controller");
const { requireAuth } = require("../../core/middlewares/auth.middleware");

// All routes require authentication
router.use(requireAuth);

// Search users (real-time)
router.get("/search", userController.searchUsers);

// Get suggested users
router.get("/suggested", userController.getSuggestedUsers);

// Get public profile
router.get("/:id", userController.getUserProfile);

// Get public profile posts (commented) - must be BEFORE /:id to avoid shadowing
router.get("/:id/posts/commented", userController.getPublicProfileCommentedPosts);

// Get public profile posts
router.get("/:id/posts", userController.getPublicProfilePosts);

// Delete account
router.delete("/account", userController.deleteAccount);

module.exports = router;
