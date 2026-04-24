const express = require("express");
const router = express.Router();
const activityController = require("./activity.controller");
const { requireAuth } = require("../../core/middlewares/auth.middleware");

router.get("/getActivity", requireAuth, activityController.getActivity);
router.delete("/clearActivity", requireAuth, activityController.clearActivity);

module.exports = router;
