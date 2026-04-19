/**
 * Device Routes
 * Mounting internal device management endpoints.
 */
const express = require("express");
const router = express.Router();
const deviceController = require("./device.controller");
const { requireAuth } = require("../../core/middlewares/auth.middleware");

// All device management requires a valid platform session
router.use(requireAuth);

/**
 * @route   POST /api/device/register
 * @desc    Registers an Android/iOS/Web device with its FCM token.
 *          Maps the device to the active User+Session.
 */
router.post("/register", deviceController.registerDevice);

/**
 * @route   DELETE /api/device/:deviceId
 * @desc    Unregisters a device (soft-delete).
 */
router.delete("/:deviceId", deviceController.unregisterDevice);

module.exports = router;
