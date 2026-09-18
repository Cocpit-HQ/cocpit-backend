const express = require("express");
const router = express.Router();
const organizationController = require("./organization.controller");
const membersController = require("./organization.members.controller");
const verifyController = require("./organization.verification.controller");
const postsController = require("./organization.posts.controller");
const settingsController = require("./organization.settings.controller");
const organizationJobsController = require("./organization.jobs.controller");
const analyticsController = require("./organization.analytics.controller");
const { requireAuth, optionalAuth } = require("../../core/middlewares/auth.middleware");
const { requireOrgPermission } = require("../../core/middlewares/organization.auth.middleware");
const { organizationActionLimiter, otpGenerationLimiter } = require("../../core/middlewares/rateLimit.middleware");
const { uploadAvatar, uploadCover, uploadChatMedia, uploadSupportAttachment } = require("../../core/middlewares/upload.middleware");
const { requireRoles } = require("../../core/middlewares/role.middleware");
const { validate } = require("../../core/middlewares/validation.middleware");
const {
    createTypeSchema,
    saveIdentitySchema,
    savePresenceSchema,
    verifyEmailSendSchema,
    verifyEmailConfirmSchema,
    verifyPhoneSendSchema,
    verifyPhoneConfirmSchema,
    saveVerificationSchema
} = require("./organization.validation");
const institutionController = require("./institution.controller");
const hierarchyController = require("./organization.hierarchy.controller");
const teamsCtrl = require("./organization.teams.controller");

// --- COMPANY ONBOARDING WIZARD ---
router.get("/organizations/countries", requireAuth, organizationController.getCountriesList);
router.post("/organizations/type", requireAuth, validate(createTypeSchema), organizationController.createDraftType);
router.get("/organizations/:orgId/progress", requireAuth, organizationController.getOnboardingProgress);
router.get("/organizations/:orgId/preview", requireAuth, organizationController.getProfilePreview);
router.put("/organizations/:orgId/identity", requireAuth, uploadAvatar.single("logo"), validate(saveIdentitySchema), organizationController.saveDraftIdentity);
router.put("/organizations/:orgId/presence", requireAuth, validate(savePresenceSchema), organizationController.saveDraftPresence);
router.post("/organizations/verify-email/send", requireAuth, validate(verifyEmailSendSchema), organizationController.sendEmailOTP);
router.post("/organizations/verify-email/confirm", requireAuth, validate(verifyEmailConfirmSchema), organizationController.confirmEmailOTP);
router.post("/organizations/verify-phone/send", requireAuth, validate(verifyPhoneSendSchema), organizationController.sendPhoneOTP);
router.post("/organizations/verify-phone/confirm", requireAuth, validate(verifyPhoneConfirmSchema), organizationController.confirmPhoneOTP);
router.put("/organizations/:orgId/verification", requireAuth, uploadChatMedia.array("documents", 10), validate(saveVerificationSchema), organizationController.saveDraftVerification);
router.post("/organizations/:orgId/complete", requireAuth, organizationController.completeOnboardingFlow);

router.post(
    "/organizations/publish-new",
    requireAuth,
    organizationActionLimiter,
    uploadChatMedia.fields([{ name: "logo", maxCount: 1 }, { name: "documents", maxCount: 10 }]),
    organizationController.publishNewOrganization
);

// --- PUBLIC & SHARED ---
router.get("/organizations/check-slug", optionalAuth, organizationController.checkSlug);
router.get("/companies/check-slug", optionalAuth, organizationController.checkSlug);

router.get("/organizations/mine", requireAuth, organizationController.getUserOrganizations);
router.get("/companies/mine", requireAuth, organizationController.getUserOrganizations);

router.get("/organizations/owned", requireAuth, organizationController.getOwnedOrganizations);

router.post("/organizations/:orgId/transfer-ownership", requireAuth, teamsCtrl.transferOwnership);

router.get("/organizations/search", optionalAuth, organizationController.searchOrganizations);
router.get("/companies/search", optionalAuth, organizationController.searchOrganizations);

