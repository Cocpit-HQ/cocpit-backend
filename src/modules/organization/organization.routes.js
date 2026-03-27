const express = require("express");
const router = express.Router();
const organizationController = require("./organization.controller");
const membersController = require("./organization.members.controller");
const verifyController = require("./organization.verification.controller");
const postsController = require("./organization.posts.controller");
const settingsController = require("./organization.settings.controller");
const organizationJobsController = require("./organization.jobs.controller");
const analyticsController = require("./organization.analytics.controller");
const roleController = require("./organization.roles.controller");
const { requireAuth, optionalAuth } = require("../../core/middlewares/auth.middleware");
const { requireOrgPermission } = require("../../core/middlewares/organization.auth.middleware");
const { organizationActionLimiter, otpGenerationLimiter } = require("../../core/middlewares/rateLimit.middleware");
const { uploadAvatar, uploadCover } = require("../../core/middlewares/upload.middleware");
const { requireRoles } = require("../../core/middlewares/role.middleware");
const institutionController = require("./institution.controller");
const hierarchyController = require("./organization.hierarchy.controller");

// --- PUBLIC & SHARED ---
router.get("/organizations/check-slug", optionalAuth, organizationController.checkSlug);
router.get("/companies/check-slug", optionalAuth, organizationController.checkSlug);

router.get("/organizations/mine", requireAuth, organizationController.getUserOrganizations);
router.get("/companies/mine", requireAuth, organizationController.getUserOrganizations);

router.get("/organizations/search", optionalAuth, organizationController.searchOrganizations);
router.get("/companies/search", optionalAuth, organizationController.searchOrganizations);

router.get("/organizations/:slug", optionalAuth, organizationController.getOrganization);
router.get("/companies/:slug", optionalAuth, organizationController.getOrganization);

// --- CREATION & ACCOUNT ---
router.post("/organizations", requireAuth, organizationActionLimiter, organizationController.createOrganization);
router.post("/companies", requireAuth, organizationActionLimiter, organizationController.createOrganization);

router.post("/organizations/invites/accept", requireAuth, membersController.acceptInvite);
router.post("/companies/invites/accept", requireAuth, membersController.acceptInvite);

// --- MEMBERSHIP ---
router.post("/organizations/:orgId/members/invite", requireAuth, requireOrgPermission("INVITE_MEMBERS"), organizationActionLimiter, membersController.inviteMember);
router.get("/organizations/:orgId/members", requireAuth, requireOrgPermission("VIEW_MEMBERS"), membersController.getMembers);
router.delete("/organizations/:orgId/members/:memberId", requireAuth, requireOrgPermission("REMOVE_MEMBERS"), membersController.removeMember);
router.post("/organizations/:orgId/leave", requireAuth, membersController.leaveOrganization);

// Legacy Member Aliases
router.post("/companies/:orgId/members/invite", requireAuth, requireOrgPermission("INVITE_MEMBERS"), organizationActionLimiter, membersController.inviteMember);
router.get("/companies/:orgId/members", requireAuth, requireOrgPermission("VIEW_MEMBERS"), membersController.getMembers);
router.delete("/companies/:orgId/members/:memberId", requireAuth, requireOrgPermission("REMOVE_MEMBERS"), membersController.removeMember);
router.post("/companies/:orgId/leave", requireAuth, membersController.leaveOrganization);

// --- INSTITUTION ENROLLMENT ---
router.post("/organizations/:orgId/enroll", requireAuth, institutionController.requestEnrollment);
router.get("/organizations/:orgId/enrollments/pending", requireAuth, requireOrgPermission("MANAGE_MEMBERS"), institutionController.getPendingEnrollments);
router.patch("/organizations/:orgId/enrollments/:id", requireAuth, requireOrgPermission("MANAGE_MEMBERS"), institutionController.reviewEnrollment);

router.post("/companies/:orgId/enroll", requireAuth, institutionController.requestEnrollment);

// --- VERIFICATION ---
router.post("/organizations/:orgId/verify/domain", requireAuth, requireOrgPermission("MANAGE_SETTINGS"), otpGenerationLimiter, verifyController.verifyDomain);
router.post("/organizations/:orgId/verify/edu-email", requireAuth, requireOrgPermission("MANAGE_VERIFICATION"), verifyController.verifyByEduEmail);
router.post("/organizations/:orgId/verify/document", requireAuth, requireOrgPermission("MANAGE_VERIFICATION"), verifyController.submitDocumentVerification);

router.post("/companies/:orgId/verify/domain", requireAuth, requireOrgPermission("MANAGE_SETTINGS"), otpGenerationLimiter, verifyController.verifyDomain);

// --- MANAGEMENT ---
router.post("/organizations/:orgId/transfer-ownership", requireAuth, organizationActionLimiter, membersController.transferOwnership);
router.put("/organizations/:orgId", requireAuth, requireOrgPermission("MANAGE_COMPANY_DETAILS"), organizationController.updateOrganization);
router.delete("/organizations/:orgId", requireAuth, requireOrgPermission("MANAGE_COMPANY"), organizationActionLimiter, organizationController.deleteOrganization);

router.put("/companies/:orgId", requireAuth, requireOrgPermission("MANAGE_COMPANY_DETAILS"), organizationController.updateOrganization);

// --- ADMIN ---
router.get("/admin/verifications/queue", requireAuth, requireRoles(["Admin"]), verifyController.getVerificationQueue);
router.put("/admin/verifications/:verificationId/review", requireAuth, requireRoles(["Admin"]), verifyController.reviewVerification);

