const express = require("express");
const   router = express.Router();
const profileController = require("./profile.controller");
const { requireAuth, requireActiveSession } = require("../../core/middlewares/auth.middleware");
const { uploadResume, uploadAvatar, uploadCover, uploadProjectMedia } = require("../../core/middlewares/upload.middleware");

// Profile
router.get("/score", requireAuth, profileController.getProfileScore);
router.get("/me", requireAuth, profileController.getMyProfile);
router.put("/me", requireAuth, requireActiveSession, profileController.updateProfile);
router.get("/:id/score", requireAuth, profileController.getProfileScore);

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
router.post("/experiences/batch", requireAuth, requireActiveSession, profileController.batchUpdateExperiences);
router.patch("/experiences/:id", requireAuth, requireActiveSession, profileController.updateExperience);
router.put("/experiences/:id", requireAuth, requireActiveSession, profileController.updateExperience); // kept for web backward-compat during migration
router.delete("/experiences/:id", requireAuth, requireActiveSession, profileController.deleteExperience);

// Educations
router.post("/educations", requireAuth, requireActiveSession, profileController.addEducation);
router.put("/educations/:id", requireAuth, requireActiveSession, profileController.updateEducation);
router.delete("/educations/:id", requireAuth, requireActiveSession, profileController.deleteEducation);

// Skills
router.get("/skills", requireAuth, profileController.getSkills);
router.post("/skills", requireAuth, requireActiveSession, profileController.addSkills);
router.put("/skills/sync", requireAuth, requireActiveSession, profileController.syncSkills);
router.put("/skills/:id", requireAuth, requireActiveSession, profileController.updateSkill);
router.delete("/skills/:id", requireAuth, requireActiveSession, profileController.deleteSkill);

// Interests
router.get("/interests", requireAuth, profileController.getInterests);

// Reference Lists
router.get("/educations", requireAuth, profileController.getEducationList);
router.get("/companies", requireAuth, profileController.getCompanyList);

// Projects
router.post("/projects/media", requireAuth, requireActiveSession, uploadProjectMedia.single("file"), profileController.uploadProjectMediaFile);
router.post("/projects", requireAuth, requireActiveSession, profileController.addProject);
router.put("/projects/:id", requireAuth, requireActiveSession, profileController.updateProject);
router.patch("/projects/:id", requireAuth, requireActiveSession, profileController.updateProject);
router.delete("/projects/:id", requireAuth, requireActiveSession, profileController.deleteProject);

router.get("/:id/download-resume", requireAuth, profileController.downloadResume);
router.get("/:id", requireAuth, profileController.getProfile);

module.exports = router;
