const express = require("express");
const router = express.Router();
const jobController = require("../controllers/job.controller");
const { requireAuth, optionalAuth } = require("../middlewares/auth.middleware");
const { requireRoles } = require("../middlewares/role.middleware");
const { uploadResume, uploadApplicationFiles, uploadTaskSubmission } = require("../middlewares/upload");


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
router.get("/recruiter/:id/stats", optionalAuth, jobController.getRecruiterStats);

// Catch-all route - MUST be last among GET routes
router.get("/:id", optionalAuth, jobController.getJobById);

// Protected routes
router.post("/", requireAuth, requireRoles(['Recruiter', 'Admin', 'Employer']), jobController.createJob);
router.post("/:id/apply", requireAuth, uploadApplicationFiles, jobController.applyJob);
router.post("/:id/save", requireAuth, jobController.saveJob); //save job
router.delete("/:id/save", requireAuth, jobController.unsaveJob); //unsave job
router.put("/:id", requireAuth, requireRoles(['Recruiter', 'Admin', 'Employer']), jobController.updateJob);
router.delete("/:id", requireAuth, requireRoles(['Recruiter', 'Admin', 'Employer']), jobController.deleteJob);

// Application Management Routes
router.put("/applications/:id/status", requireAuth, requireRoles(['Recruiter', 'Admin', 'Employer']), jobController.updateApplicationStatus);
router.post("/applications/:id/submit-task", requireAuth, uploadTaskSubmission, jobController.submitTask);
router.post("/applications/:id/review", requireAuth, requireRoles(['Recruiter', 'Admin', 'Employer']), jobController.reviewApplication);

module.exports = router;
