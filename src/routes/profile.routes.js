const express = require("express");
const router = express.Router();
const profileController = require("../controllers/profile.controller");
const { requireAuth } = require("../middlewares/auth.middleware");

router.get("/profile/me", requireAuth, profileController.getMyProfile);
router.get("/profile/identity", requireAuth, profileController.getIdentity);
router.put("/profile/identity", requireAuth, profileController.updateIdentity);

router.get("/profile/:id", requireAuth, profileController.getProfile);
router.put("/profile/me", requireAuth, profileController.updateProfile);

// ================= EXPERIENCE ROUTES =================

router.post("/profile/experiences", requireAuth, profileController.addExperience);
router.put("/profile/experiences/:id", requireAuth, profileController.updateExperience);
router.delete("/profile/experiences/:id", requireAuth, profileController.deleteExperience);

// ================= EDUCATION ROUTES =================

router.post("/profile/educations", requireAuth, profileController.addEducation);
router.put("/profile/educations/:id", requireAuth, profileController.updateEducation);
router.delete("/profile/educations/:id", requireAuth, profileController.deleteEducation);

// ================= SKILL ROUTES =================

router.post("/profile/skills", requireAuth, profileController.addSkills);
router.put("/profile/skills/:id", requireAuth, profileController.updateSkill);
router.delete("/profile/skills/:id", requireAuth, profileController.deleteSkill);

module.exports = router;
