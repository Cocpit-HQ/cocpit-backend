const express = require("express");
const router = express.Router();
const { getConfig } = require("./config.controller");

// GET /api/config
// Public — no auth middleware. Called by Flutter clients at app startup.
router.get("/", getConfig);

module.exports = router;
