const express = require("express");
const router = express.Router();
const contentController = require("../controllers/content.controller");
const { requireAuth } = require("../middlewares/auth.middleware");

// Feed
router.get("/feed", requireAuth, contentController.getFeed);

// Posts
router.post("/posts", requireAuth, contentController.createPost);
router.get("/posts/:id", requireAuth, contentController.getPostById);
// router.delete("/posts/:id", requireAuth, contentController.deletePost);

// Categories
// router.get("/categories", requireAuth, contentController.getCategories);
router.post("/categories", requireAuth, contentController.createPostCategory);

// Media
router.post("/posts/:id/media", requireAuth, contentController.handlePostMedia);
// router.delete("/media/:id", requireAuth, contentController.deletePostMedia);


// Stories
router.get("/stories", requireAuth, contentController.getStories);
//create story
router.post("/stories", requireAuth, contentController.createStory);
//react 
router.post("/stories/:id/react", requireAuth, contentController.reactToStory);
//view
router.post("/stories/:id/view", requireAuth, contentController.viewStory);



module.exports = router;
