const express = require("express");
const router = express.Router();
const activityController = require("./activity.controller");
const { requireAuth } = require("../../core/middlewares/auth.middleware");

router.get("/activity", requireAuth, activityController.getActivity);
router.delete("/activity/clear", requireAuth, activityController.clearActivity);

module.exports = router;
