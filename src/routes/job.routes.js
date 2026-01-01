const express = require("express");
const router = express.Router();
const jobController = require("../controllers/job.controller");
const { requireAuth } = require("../middlewares/auth.middleware");
const { requireRoles } = require("../middlewares/role.middleware");

/**
 * @swagger
 * tags:
 *   name: Jobs
 *   description: Job management and applications
 */

// Public routes (or authenticated but open to all)
/**
 * @swagger
 * /api/jobs:
 *   get:
 *     summary: Get all jobs
 *     tags: [Jobs]
 *     responses:
 *       200:
 *         description: List of jobs
 */
router.get("/", jobController.getAllJobs); // /api/jobs

/**
 * @swagger
 * /api/jobs/{id}:
 *   get:
 *     summary: Get job by ID
 *     tags: [Jobs]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Job details
 */
router.get("/:id", jobController.getJobById);

// Protected routes
/**
 * @swagger
 * /api/jobs:
 *   post:
 *     summary: Create a new job
 *     tags: [Jobs]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       201:
 *         description: Job created
 */
router.post("/", requireAuth, requireRoles(['Recruiter', 'Admin']), jobController.createJob);

/**
 * @swagger
 * /api/jobs/{id}/apply:
 *   post:
 *     summary: Apply for a job
 *     tags: [Jobs]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Application submitted
 */
router.post("/:id/apply", requireAuth, jobController.applyJob);

/**
 * @swagger
 * /api/jobs/applicationsme:
 *   get:
 *     summary: Get my job applications
 *     tags: [Jobs]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of applications
 */
router.get("/applicationsme", requireAuth, jobController.getMyApplications);

module.exports = router;
