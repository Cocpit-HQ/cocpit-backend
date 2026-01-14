const express = require("express");
const router = express.Router();
const jobController = require("../controllers/job.controller");
const { requireAuth } = require("../middlewares/auth.middleware");
const { requireRoles } = require("../middlewares/role.middleware");
const { uploadResume } = require("../middlewares/upload");


// Public routes (or authenticated but open to all)
//search
// Get all jobs
router.get("/", jobController.getAllJobs); // /api/jobs
router.get("/offers", jobController.getJobOffers);

// Get jobs posted by logged-in all user
router.get("/my",requireAuth,jobController.getMyJobs);//

router.get("/applications/me", requireAuth, jobController.getMyApplications); // in progress, applied, in past
router.get("/:id", jobController.getJobById);
// Protected routes
router.post("/", requireAuth, requireRoles(['Recruiter', 'Admin']), jobController.createJob);
router.post("/:id/apply",requireAuth,uploadResume.single("resume"),jobController.applyJob);


router.post("/:id/save",requireAuth,jobController.saveJob); //save job
router.delete("/:id/save",requireAuth,jobController.unsaveJob); //unsave job
router.get("/saved/me", requireAuth, jobController.getMySavedJobs); //get saved job 

module.exports = router;
