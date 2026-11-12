/**
 * Global Search Routes for COCPIT
 * Mounted at /api/search in app.js
 * Root endpoint: GET /api/search
 */
const express = require('express');
const router = express.Router();
const searchController = require('./search.controller');
const { optionalAuth } = require('../../core/middlewares/auth.middleware');
const { resolveActorContext } = require('../../core/middlewares/actor-context.middleware');

// GET /api/search
router.get('/', optionalAuth, resolveActorContext, searchController.globalSearch);

module.exports = router;

