const express = require("express");
const router = express.Router();
const dashboardController = require("./dashboard.controller");
const { requireAuth } = require("../../core/middlewares/auth.middleware");
const { resolveActorContext } = require("../../core/middlewares/actor-context.middleware");

router.get("/stats", requireAuth, resolveActorContext, dashboardController.getDashboardStats);
router.post("/view", requireAuth, dashboardController.recordProfileView);
router.get("/:profileType/:profileOwnerId/views", requireAuth, dashboardController.getProfileViews);

module.exports = router;
