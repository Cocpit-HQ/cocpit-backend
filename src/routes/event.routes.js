const express = require("express");
const router = express.Router();
const eventController = require("../controllers/event.controller");
const { requireAuth } = require("../middlewares/auth.middleware");

router.get("/:id/registration-status", requireAuth, eventController.checkRegistrationStatus); // Registration status
router.post("/:id/register", requireAuth, eventController.registerForEvent); // Register event
router.delete("/:id/register", requireAuth, eventController.unregisterFromEvent); // Unregister event
router.get("/me/events/registered", requireAuth, eventController.getMyRegisteredEvents); // My registered events
router.get("/me/events/created", requireAuth, eventController.getMyCreatedEvents); // My created events

router.get("/", requireAuth, eventController.getEvents); // All events
router.get("/:id", requireAuth, eventController.getEventById); // Event details
router.post("/", requireAuth, eventController.createEvent); // Create event
module.exports = router;

