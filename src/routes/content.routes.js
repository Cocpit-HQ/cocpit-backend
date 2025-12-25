const express = require("express");
const router = express.Router();
const contentController = require("../controllers/content.controller");
const { requireAuth } = require("../middlewares/auth.middleware");

// Feed
router.get("/feed", requireAuth, contentController.getFeed);
router.post("/posts", requireAuth, contentController.createPost);

// Stories
router.get("/stories", requireAuth, contentController.getStories);
router.post("/stories", requireAuth, contentController.createStory);
router.post("/stories/:id/react", requireAuth, contentController.reactToStory);

module.exports = router;
