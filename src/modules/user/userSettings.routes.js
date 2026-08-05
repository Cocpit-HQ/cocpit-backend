const express = require("express");
const router = express.Router();
const userSettingsController = require("./userSettings.controller");
const { requireAuth } = require("../../core/middlewares/auth.middleware");

// Protect all /api/user/* settings routes
router.use(requireAuth);

// ─── 1. Account Settings ───────────────────────────────────────────────────────
router.get("/account", userSettingsController.getAccountDetails);
router.put("/email", userSettingsController.updateEmail);
router.delete("/email/recovery", userSettingsController.deleteRecoveryEmail);
router.put("/password", userSettingsController.updatePassword);
router.put("/phone", userSettingsController.updatePhone);
router.delete("/phone", userSettingsController.removePhone);
router.delete("/account", userSettingsController.deleteAccount);

// ─── 2. Activity Settings ───────────────────────────────────────────────────────
router.get("/activity", userSettingsController.getActivityLogs);
router.delete("/activity/:type/:id", userSettingsController.removeActivity);

// ─── 3. Privacy & Security Settings ───────────────────────────────────────────
router.get("/privacy", userSettingsController.getPrivacySettings);
router.put("/privacy", userSettingsController.updatePrivacySettings);
router.get("/sessions", userSettingsController.getActiveSessions);
router.delete("/sessions/others", userSettingsController.logoutOtherSessions);
router.delete("/sessions/:id", userSettingsController.logoutSession);

// ─── 4. Notification Settings ───────────────────────────────────────────────────
router.get("/notifications/preferences", userSettingsController.getNotificationPreferences);
router.put("/notifications/preferences", userSettingsController.updateNotificationPreferences);

// ─── 5. Blocked Accounts ───────────────────────────────────────────────────────
router.get("/blocked", userSettingsController.getBlockedUsers);
router.delete("/blocked/:id", userSettingsController.unblockUser);

// ─── 6. Reports ────────────────────────────────────────────────────────────────
router.get("/reports",     userSettingsController.getUserReports);
router.get("/reports/:id", userSettingsController.getUserReportById);

// ─── 7. Appearance Settings ─────────────────────────────────────────────────────
router.get("/appearance", userSettingsController.getAppearance);
router.put("/appearance", userSettingsController.updateAppearance);

// ─── 8. Account Actions (history — populated by admin panel in future) ──────────
router.get("/account-actions",     userSettingsController.getAccountActions);
router.get("/account-actions/:id", userSettingsController.getAccountActionById);


module.exports = router;
