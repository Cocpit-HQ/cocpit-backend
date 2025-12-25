const express = require("express");
const router = express.Router();
const authController = require("../controllers/auth.controller");
const { requireAuth } = require("../middlewares/auth.middleware");
const { requireRoles } = require("../middlewares/role.middleware");
const { validate } = require("../middlewares/validation.middleware");
const {
  registerSchema,
  loginSchema,
  refreshTokenSchema,
} = require("../schemas/auth.schema");

router.post("/register", validate(registerSchema), authController.register);
router.post("/login", validate(loginSchema), authController.login);
router.post("/refresh", validate(refreshTokenSchema), authController.refreshToken);

router.get("/me", requireAuth, async (req, res) => {
  res.json({ user: req.user });
});

router.get("/admin", requireAuth, requireRoles(['Admin']), async (req, res) => {
  res.json({ message: "Welcome Admin!" });
});

module.exports = router;