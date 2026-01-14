const express = require("express");
const router = express.Router();
const onboardingController = require("../controllers/onboarding.controller");
const { requireAuth } = require("../middlewares/auth.middleware");
const { validate } = require("../middlewares/validation.middleware");
const { checkAccountNameSchema, completeOnboardingSchema } = require("../schemas/onboarding.schema");
const { uploadAvatar } = require("../middlewares/upload");

router.get(
  "/check-account-name",
  requireAuth,
  validate(checkAccountNameSchema),
  onboardingController.checkAccountName
);

router.post(
  "/complete",
  requireAuth,
  uploadAvatar.single("avatar"),
  validate(completeOnboardingSchema),
  onboardingController.completeOnboarding
);

module.exports = router;
