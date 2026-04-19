const express = require("express");
const router = express.Router();

const onboardingController = require("./onboarding.controller");
const { requireAuth } = require("../../core/middlewares/auth.middleware");
const { validate } = require("../../core/middlewares/validation.middleware");

const {
    saveRoleSchema,
    saveDetailsSchema,
    saveInterestsSchema,
    saveSkillsSchema,
    updateProfileSchema,
    updateLocationSchema
} = require("./onboarding.schema");

// Multi-step onboarding routes
router.get("/check-account-name", requireAuth, onboardingController.checkAccountName);
router.patch("/role", requireAuth, validate(saveRoleSchema), onboardingController.saveRole);
router.patch("/interests", requireAuth, validate(saveInterestsSchema), onboardingController.saveInterests);
router.patch("/skills", requireAuth, validate(saveSkillsSchema), onboardingController.saveSkills);
router.patch("/profile", requireAuth, validate(updateProfileSchema), onboardingController.updateProfile);
router.patch("/location", requireAuth, validate(updateLocationSchema), onboardingController.updateLocation);
router.post("/complete", requireAuth, onboardingController.completeOnboarding);

router.patch("/details", requireAuth, validate(saveDetailsSchema), onboardingController.saveDetails);

module.exports = router;
