const express = require("express");
const router = express.Router();
const userController = require("../controllers/user.controller");
const { requireAuth } = require("../middlewares/auth.middleware");

/**
 * @swagger
 * tags:
 *   name: User
 *   description: User profile management
 */

// Profile routes
/**
 * @swagger
 * /api/profile/{id}:
 *   get:
 *     summary: Get user profile
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: User ID or 'me'
 *     responses:
 *       200:
 *         description: User profile data
 */
router.get("/profile/:id", requireAuth, userController.getProfile); // :id can be 'me' or uuid

/**
 * @swagger
 * /api/profile:
 *   put:
 *     summary: Update user profile
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Profile updated
 */
router.put("/profile", requireAuth, userController.updateProfile);

// Experience routes
/**
 * @swagger
 * /api/profile/experiences:
 *   post:
 *     summary: Add experience to profile
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Experience added
 */
router.post("/profile/experiences", requireAuth, userController.addExperience);

// Education routes
/**
 * @swagger
 * /api/profile/educations:
 *   post:
 *     summary: Add education to profile
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Education added
 */
router.post("/profile/educations", requireAuth, userController.addEducation);

// Skill routes
/**
 * @swagger
 * /api/profile/skills:
 *   post:
 *     summary: Add skill to profile
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Skill added
 */
router.post("/profile/skills", requireAuth, userController.addSkill);

module.exports = router;
