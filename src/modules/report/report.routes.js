const express = require("express");
const router = express.Router();
const reportController = require("./report.controller");
const { requireAuth } = require("../../core/middlewares/auth.middleware");

// Get report reasons (Public)
router.get("/report-reasons", reportController.getReportReasons);

// Create a report (Requires Auth)
router.post("/reports", requireAuth, reportController.createReport);

module.exports = router;
