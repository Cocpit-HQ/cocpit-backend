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
    completeOnboardingSchema,
} = require("./onboarding.schema");

// Multi-step onboarding routes
router.patch("/role", requireAuth, validate(saveRoleSchema), onboardingController.saveRole);
router.patch("/details", requireAuth, validate(saveDetailsSchema), onboardingController.saveDetails);
router.patch("/interests", requireAuth, validate(saveInterestsSchema), onboardingController.saveInterests);
router.patch("/skills", requireAuth, validate(saveSkillsSchema), onboardingController.saveSkills);
router.post("/complete", requireAuth, validate(completeOnboardingSchema), onboardingController.completeOnboarding);

module.exports = router;
