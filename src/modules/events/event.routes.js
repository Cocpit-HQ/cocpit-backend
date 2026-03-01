const express = require("express");
const router = express.Router();
const eventController = require("./event.controller");
const { requireAuth, optionalAuth } = require("../../core/middlewares/auth.middleware");
const { uploadEventBanner } = require("../../core/middlewares/upload.middleware");

router.get("/me/events/created", requireAuth, eventController.getMyCreatedEvents);
router.get("/me/events/registered", requireAuth, eventController.getMyRegisteredEvents);
router.get("/me/events/saved", requireAuth, eventController.getMySavedEvents);

router.get("/:id/registration-status", requireAuth, eventController.checkRegistrationStatus);
router.post("/:id/register", requireAuth, eventController.registerForEvent);
router.delete("/:id/register", requireAuth, eventController.unregisterFromEvent);
router.post("/:id/save", requireAuth, eventController.saveEvent);
router.delete("/:id/save", requireAuth, eventController.unsaveEvent);

router.put("/:id", requireAuth, uploadEventBanner.single("banner"), eventController.updateEvent);
router.delete("/:id", requireAuth, eventController.deleteEvent);

router.get("/:id", optionalAuth, eventController.getEventById);

router.get("/", optionalAuth, eventController.getEvents);
router.post("/", requireAuth, uploadEventBanner.single("banner"), eventController.createEvent);

module.exports = router;
