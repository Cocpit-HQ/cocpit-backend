const express = require("express");
const router = express.Router();
const onboardingController = require("./onboarding.controller");
const { requireAuth } = require("../../core/middlewares/auth.middleware");
const { validate } = require("../../core/middlewares/validation.middleware");
const { checkAccountNameSchema, completeOnboardingSchema } = require("./onboarding.schema");
const { uploadAvatar } = require("../../core/middlewares/upload.middleware");

router.get(
    "/check-account-name",
    requireAuth,
    validate(checkAccountNameSchema),
    onboardingController.checkAccountName
);

router.post(
    "/complete",
    requireAuth,
    uploadAvatar.any(),
    validate(completeOnboardingSchema),
    onboardingController.completeOnboarding
);

module.exports = router;
