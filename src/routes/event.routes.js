const express = require("express");
const router = express.Router();
const eventController = require("../controllers/event.controller");
const { requireAuth, optionalAuth } = require("../middlewares/auth.middleware");
const { uploadEventBanner } = require("../middlewares/upload");

router.get("/me/events/created", requireAuth, eventController.getMyCreatedEvents);
router.get("/me/events/registered", requireAuth, eventController.getMyRegisteredEvents);
router.get("/me/events/saved", requireAuth, eventController.getMySavedEvents);

router.get("/:id/registration-status", requireAuth, eventController.checkRegistrationStatus);
router.post("/:id/register", requireAuth, eventController.registerForEvent);
router.delete("/:id/register", requireAuth, eventController.unregisterFromEvent);
router.post("/:id/save", requireAuth, eventController.saveEvent);
router.delete("/:id/save", requireAuth, eventController.unsaveEvent);

router.get("/:id", optionalAuth, eventController.getEventById);

router.get("/", optionalAuth, eventController.getEvents);
router.post("/", requireAuth, uploadEventBanner.single('banner'), eventController.createEvent);

module.exports = router;
