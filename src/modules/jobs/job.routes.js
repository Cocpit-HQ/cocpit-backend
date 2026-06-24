const express = require("express");
const router = express.Router();
const jobController = require("./job.controller");
const offerController = require("./offer.controller");
const { requireAuth, optionalAuth } = require("../../core/middlewares/auth.middleware");
const { requireRoles } = require("../../core/middlewares/role.middleware");
const { requireOrgPermission, requireCompanyPermission } = require("../../core/middlewares/organization.auth.middleware");
const { uploadApplicationFiles, uploadTaskSubmission } = require("../../core/middlewares/upload.middleware");
const { validate } = require("../../core/middlewares/validation.middleware");
const { createDraftSchema, updateDraftSchema, submitJobSchema } = require("../../schemas/job.schema");
const { createAIRateLimiter } = require("../../core/middlewares/rateLimiter.middleware");

// Initialise the AI rate limiter once (3 generations per user per minute)
const aiRateLimiter = createAIRateLimiter();

// Public routes
router.get("/", optionalAuth, jobController.getAllJobs);
router.get("/roles", jobController.getJobRoles);

// Specific routes MUST come before /:id catch-all
router.get("/offers", optionalAuth, jobController.getJobOffers);
router.get("/offers/me", requireAuth, offerController.getMyOffers);
router.get("/stats", requireAuth, jobController.getDashboardStats);
router.get("/applications/me", requireAuth, jobController.getMyApplications);
router.get("/saved/me", requireAuth, jobController.getMySavedJobs);
router.get("/my", requireAuth, jobController.getMyJobs);
router.get("/:id/applicants", requireAuth, jobController.getJobApplicants);
router.get("/recruiter/:id/stats", optionalAuth, jobController.getRecruiterStats);

// Catch-all GET - MUST be last among GETs
router.get("/:id", optionalAuth, jobController.getJobById);

// Protected routes
router.post("/", requireAuth, validate(createDraftSchema), jobController.createJob);
router.patch("/:id", requireAuth, validate(updateDraftSchema), jobController.updateDraft);
router.post("/:id/submit", requireAuth, validate(submitJobSchema), jobController.submitJob);
router.post("/:id/clone", requireAuth, jobController.cloneJob);

// Lifecycle actions
router.post("/:id/pause", requireAuth, jobController.pauseJob);
router.post("/:id/close", requireAuth, jobController.closeJob);
router.post("/:id/archive", requireAuth, jobController.archiveJob);
router.post("/:id/approve", requireAuth, jobController.approveJob);
router.post("/:id/reject", requireAuth, jobController.rejectJob);

// AI actions
router.post("/:id/ai/actions", requireAuth, jobController.aiAction);

// AI Job Description Generator
// Rate limited: 3 generations per user per minute
router.post("/:id/generate", requireAuth, aiRateLimiter, jobController.generateJD);

router.post("/:id/apply", requireAuth, uploadApplicationFiles, jobController.applyJob);
router.post("/:id/save", requireAuth, jobController.saveJob);
router.delete("/:id/save", requireAuth, jobController.unsaveJob);
router.put("/:id", requireAuth, jobController.updateJob);
router.delete("/:id", requireAuth, jobController.deleteJob);

// Direct Job Offers
router.post("/companies/:companyId/offers", requireAuth, requireCompanyPermission("MANAGE_JOBS"), offerController.sendJobOffer);
router.get("/companies/:companyId/offers/sent", requireAuth, requireCompanyPermission("VIEW_JOBS"), offerController.getCompanySentOffers);
router.get("/companies/:companyId/offers/job/:jobId/recipients", requireAuth, requireCompanyPermission("VIEW_JOBS"), offerController.getCompanyOfferRecipients);
router.get("/companies/:companyId/offers/check/:targetUserId", requireAuth, requireCompanyPermission("VIEW_JOBS"), offerController.checkOfferStatus);
router.patch("/offers/:offerId/respond", requireAuth, offerController.respondToOffer);
router.delete("/companies/:companyId/offers/:offerId", requireAuth, requireCompanyPermission("MANAGE_JOBS"), offerController.withdrawOffer);
router.get("/offers/:offerId", requireAuth, offerController.getOfferDetail);

// Application Management
router.put("/applications/:id/status", requireAuth, jobController.updateApplicationStatus);
router.post("/applications/:id/submit-task", requireAuth, uploadTaskSubmission, jobController.submitTask);
router.post("/applications/:id/review", requireAuth, jobController.reviewApplication);

module.exports = router;
