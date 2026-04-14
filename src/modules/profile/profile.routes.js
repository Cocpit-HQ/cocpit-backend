const express = require("express");
const router = express.Router();
const profileController = require("./profile.controller");
const { requireAuth, requireActiveSession } = require("../../core/middlewares/auth.middleware");
const { uploadResume, uploadAvatar, uploadCover } = require("../../core/middlewares/upload.middleware");

// Profile
router.get("/me", requireAuth, profileController.getMyProfile);
router.put("/me", requireAuth, requireActiveSession, profileController.updateProfile);
router.get("/:id", requireAuth, profileController.getProfile);

// Avatar
router.post("/avatar", requireAuth, requireActiveSession, uploadAvatar.single("avatar"), profileController.uploadOrReplaceAvatar);
router.get("/avatar", requireAuth, profileController.getAvatar);
router.delete("/avatar", requireAuth, requireActiveSession, profileController.deleteAvatar);

// Cover Photo
router.post("/cover", requireAuth, requireActiveSession, uploadCover.single("cover"), profileController.uploadOrReplaceCoverPhoto);
router.delete("/cover", requireAuth, requireActiveSession, profileController.deleteCoverPhoto);

// Identity
router.get("/identity", requireAuth, profileController.getIdentity);
router.put("/identity", requireAuth, requireActiveSession, profileController.updateIdentity);

// Resume
router.post("/resume", requireAuth, requireActiveSession, uploadResume.single("resume"), profileController.uploadOrReplaceResume);
router.get("/resume", requireAuth, profileController.getResume);
router.delete("/resume", requireAuth, requireActiveSession, profileController.deleteResume);

// Experiences
router.post("/experiences", requireAuth, requireActiveSession, profileController.addExperience);
router.put("/experiences/:id", requireAuth, requireActiveSession, profileController.updateExperience);
router.delete("/experiences/:id", requireAuth, requireActiveSession, profileController.deleteExperience);

// Educations
router.post("/educations", requireAuth, requireActiveSession, profileController.addEducation);
router.put("/educations/:id", requireAuth, requireActiveSession, profileController.updateEducation);
router.delete("/educations/:id", requireAuth, requireActiveSession, profileController.deleteEducation);

// Skills
router.post("/skills", requireAuth, requireActiveSession, profileController.addSkills);
router.put("/skills/:id", requireAuth, requireActiveSession, profileController.updateSkill);
router.delete("/skills/:id", requireAuth, requireActiveSession, profileController.deleteSkill);

module.exports = router;
