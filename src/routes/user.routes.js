const express = require("express");
const router = express.Router();
const userController = require("../controllers/user.controller");
const { requireAuth } = require("../middlewares/auth.middleware");

// Profile routes
router.get("/profile/:id", requireAuth, userController.getProfile); // :id can be 'me' or uuid
router.put("/profile", requireAuth, userController.updateProfile);

// Experience routes
router.post("/profile/experiences", requireAuth, userController.addExperience);

// Education routes
router.post("/profile/educations", requireAuth, userController.addEducation);

// Skill routes
router.post("/profile/skills", requireAuth, userController.addSkill);

module.exports = router;
