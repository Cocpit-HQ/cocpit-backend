/**
 * Session Controller (Thin)
 * Handles session listing, removal, and bulk logout.
 */
const UAParser = require("ua-parser-js");
const authService = require("./auth.service");
const authRepo = require("./auth.repository");
const redisClient = require("../../core/db/redis");
const socketService = require("../../core/infrastructure/socket.service");

// Must match the expiresIn value in core/utils/jwt.js → signAccessToken
const ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes

// ─── Get Sessions ──────────────────────────────────────────────────────────────

exports.getSessions = async (req, res) => {
    try {
        const userId = req.user.sub;
        const currentSessionId = req.user.sid;

        const rows = await authRepo.getDetailedSessions(userId);

        const sessions = rows.map(row => {
            const parser = new UAParser(row.user_agent);
            const ua = parser.getResult();

            const browser = ua.browser.name || (row.user_agent.includes("axios") ? "Axios Client" : (row.user_agent.includes("node") ? "Node.js" : "Unknown Browser"));
            const os = ua.os.name || "Unknown OS";
            let deviceType = "Unknown";

            if (ua.device.type === "mobile") {
                deviceType = "Mobile";
            } else if (ua.device.type === "tablet") {
                deviceType = "Tablet";
            } else if (!ua.device.type) {
                if (browser === "Axios Client" || browser === "Node.js" || row.user_agent.includes("Postman")) {
                    deviceType = "Service/API";
                } else {
                    deviceType = "Desktop";
                }
            }

            return {
                session_id: row.session_id,
                browser,
                os,
                device_type: deviceType,
                user_agent: row.user_agent,
                ip_address: row.ip_address,
                created_at: row.created_at,
                expires_at: row.expires_at,
                is_current: row.session_id === currentSessionId,
            };
        });

        res.json({ sessions });
    } catch (error) {
        console.error("Get sessions error:", error);
        res.status(500).json({ message: "Unable to fetch active sessions" });
    }
};

// ─── Get Session Count ─────────────────────────────────────────────────────────

exports.getMySessionCount = async (req, res) => {
    try {
        const userId = req.user.sub;
        const count = await authRepo.getSessionCount(userId);
        res.json({ my_session_count: count });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Unable to fetch your session count" });
    }
};

// ─── Logout All Other Sessions ─────────────────────────────────────────────────

exports.logoutAllOtherSessions = async (req, res) => {
    try {
        const userId = req.user.sub;
        const currentSessionId = req.user.sid;
        const { password } = req.body;

        if (!password) {
            return res.status(400).json({ message: "Password is required" });
        }

        const isValid = await authService.verifyPasswordForAction(userId, password);
        if (!isValid) {
            return res.status(401).json({ message: "Invalid password" });
        }

        const deletedSessions = await authRepo.deleteAllOtherSessions(userId, currentSessionId);

        // Immediately invalidate access tokens and disconnect sockets for all removed sessions
        if (deletedSessions.length > 0) {
            await Promise.allSettled(
                deletedSessions.map(async (sessionId) => {
                    if (redisClient.isOpen) {
                        await redisClient.setEx(
                            `revoked_session:${sessionId}`,
                            ACCESS_TOKEN_TTL_SECONDS,
                            "1"
                        );
                    }
                    await socketService.disconnectUserSession(userId, sessionId);
                })
            );
        }

        res.json({
            message: "All other sessions terminated",
            deleted_count: deletedSessions.length,
        });
    } catch (error) {
        console.error("Logout all other sessions error:", error);
        res.status(500).json({ message: "Unable to terminate other sessions" });
    }
};

// ─── Remove Session ────────────────────────────────────────────────────────────

exports.removeSession = async (req, res) => {
    try {
        const userId = req.user.sub;
        const { sessionId } = req.params;
        const { password } = req.body;

        if (!sessionId) {
            return res.status(400).json({ message: "sessionId is required" });
        }

        if (!password) {
            return res.status(400).json({ message: "Password is required" });
        }

        const isValid = await authService.verifyPasswordForAction(userId, password);
        if (!isValid) {
            return res.status(401).json({ message: "Invalid password" });
        }

        const result = await authRepo.deleteSessionForUser(userId, sessionId);

        if (result.rowCount === 0) {
            return res.status(404).json({ message: "Session not found" });
        }

        // Immediately blacklist the session's access token so the device
        // cannot continue making API calls until the token naturally expires.
        // TTL matches ACCESS_TOKEN_TTL_SECONDS so the key self-cleans.
        if (redisClient.isOpen) {
            await redisClient.setEx(
                `revoked_session:${sessionId}`,
                ACCESS_TOKEN_TTL_SECONDS,
                "1"
            );
        }

        // Disconnect the device's active socket connection immediately.
        // Non-blocking — failure here does not affect the HTTP response.
        socketService.disconnectUserSession(userId, sessionId).catch((err) =>
            console.error("[Session] Socket disconnect failed for session:", sessionId, err)
        );

        return res.json({
            message: "Session removed successfully",
            removedSession: result.rows[0].session_id,
        });
    } catch (err) {
        console.error("Remove session error:", err);
        res.status(500).json({ message: "Failed to remove session" });
    }
};
