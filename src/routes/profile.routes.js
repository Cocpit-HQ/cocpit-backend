const express = require("express");
const router = express.Router();
const profileController = require("../controllers/profile.controller");
const { requireAuth } = require("../middlewares/auth.middleware");

// ================= PROFILE ROUTES =================

// Get current logged-in user's profile
// Uses req.user.sub from JWT
router.get("/profile/me", requireAuth, profileController.getMyProfile);

// Get any user's profile by id OR "me"
router.get("/profile/:id", requireAuth, profileController.getProfile);

// Update logged-in user's profile
router.put("/profile", requireAuth, profileController.updateProfile);

// ================= EXPERIENCE ROUTES =================

// Add experience to logged-in user's profile
router.post("/profile/experiences", requireAuth, profileController.addExperience);

// Update experience by experience_id (only own profile)
router.put("/profile/experiences/:id", requireAuth, profileController.updateExperience);


// Delete experience by experience_id (only own profile)
router.delete("/profile/experiences/:id", requireAuth, profileController.deleteExperience);

// ================= EDUCATION ROUTES =================

// Add education
router.post("/profile/educations", requireAuth, profileController.addEducation);

// Update education by education_id (only own profile)
router.put("/profile/educations/:id", requireAuth, profileController.updateEducation);

// Delete education by education_id
router.delete("/profile/educations/:id", requireAuth, profileController.deleteEducation);

// ================= SKILL ROUTES =================

// Add skill
router.post("/profile/skills", requireAuth, profileController.addSkill);

// Update skill by skill_id
router.put("/profile/skills/:id", requireAuth, profileController.updateSkill);

// Delete skill mapping (user_skills)
router.delete("/profile/skills/:id", requireAuth, profileController.deleteSkill);




module.exports = router;
