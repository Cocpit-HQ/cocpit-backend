const express = require("express");
const router = express.Router();
const { getConfig, toggleAIGeneration, toggleFeedAlgorithm } = require("./config.controller");

// GET /api/config
// Public — no auth middleware. Called by Flutter clients at app startup.
router.get("/", getConfig);

// POST /api/config/ai-toggle
// Public (for development/testing) — toggles AI generation globally.
router.post("/ai-toggle", toggleAIGeneration);

// POST /api/config/feed-algorithm-toggle
// Public (for development/testing) — toggles feed algorithm globally.
router.post("/feed-algorithm-toggle", toggleFeedAlgorithm);

module.exports = router;
