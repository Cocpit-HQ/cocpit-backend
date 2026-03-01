const express = require("express");
const router = express.Router();
const companyController = require("./company.controller");
const companyJobsController = require("./company.jobs.controller");
const analyticsController = require("./company.analytics.controller");
const roleController = require("./company.roles.controller");
const { requireAuth, optionalAuth } = require("../../core/middlewares/auth.middleware");
const { requireCompanyPermission } = require("../../core/middlewares/company.auth.middleware");
const { companyActionLimiter, otpGenerationLimiter } = require("../../core/middlewares/rateLimit.middleware");
const { uploadAvatar, uploadCover } = require("../../core/middlewares/upload.middleware");

// Public (or optional auth)
router.get("/companies/check-slug", optionalAuth, companyController.checkSlug);
router.get("/companies/mine", requireAuth, companyController.getUserCompanies);
router.get("/companies/:slug", optionalAuth, companyController.getCompany);

// Protected Routes
router.post("/companies", requireAuth, companyActionLimiter, companyController.createCompany);
router.post("/companies/invites/accept", requireAuth, companyController.acceptInvite);
router.post("/companies/:companyId/members/invite", requireAuth, companyActionLimiter, companyController.inviteMember);
router.get("/companies/:companyId/members", requireAuth, companyController.getMembers);
router.delete("/companies/:companyId/members/:memberId", requireAuth, companyController.removeMember);
router.post("/companies/:companyId/leave", requireAuth, companyController.leaveCompany);

router.post("/companies/:companyId/verify/domain", requireAuth, otpGenerationLimiter, companyController.verifyDomain);
router.post("/companies/:companyId/transfer-ownership", requireAuth, companyActionLimiter, companyController.transferOwnership);
router.put("/companies/:companyId", requireAuth, companyController.updateCompany);
router.delete("/companies/:companyId", requireAuth, companyActionLimiter, companyController.deleteCompany);

// Analytics
router.get("/companies/:companyId/analytics/overview", requireAuth, analyticsController.getOverview);
router.get("/companies/:companyId/analytics/engagement", requireAuth, analyticsController.getEngagement);
router.get("/companies/:companyId/analytics/jobs", requireAuth, analyticsController.getJobs);
router.get("/companies/:companyId/audit-logs", requireAuth, analyticsController.getAuditLogs);

// Tech Stack
router.get("/companies/:slug/tech-stack", optionalAuth, companyController.getTechStack);
router.post("/companies/:companyId/tech-stack", requireAuth, companyController.addTechStack);
router.delete("/companies/:companyId/tech-stack/:stackId", requireAuth, companyController.removeTechStack);

// Gallery
router.get("/companies/:slug/gallery", optionalAuth, companyController.getGallery);
router.post("/companies/:companyId/gallery", requireAuth, companyController.addToGallery);
router.delete("/companies/:companyId/gallery/:galleryId", requireAuth, companyController.removeFromGallery);

// Advocacy
router.post("/companies/:companyId/posts/:postId/notify", requireAuth, companyController.notifyEmployees);

// Company Posts
router.get("/companies/:companyId/posts", optionalAuth, companyController.getCompanyPosts);

// Company Jobs
router.get("/companies/:companyId/jobs", optionalAuth, companyJobsController.getCompanyJobs);
router.post("/companies/:companyId/jobs", requireAuth, requireCompanyPermission("POST_JOBS"), companyJobsController.createCompanyJob);
router.put("/companies/:companyId/jobs/:jobId", requireAuth, requireCompanyPermission("POST_JOBS"), companyJobsController.updateCompanyJob);
router.delete("/companies/:companyId/jobs/:jobId", requireAuth, requireCompanyPermission("POST_JOBS"), companyJobsController.deleteCompanyJob);

// Roles Management
router.get("/companies/:companyId/roles", requireAuth, roleController.getCompanyRoles);
router.post("/companies/:companyId/roles", requireAuth, requireCompanyPermission("MANAGE_ROLES"), roleController.createCompanyRole);
router.put("/companies/:companyId/roles/:roleId", requireAuth, requireCompanyPermission("MANAGE_ROLES"), roleController.updateCompanyRole);
router.delete("/companies/:companyId/roles/:roleId", requireAuth, requireCompanyPermission("MANAGE_ROLES"), roleController.deleteCompanyRole);

// Member Role Assignment
router.put("/companies/:companyId/members/:userId/role", requireAuth, requireCompanyPermission("MANAGE_MEMBERS"), roleController.assignRoleToMember);

// Member Self-Settings
router.put("/companies/:companyId/my-role-settings", requireAuth, roleController.updateMemberRoleSettings);

// Uploads
router.post("/companies/:companyId/logo", requireAuth, requireCompanyPermission("MANAGE_SETTINGS"), uploadAvatar.single("avatar"), companyController.uploadLogo);
router.delete("/companies/:companyId/logo", requireAuth, requireCompanyPermission("MANAGE_SETTINGS"), companyController.deleteLogo);
router.post("/companies/:companyId/cover", requireAuth, requireCompanyPermission("MANAGE_SETTINGS"), uploadCover.single("cover"), companyController.uploadCover);
router.delete("/companies/:companyId/cover", requireAuth, requireCompanyPermission("MANAGE_SETTINGS"), companyController.deleteCover);

module.exports = router;
