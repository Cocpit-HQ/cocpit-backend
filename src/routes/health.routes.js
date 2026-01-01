const express = require("express");
const router = express.Router();
const healthController = require("../controllers/health.controller");

/**
 * @swagger
 * tags:
 *   name: Health
 *   description: Health check endpoint
 */

/**
 * @swagger
 * /api/health:
 *   get:
 *     summary: Check API status
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: API is up and running
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: UP
 *                 uptime:
 *                   type: string
 *                   example: 2h 14m 30s
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 */
router.get("/", healthController.getHealth);

module.exports = router;
