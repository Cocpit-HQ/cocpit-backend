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
    updateLocationSchema,
    saveSituationSchema,
} = require("./onboarding.schema");
const { uploadAvatar, uploadResumeMemory } = require("../../core/middlewares/upload.middleware");
const { createRateLimit } = require("../../core/middlewares/rateLimit.middleware");

// Rate limiter for onboarding steps to prevent spamming
const onboardingLimiter = createRateLimit({
    windowMs: 15 * 60 * 1000,
    max: 50,
    message: "Too many onboarding attempts, please try again later."
});

// Apply rate limiting to all onboarding routes
router.use(onboardingLimiter);

const featureFlagsService = require("../config/featureFlags.service");
const blockIfOnboardingDisabled = (req, res, next) => {
    const flags = featureFlagsService.getFlags();
    if (flags["enableOnboardingModule"] === false) {
        return res.status(403).json({ message: "Onboarding is currently disabled." });
    }
    next();
};

router.use(blockIfOnboardingDisabled);

// Multi-step onboarding routes
router.get("/check-account-name", requireAuth, onboardingController.checkAccountName);
router.get("/options/:slug", requireAuth, onboardingController.getOnboardingOptions);
router.patch("/role", requireAuth, validate(saveRoleSchema), onboardingController.saveRole);
router.patch("/situation", requireAuth, validate(saveSituationSchema), onboardingController.saveSituation);

// Reference Data Routes (GET)
router.get("/interests", requireAuth, onboardingController.getInterests);
router.get("/skills", requireAuth, onboardingController.getSkills);
router.patch("/interests", requireAuth, validate(saveInterestsSchema), onboardingController.saveInterests);
router.patch("/skills", requireAuth, validate(saveSkillsSchema), onboardingController.saveSkills);
router.patch("/profile", requireAuth, uploadAvatar.single("avatar"), validate(updateProfileSchema), onboardingController.updateProfile);
router.patch("/location", requireAuth, validate(updateLocationSchema), onboardingController.updateLocation);
router.post("/complete", requireAuth, onboardingController.completeOnboarding);

router.patch("/details", requireAuth, validate(saveDetailsSchema), onboardingController.saveDetails);

// Resume parsing route
router.post("/resume/parse", requireAuth, uploadResumeMemory.single("resume"), onboardingController.parseResumeUpload);

module.exports = router;