router.get("/organizations/:slug", optionalAuth, organizationController.getOrganization);
router.get("/companies/:slug", optionalAuth, organizationController.getOrganization);

// --- CREATION & ACCOUNT ---
router.post("/organizations", requireAuth, organizationActionLimiter, organizationController.createOrganization);
router.post("/companies", requireAuth, organizationActionLimiter, organizationController.createOrganization);

router.post("/organizations/teams/invites/accept", requireAuth, membersController.acceptTeamsInvite);
router.get("/organizations/teams/invites/pending", requireAuth, membersController.getUserPendingTeamsInvites);
router.post("/organizations/teams/invites/batch-decline", requireAuth, membersController.batchDeclineTeamInvites);
router.post("/organizations/teams/invites/decline", requireAuth, membersController.declineTeamsInvite);

// --- MEMBERSHIP ---
router.post("/organizations/:orgId/leave", requireAuth, membersController.leaveOrganization);
router.delete("/organizations/:orgId/leave", requireAuth, membersController.leaveOrganization);

// Legacy Member Aliases
router.post("/companies/:orgId/leave", requireAuth, membersController.leaveOrganization);
router.delete("/companies/:orgId/leave", requireAuth, membersController.leaveOrganization);

// --- CONTEXT SWITCH ---
router.post("/organizations/:orgId/switch-context", requireAuth, async (req, res, next) => {
    const actorContextService = require("../auth/actorContext.service");
    try {
        const result = await actorContextService.setActorContext(req.user.sub, { type: "ORGANIZATION", id: req.params.orgId });
        if (result.cookieValue) {
            res.cookie(
                actorContextService.ACTOR_CONTEXT_COOKIE_NAME,
                result.cookieValue,
                actorContextService.ACTOR_CONTEXT_COOKIE_OPTIONS
            );
        }
        return res.json({
            success: true,
            data: result
        });
    } catch (err) {
        next(err);
    }
});

// --- ACCOUNT SETTINGS & LIFECYCLE ---
router.post("/organizations/:orgId/deactivate/send-otp", requireAuth, otpGenerationLimiter, settingsController.sendDeactivateOrgOTP);
router.post("/organizations/:orgId/deactivate/validate-otp", requireAuth, organizationActionLimiter, settingsController.validateDeactivateOrgOTP);
router.patch("/organizations/:orgId/deactivate", requireAuth, settingsController.deactivateOrganization);
router.patch("/organizations/:orgId/reactivate", requireAuth, settingsController.reactivateOrganization);

router.post("/organizations/:orgId/reactivate/send-otp", requireAuth, otpGenerationLimiter, settingsController.sendReactivateOrgOTP);
router.post("/organizations/:orgId/reactivate/verify-otp", requireAuth, organizationActionLimiter, settingsController.reactivateOrganization);
router.post("/organizations/:orgId/reactivate", requireAuth, settingsController.reactivateOrganization);

router.post("/organizations/:orgId/recover/send-otp", requireAuth, otpGenerationLimiter, organizationController.sendRecoverOrgOTP);
router.post("/organizations/:orgId/recover/verify-otp", requireAuth, organizationActionLimiter, organizationController.verifyOTPAndRecoverOrganization);
router.post("/organizations/:orgId/recover", requireAuth, organizationController.verifyOTPAndRecoverOrganization);


// --- INSTITUTION ENROLLMENT ---
router.post("/organizations/:orgId/enroll", requireAuth, institutionController.requestEnrollment);
router.get("/organizations/:orgId/enrollments/pending", requireAuth, requireOrgPermission("MANAGE_MEMBERS"), institutionController.getPendingEnrollments);
router.patch("/organizations/:orgId/enrollments/:id", requireAuth, requireOrgPermission("MANAGE_MEMBERS"), institutionController.reviewEnrollment);

router.post("/companies/:orgId/enroll", requireAuth, institutionController.requestEnrollment);

