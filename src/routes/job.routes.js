const express = require("express");
const router = express.Router();
const jobController = require("../controllers/job.controller");
const { requireAuth } = require("../middlewares/auth.middleware");
const { requireRoles } = require("../middlewares/role.middleware");

// Public routes (or authenticated but open to all)
router.get("/", jobController.getAllJobs); // /api/jobs

// Get jobs posted by logged-in recruiter
router.get("/my",requireAuth,requireRoles(['Recruiter', 'Admin']),jobController.getMyJobs);

router.get("/applications/me", requireAuth, jobController.getMyApplications);
router.get("/:id", jobController.getJobById);

// Protected routes
router.post("/", requireAuth, requireRoles(['Recruiter', 'Admin']), jobController.createJob);
router.post("/:id/apply", requireAuth, jobController.applyJob);


module.exports = router;
