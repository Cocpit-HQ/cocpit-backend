const express = require("express");
const router = express.Router();
const userController = require("../controllers/user.controller");
const { requireAuth } = require("../middlewares/auth.middleware");

// All routes require authentication
router.use(requireAuth);

// Search users (real-time)
router.get("/search", userController.searchUsers);

// Get public profile
router.get("/:id", userController.getUserProfile);

//Get public profile post
router.get("/:id/posts",userController.getPublicProfilePosts)

module.exports = router;
