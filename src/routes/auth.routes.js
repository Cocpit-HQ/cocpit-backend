const express = require("express");
const router = express.Router();
const authController = require("../controllers/auth.controller");
const { requireAuth, requireActiveSession } = require("../middlewares/auth.middleware");
const { requireRefreshTokenAuth } = require("../middlewares/auth.middleware");
const { requireRoles } = require("../middlewares/role.middleware");
const { validate } = require("../middlewares/validation.middleware");
const rateLimit = require("../middlewares/rateLimit.middleware");
const { getMySessionCount } = require("../controllers/auth.controller");
const {
  registerSchema,
  loginSchema,
  refreshTokenSchema,
} = require("../schemas/auth.schema");

// Rate limiters
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 15, // 5 attempts per window for sensitive auth operations
  message: "Too many login/register attempts, please try again later."
});

router.post("/register", authLimiter, validate(registerSchema), authController.register);
router.post("/login", authLimiter, validate(loginSchema), authController.login);
router.post("/refresh", validate(refreshTokenSchema), authController.refreshToken);
// Session management
router.get("/sessions", requireAuth, authController.getSessions);
router.delete("/sessions", requireAuth, requireActiveSession, authController.logoutAllOtherSessions);
router.get("/sessions/count", requireAuth, getMySessionCount);
router.delete("/sessions/:sessionId", requireAuth, requireActiveSession, authController.removeSession);


router.post("/logout", authController.logout);

router.get("/me", requireAuth, authController.getMe);

router.get("/admin", requireAuth, requireRoles(['Admin']), async (req, res) => {
  res.json({ message: "Welcome Admin!" }); //user
});

module.exports = router;