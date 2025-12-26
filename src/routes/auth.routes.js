const express = require("express");
const router = express.Router();
const authController = require("../controllers/auth.controller");
const { requireAuth } = require("../middlewares/auth.middleware");
const { requireRoles } = require("../middlewares/role.middleware");
const { validate } = require("../middlewares/validation.middleware");
const rateLimit = require("../middlewares/rateLimit.middleware");
const {
  registerSchema,
  loginSchema,
  refreshTokenSchema,
} = require("../schemas/auth.schema");

// Rate limiters
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts per window for sensitive auth operations
  message: "Too many login/register attempts, please try again later."
});

router.post("/register", authLimiter, validate(registerSchema), authController.register);
router.post("/login", authLimiter, validate(loginSchema), authController.login);
router.post("/refresh", validate(refreshTokenSchema), authController.refreshToken);

router.get("/me", requireAuth, authController.getMe);

router.get("/admin", requireAuth, requireRoles(['Admin']), async (req, res) => {
  res.json({ message: "Welcome Admin!" });
});

module.exports = router;