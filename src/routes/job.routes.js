const express = require("express");
const router = express.Router();
const jobController = require("../controllers/job.controller");
const { requireAuth, optionalAuth } = require("../middlewares/auth.middleware");
const { requireRoles } = require("../middlewares/role.middleware");
const { uploadResume } = require("../middlewares/upload");


// Public routes (or authenticated but open to all)
// Get all jobs
router.get("/", optionalAuth, jobController.getAllJobs); // /api/jobs

// IMPORTANT: Specific routes MUST come before /:id catch-all
router.get("/offers", optionalAuth, jobController.getJobOffers);
router.get("/stats", requireAuth, jobController.getDashboardStats);
router.get("/applications/me", requireAuth, jobController.getMyApplications); // in progress, applied, in past
router.get("/saved/me", requireAuth, jobController.getMySavedJobs); //get saved job 
router.get("/my", requireAuth, jobController.getMyJobs);
router.get("/:id/applicants", requireAuth, jobController.getJobApplicants);

// Catch-all route - MUST be last among GET routes
router.get("/:id", optionalAuth, jobController.getJobById);

// Protected routes
router.post("/", requireAuth, requireRoles(['Recruiter', 'Admin']), jobController.createJob);
router.post("/:id/apply", requireAuth, uploadResume.single("resume"), jobController.applyJob);
router.post("/:id/save", requireAuth, jobController.saveJob); //save job
router.delete("/:id/save", requireAuth, jobController.unsaveJob); //unsave job

module.exports = router;
