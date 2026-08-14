const express = require("express");
const router = express.Router();
const dashboardController = require("./dashboard.controller");
const { requireAuth, optionalAuth } = require("../../core/middlewares/auth.middleware");
const { resolveActorContext } = require("../../core/middlewares/actor-context.middleware");

router.get("/stats", requireAuth, resolveActorContext, dashboardController.getDashboardStats);
router.post("/view", requireAuth, resolveActorContext, dashboardController.recordProfileView);
router.get("/:profileType/:profileOwnerId/views", requireAuth, dashboardController.getProfileViews);
router.get("/:profileType/:profileId/search-appearances", requireAuth, dashboardController.getSearchAppearanceCount);

// Interaction Tracking
router.post("/post/:id/impression", optionalAuth, resolveActorContext, dashboardController.recordImpression);

module.exports = router;
