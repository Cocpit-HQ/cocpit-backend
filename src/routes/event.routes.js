const express = require("express");
const router = express.Router();
const eventController = require("../controllers/event.controller");
const { requireAuth } = require("../middlewares/auth.middleware");

router.get("/", requireAuth, eventController.getEvents);
router.post("/", requireAuth, eventController.createEvent);
router.post("/:id/register", requireAuth, eventController.registerForEvent);

module.exports = router;
