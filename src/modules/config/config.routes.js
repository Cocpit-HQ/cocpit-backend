const express = require('express');
const router = express.Router();
const { getConfig, toggleAIGeneration, toggleFeedAlgorithm } = require('./config.controller');

// GET /api/config
// Public — no auth middleware. Called by Flutter clients at app startup.
router.get('/', getConfig);

// POST /api/config/ai-toggle
// Public (for development/testing) — toggles AI generation globally.
if (process.env.DISABLE_CONFIG_WRITES !== 'true') {
  router.post('/ai-toggle', toggleAIGeneration);
  router.post('/feed-algorithm-toggle', toggleFeedAlgorithm);
}

module.exports = router;
