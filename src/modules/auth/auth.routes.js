const express = require("express");
const router = express.Router();

const authController = require("./auth.controller");
const sessionController = require("./session.controller");
const passwordResetController = require("./passwordReset.controller");
const otpRoutes = require("./otp.routes");

const { requireAuth, requireActiveSession } = require("../../core/middlewares/auth.middleware");
const { requireRoles } = require("../../core/middlewares/role.middleware");
const { validate } = require("../../core/middlewares/validation.middleware");
const { createRateLimit } = require("../../core/middlewares/rateLimit.middleware");

const {
    registerSchema,
    loginSchema,
    refreshTokenSchema,
    resetPasswordSchema,
} = require("./auth.schema");

// Rate limiters
const authLimiter = createRateLimit({
    windowMs: 15 * 60 * 1000,
    max: 15,
    message: "Too many login/register attempts, please try again later."
});

const passwordResetLimiter = createRateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: "Too many password reset attempts, please try again later."
});

// Auth
router.use("/", otpRoutes);
router.post("/register", authLimiter, validate(registerSchema), authController.register);
router.post("/login", authLimiter, validate(loginSchema), authController.login);
router.post("/google", authLimiter, authController.googleLogin);
router.post("/refresh", validate(refreshTokenSchema), authController.refreshToken);
router.post("/logout", authController.logout);
router.get("/me", requireAuth, authController.getMe);

// Sessions
router.get("/sessions", requireAuth, sessionController.getSessions);
router.delete("/sessions", requireAuth, requireActiveSession, sessionController.logoutAllOtherSessions);
router.get("/sessions/count", requireAuth, sessionController.getMySessionCount);
router.delete("/sessions/:sessionId", requireAuth, requireActiveSession, sessionController.removeSession);

// Password reset
router.post("/reset-password", passwordResetLimiter, validate(resetPasswordSchema), passwordResetController.resetPassword);

// Admin
router.get("/admin", requireAuth, requireRoles(['Admin']), async (req, res) => {
    res.json({ message: "Welcome Admin!" });
});

module.exports = router;