// --- VERIFICATION ---
router.post("/organizations/:orgId/verify/domain", requireAuth, requireOrgPermission("MANAGE_SETTINGS"), otpGenerationLimiter, verifyController.verifyDomain);
router.post("/organizations/:orgId/verify/edu-email", requireAuth, requireOrgPermission("MANAGE_SETTINGS"), verifyController.verifyByEduEmail);
router.post("/organizations/:orgId/verify/document", requireAuth, requireOrgPermission("MANAGE_SETTINGS"), uploadSupportAttachment ? uploadSupportAttachment.fields([{ name: 'document', maxCount: 5 }]) : (req, res, next) => next(), verifyController.submitDocumentVerification);

router.post("/companies/:orgId/verify/domain", requireAuth, requireOrgPermission("MANAGE_SETTINGS"), otpGenerationLimiter, verifyController.verifyDomain);

// --- MANAGEMENT ---
router.put("/organizations/:orgId", requireAuth, requireOrgPermission("MANAGE_COMPANY_DETAILS"), organizationController.updateOrganization);

// Organization Action Routes
router.post("/organizations/restore", organizationController.restoreOrganization);

router.post("/organizations/:orgId/delete/send-otp", requireAuth, requireOrgPermission("MANAGE_COMPANY"), otpGenerationLimiter, organizationController.sendDeleteOrgOTP);
router.post("/organizations/:orgId/delete/validate-otp", requireAuth, requireOrgPermission("MANAGE_COMPANY"), organizationActionLimiter, organizationController.validateOTPForOrganizationDeletion);
router.post("/organizations/:orgId/delete/verify-otp", requireAuth, requireOrgPermission("MANAGE_COMPANY"), organizationActionLimiter, organizationController.verifyOTPAndDeleteOrganization);

router.delete("/organizations/:orgId", requireAuth, requireOrgPermission("MANAGE_COMPANY"), organizationActionLimiter, organizationController.deleteOrganization);

router.put("/companies/:orgId", requireAuth, requireOrgPermission("MANAGE_COMPANY_DETAILS"), organizationController.updateOrganization);

// --- ADMIN ---
router.get("/admin/verifications/queue", requireAuth, requireRoles(["Admin"]), verifyController.getVerificationQueue);
router.put("/admin/verifications/:verificationId/review", requireAuth, requireRoles(["Admin"]), verifyController.reviewVerification);

// --- ANALYTICS ---
router.get("/organizations/:orgId/analytics/overview", requireAuth, requireOrgPermission("VIEW_ANALYTICS"), analyticsController.getOverview);
router.get("/organizations/:orgId/analytics/engagement", requireAuth, requireOrgPermission("VIEW_ANALYTICS"), analyticsController.getEngagement);
router.get("/organizations/:orgId/analytics/jobs", requireAuth, requireOrgPermission("VIEW_ANALYTICS"), analyticsController.getJobs);

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
router.put("/organizations/:orgId/my-role-settings", requireAuth, membersController.updateMemberRoleSettings);

// --- ASSETS ---
router.post("/organizations/:orgId/logo", requireAuth, requireOrgPermission("MANAGE_SETTINGS"), uploadAvatar.single("avatar"), settingsController.uploadLogo);
router.delete("/organizations/:orgId/logo", requireAuth, requireOrgPermission("MANAGE_SETTINGS"), settingsController.deleteLogo);
router.post("/organizations/:orgId/cover", requireAuth, requireOrgPermission("MANAGE_SETTINGS"), uploadCover.single("cover"), settingsController.uploadCover);
router.delete("/organizations/:orgId/cover", requireAuth, requireOrgPermission("MANAGE_SETTINGS"), settingsController.deleteCover);

// --- ACCOUNT SETTINGS & LIFECYCLE ---
router.get("/organizations/:orgId/account-settings", requireAuth, requireOrgPermission("MANAGE_SETTINGS"), settingsController.getAccountSettings);
router.patch("/organizations/:orgId/deactivate", requireAuth, settingsController.deactivateOrganization);
router.patch("/organizations/:orgId/reactivate", requireAuth, settingsController.reactivateOrganization);

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