// --- ANALYTICS ---
router.get("/organizations/:orgId/analytics/overview", requireAuth, requireOrgPermission("VIEW_ANALYTICS"), analyticsController.getOverview);
router.get("/organizations/:orgId/analytics/engagement", requireAuth, requireOrgPermission("VIEW_ANALYTICS"), analyticsController.getEngagement);
router.get("/organizations/:orgId/analytics/jobs", requireAuth, requireOrgPermission("VIEW_ANALYTICS"), analyticsController.getJobs);
router.get("/organizations/:orgId/audit-logs", requireAuth, requireOrgPermission("MANAGE_COMPANY"), analyticsController.getAuditLogs);

// --- SETTINGS (TECH STACK / GALLERY) ---
router.get("/organizations/:slug/tech-stack", optionalAuth, settingsController.getTechStack);
router.post("/organizations/:orgId/tech-stack", requireAuth, requireOrgPermission("MANAGE_COMPANY_DETAILS"), settingsController.addTechStack);
router.delete("/organizations/:orgId/tech-stack/:stackId", requireAuth, requireOrgPermission("MANAGE_COMPANY_DETAILS"), settingsController.removeTechStack);

router.get("/organizations/:slug/gallery", optionalAuth, settingsController.getGallery);
router.post("/organizations/:orgId/gallery", requireAuth, requireOrgPermission("MANAGE_COMPANY_DETAILS"), settingsController.addToGallery);
router.delete("/organizations/:orgId/gallery/:galleryId", requireAuth, requireOrgPermission("MANAGE_COMPANY_DETAILS"), settingsController.removeFromGallery);

// --- ADVOCACY & POSTS ---
router.post("/organizations/:orgId/posts/:postId/notify", requireAuth, requireOrgPermission("MANAGE_COMPANY"), postsController.notifyEmployees);
router.get("/organizations/:orgId/posts", optionalAuth, postsController.getOrganizationPosts);
router.get("/companies/:orgId/posts", optionalAuth, postsController.getOrganizationPosts);

// --- JOBS ---
router.get("/organizations/:orgId/jobs", optionalAuth, organizationJobsController.getOrganizationJobs);
router.post("/organizations/:orgId/jobs", requireAuth, requireOrgPermission("POST_JOBS"), organizationJobsController.createOrganizationJob);
router.put("/organizations/:orgId/jobs/:jobId", requireAuth, requireOrgPermission("POST_JOBS"), organizationJobsController.updateOrganizationJob);
router.delete("/organizations/:orgId/jobs/:jobId", requireAuth, requireOrgPermission("POST_JOBS"), organizationJobsController.deleteOrganizationJob);

router.get("/companies/:orgId/jobs", optionalAuth, organizationJobsController.getOrganizationJobs);

// --- ROLES & PERMISSIONS ---
router.get("/organizations/:orgId/roles", requireAuth, roleController.getOrganizationRoles);
router.post("/organizations/:orgId/roles", requireAuth, requireOrgPermission("MANAGE_ROLES"), roleController.createOrganizationRole);
router.put("/organizations/:orgId/roles/:roleId", requireAuth, requireOrgPermission("MANAGE_ROLES"), roleController.updateOrganizationRole);
router.delete("/organizations/:orgId/roles/:roleId", requireAuth, requireOrgPermission("MANAGE_ROLES"), roleController.deleteOrganizationRole);

router.put("/organizations/:orgId/members/:userId/role", requireAuth, requireOrgPermission("MANAGE_MEMBERS"), roleController.assignRoleToMember);
router.put("/organizations/:orgId/my-role-settings", requireAuth, roleController.updateMemberRoleSettings);

// --- ASSETS ---
router.post("/organizations/:orgId/logo", requireAuth, requireOrgPermission("MANAGE_SETTINGS"), uploadAvatar.single("avatar"), settingsController.uploadLogo);
router.delete("/organizations/:orgId/logo", requireAuth, requireOrgPermission("MANAGE_SETTINGS"), settingsController.deleteLogo);
router.post("/organizations/:orgId/cover", requireAuth, requireOrgPermission("MANAGE_SETTINGS"), uploadCover.single("cover"), settingsController.uploadCover);
router.delete("/organizations/:orgId/cover", requireAuth, requireOrgPermission("MANAGE_SETTINGS"), settingsController.deleteCover);

// --- NOTIFICATIONS ---
router.get("/organizations/:orgId/notification-preferences", requireAuth, settingsController.getNotificationPreferences);
router.put("/organizations/:orgId/notification-preferences", requireAuth, settingsController.updateNotificationPreferences);

// --- HIERARCHY ---
// Public: list sub-organizations of an org
router.get("/organizations/:orgId/children", optionalAuth, hierarchyController.getOrganizationChildren);

// Child org sends a request to associate under a parent
router.post("/organizations/:orgId/parent-request", requireAuth, hierarchyController.sendParentRequest);

// Parent org admin views pending requests from potential children
router.get("/organizations/:orgId/parent-requests", requireAuth, requireOrgPermission("MANAGE_MEMBERS"), hierarchyController.getPendingParentRequests);

// Parent org admin approves or rejects a request
router.patch("/organizations/:orgId/parent-requests/:requestId", requireAuth, requireOrgPermission("MANAGE_MEMBERS"), hierarchyController.respondToParentRequest);

// Child org owner removes the parent association
router.delete("/organizations/:orgId/parent", requireAuth, hierarchyController.removeParent);

module.exports = router;
