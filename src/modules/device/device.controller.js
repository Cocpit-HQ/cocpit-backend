/**
 * Device Controller
 * Handles HTTP requests for device registration and management.
 */
const deviceRepo = require("./device.repository");
const { z } = require("zod");

// Schema for device registration
const registerSchema = z.zod ? z : require("zod"); // Fallback for different zod versions
const deviceRegisterSchema = z.object({
    deviceId: z.string().min(1),
    fcmToken: z.string().optional(),
    platform: z.enum(["android", "ios", "web"]),
});

const registerDevice = async (req, res, next) => {
    try {
        const userId = req.user.sub;
        const sessionId = req.user.sid;

        // 1. Validate payload
        const validation = deviceRegisterSchema.safeParse(req.body);
        if (!validation.success) {
            return res.status(400).json({
                error: "Invalid payload",
                details: validation.error.format()
            });
        }

        const { deviceId, fcmToken, platform } = validation.data;

        // 2. Security Check: Validate session ownership
        // This ensures the device is linked to the session provided in the JWT
        const isValidSession = await deviceRepo.validateSessionOwner(userId, sessionId);
        if (!isValidSession) {
            return res.status(401).json({ error: "Invalid or expired session" });
        }

        // 3. Upsert device session
        await deviceRepo.upsertDeviceSession({
            userId,
            sessionId,
            deviceId,
            fcmToken: fcmToken || null,
            platform
        });

        res.status(200).json({ message: "Device registered successfully" });
    } catch (err) {
        next(err);
    }
};

const unregisterDevice = async (req, res, next) => {
    try {
        const userId = req.user.sub;
        const { deviceId } = req.params;

        if (!deviceId) {
            return res.status(400).json({ error: "deviceId is required" });
        }

        const success = await deviceRepo.deactivateDevice(userId, deviceId);

        if (!success) {
            return res.status(404).json({ error: "Device not found for this user" });
        }

        res.status(200).json({ message: "Device unregistered successfully" });
    } catch (err) {
        next(err);
    }
};

module.exports = {
    registerDevice,
    unregisterDevice,
};
