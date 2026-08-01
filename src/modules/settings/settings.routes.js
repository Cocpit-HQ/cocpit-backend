const express = require("express");
const router = express.Router();

const accountController = require("./account.controller");
const preferencesController = require("./preferences.controller");
const supportController = require("./support.controller");

const { requireAuth, requireActiveSession } = require("../../core/middlewares/auth.middleware");
const { validate } = require("../../core/middlewares/validation.middleware");
const { createRateLimit } = require("../../core/middlewares/rateLimit.middleware");
const { uploadSupportAttachment } = require("../../core/middlewares/upload.middleware");

const {
    changePasswordSchema,
    verifyCurrentEmailSchema,
    submitNewEmailSchema,
    confirmNewEmailSchema,
    setRecoveryEmailSchema,
    confirmRecoveryEmailSchema,
    phoneSchema,
    confirmPhoneSchema,
    appearanceSchema,
    notificationPreferencesSchema,
    privacySchema,
    initiateDeletionSchema,
    supportTicketSchema,
    userFeedbackSchema,
} = require("./settings.schema");

// Rate limiters
const sensitiveActionLimiter = createRateLimit({
    windowMs: 15 * 60 * 1000,
    max: process.env.NODE_ENV === "production" ? 10 : 100,
    message: "Too many requests. Please try again later.",
});

// ─── 1. Account Settings ───────────────────────────────────────────────────────

// Password Change
router.post("/account/password/change", requireAuth, requireActiveSession, sensitiveActionLimiter, validate(changePasswordSchema), accountController.changePassword);

// Primary Email Change (4-Step OTP Flow)
router.post("/account/email/verify-current", requireAuth, sensitiveActionLimiter, accountController.verifyCurrentEmail);
router.post("/account/email/verify-current/confirm", requireAuth, sensitiveActionLimiter, validate(verifyCurrentEmailSchema), accountController.confirmCurrentEmail);
router.post("/account/email/change", requireAuth, sensitiveActionLimiter, validate(submitNewEmailSchema), accountController.submitNewEmail);
router.post("/account/email/change/confirm", requireAuth, sensitiveActionLimiter, validate(confirmNewEmailSchema), accountController.confirmNewEmail);

// Recovery Email
router.post("/account/email/recovery", requireAuth, sensitiveActionLimiter, validate(setRecoveryEmailSchema), accountController.setRecoveryEmail);
router.post("/account/email/recovery/confirm", requireAuth, sensitiveActionLimiter, validate(confirmRecoveryEmailSchema), accountController.confirmRecoveryEmail);
router.delete("/account/email/recovery", requireAuth, accountController.deleteRecoveryEmail);

// Mobile Phone Number
router.post("/account/phone", requireAuth, sensitiveActionLimiter, validate(phoneSchema), accountController.setPhone);
router.post("/account/phone/confirm", requireAuth, sensitiveActionLimiter, validate(confirmPhoneSchema), accountController.confirmPhone);
router.put("/account/phone", requireAuth, sensitiveActionLimiter, validate(phoneSchema), accountController.setPhone);

// Session Management (Logout & Delegated Session Routes)
router.post("/account/logout", requireAuth, accountController.logoutCurrentSession);
const sessionController = require("../auth/session.controller");
router.get("/account/sessions", requireAuth, sessionController.getSessions);
router.delete("/account/sessions/others", requireAuth, requireActiveSession, sessionController.logoutAllOtherSessions);
router.delete("/account/sessions/:sessionId", requireAuth, requireActiveSession, sessionController.removeSession);

// Deletion Context & Initiation
router.get("/account/deletion/context", requireAuth, accountController.getDeletionContext);
router.post("/account/deletion", requireAuth, requireActiveSession, validate(initiateDeletionSchema), accountController.initiateAccountDeletion);

// ─── 2. Preferences (Appearance, Notifications, Privacy) ──────────────────────

router.get("/appearance", requireAuth, preferencesController.getAppearance);
router.put("/appearance", requireAuth, validate(appearanceSchema), preferencesController.updateAppearance);

router.get("/notifications", requireAuth, preferencesController.getNotificationPreferences);
router.put("/notifications", requireAuth, validate(notificationPreferencesSchema), preferencesController.updateNotificationPreferences);

router.get("/privacy", requireAuth, preferencesController.getPrivacySettings);
router.put("/privacy", requireAuth, validate(privacySchema), preferencesController.updatePrivacySettings);

// ─── 3. Reports History (Reporter-side) ───────────────────────────────────────

router.get("/reports", requireAuth, supportController.getMyReports);
router.get("/reports/:reportId", requireAuth, supportController.getMyReportById);

// ─── 4. Support, Feedback, FAQs, Legal ────────────────────────────────────────

router.get("/support/version", supportController.getVersion);
router.get("/support/faqs", supportController.getFaqs);
router.post("/support/tickets", requireAuth, uploadSupportAttachment ? uploadSupportAttachment.single("attachment") : (req, res, next) => next(), validate(supportTicketSchema), supportController.createTicket);
router.post("/support/feedback", requireAuth, validate(userFeedbackSchema), supportController.submitFeedback);
router.get("/legal", supportController.getLegalDocs);

module.exports = router;
