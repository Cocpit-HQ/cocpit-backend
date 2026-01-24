const express = require("express");
const router = express.Router();
const profileController = require("../controllers/profile.controller");
const { requireAuth } = require("../middlewares/auth.middleware");
const { uploadResume, uploadAvatar, uploadCover } = require("../middlewares/upload");


router.get("/profile/me", requireAuth, profileController.getMyProfile);
router.put("/profile/me", requireAuth, profileController.updateProfile);

router.post("/profile/avatar", requireAuth, uploadAvatar.single("avatar"), profileController.uploadOrReplaceAvatar);
router.get("/profile/avatar", requireAuth, profileController.getAvatar);
router.delete("/profile/avatar", requireAuth, profileController.deleteAvatar);

// --- Cover Photo Routes ---
router.post("/profile/cover", requireAuth, uploadCover.single("cover"), profileController.uploadOrReplaceCoverPhoto);
router.delete("/profile/cover", requireAuth, profileController.deleteCoverPhoto);

router.get("/profile/identity", requireAuth, profileController.getIdentity);
router.put("/profile/identity", requireAuth, profileController.updateIdentity);

// --- Resume Routes ---
router.post("/profile/resume", requireAuth, uploadResume.single("resume"), profileController.uploadOrReplaceResume);
router.get("/profile/resume", requireAuth, profileController.getResume);
router.delete("/profile/resume", requireAuth, profileController.deleteResume);


router.get("/profile/:id", requireAuth, profileController.getProfile);

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
