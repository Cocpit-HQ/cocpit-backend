const express = require("express");
const router = express.Router();
const profileController = require("./profile.controller");
const { requireAuth, requireActiveSession } = require("../../core/middlewares/auth.middleware");
const { uploadResume, uploadAvatar, uploadCover } = require("../../core/middlewares/upload.middleware");

// Profile
router.get("/profile/me", requireAuth, profileController.getMyProfile);
router.put("/profile/me", requireAuth, requireActiveSession, profileController.updateProfile);
router.get("/profile/:id", requireAuth, profileController.getProfile);

// Avatar
router.post("/profile/avatar", requireAuth, requireActiveSession, uploadAvatar.single("avatar"), profileController.uploadOrReplaceAvatar);
router.get("/profile/avatar", requireAuth, profileController.getAvatar);
router.delete("/profile/avatar", requireAuth, requireActiveSession, profileController.deleteAvatar);

// Cover Photo
router.post("/profile/cover", requireAuth, requireActiveSession, uploadCover.single("cover"), profileController.uploadOrReplaceCoverPhoto);
router.delete("/profile/cover", requireAuth, requireActiveSession, profileController.deleteCoverPhoto);

// Identity
router.get("/profile/identity", requireAuth, profileController.getIdentity);
router.put("/profile/identity", requireAuth, requireActiveSession, profileController.updateIdentity);

// Resume
router.post("/profile/resume", requireAuth, requireActiveSession, uploadResume.single("resume"), profileController.uploadOrReplaceResume);
router.get("/profile/resume", requireAuth, profileController.getResume);
router.delete("/profile/resume", requireAuth, requireActiveSession, profileController.deleteResume);

// Experiences
router.post("/profile/experiences", requireAuth, requireActiveSession, profileController.addExperience);
router.put("/profile/experiences/:id", requireAuth, requireActiveSession, profileController.updateExperience);
router.delete("/profile/experiences/:id", requireAuth, requireActiveSession, profileController.deleteExperience);

// Educations
router.post("/profile/educations", requireAuth, requireActiveSession, profileController.addEducation);
router.put("/profile/educations/:id", requireAuth, requireActiveSession, profileController.updateEducation);
router.delete("/profile/educations/:id", requireAuth, requireActiveSession, profileController.deleteEducation);

// Skills
router.post("/profile/skills", requireAuth, requireActiveSession, profileController.addSkills);
router.put("/profile/skills/:id", requireAuth, requireActiveSession, profileController.updateSkill);
router.delete("/profile/skills/:id", requireAuth, requireActiveSession, profileController.deleteSkill);

module.exports = router;
