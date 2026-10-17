const authRepo = require("../auth/auth.repository");
const redisClient = require("../../core/db/redis");
const socketService = require("../../core/infrastructure/socket.service");

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes

/**
 * Revokes all sessions for a user EXCEPT the specified current session.
 * Invalidates refresh tokens in DB, sets Redis revocation keys, and disconnects sockets.
 */
exports.revokeOtherSessions = async (userId, currentSessionId) => {
    try {
        const deletedSessions = await authRepo.deleteAllOtherSessions(userId, currentSessionId);

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
        return deletedSessions.length;
    } catch (error) {
        console.error("Revoke other sessions error:", error);
        throw error;
    }
};
