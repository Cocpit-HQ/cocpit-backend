/**
 * Notification Service
 * Orchestrates sending push notifications via Firebase Admin SDK.
 * Includes automatic token pruning based on delivery feedback.
 */
const admin = require("../../config/firebase.config");
const deviceRepo = require("../device/device.repository");
const pool = require("../../core/db/pool");

const isNotificationAllowed = async (userId, notificationType = "post") => {
    try {
        const res = await pool.query(
            "SELECT all_notifications, post_notifications, job_alerts, message_notifications FROM user_notification_preferences WHERE user_id = $1",
            [userId]
        );
        if (res.rowCount === 0) return true;

        const pref = res.rows[0];
        if (pref.all_notifications === false) return false;

        if (notificationType === "post" && pref.post_notifications === false) return false;
        if (notificationType === "job" && pref.job_alerts === false) return false;
        if (notificationType === "message" && pref.message_notifications === false) return false;

        return true;
    } catch (err) {
        console.error("Error checking notification preferences:", err);
        return true;
    }
};

/**
 * Sends a push notification to all active devices of a user.
 * 
 * @param {string} userId - Target user ID.
 * @param {string} title - Notification title.
 * @param {string} body - Notification body text.
 * @param {Object} data - Optional metadata payload.
 */
const sendToUser = async (userId, title, body, data = {}) => {
    // 0. Check recipient notification preferences
    const allowed = await isNotificationAllowed(userId, data.type || "post");
    if (!allowed) {
        console.info(`[Notification] Skipped sending to ${userId}: User disabled ${data.type || "all"} notifications.`);
        return;
    }

    // 1. Check if Firebase is initialized
    if (!admin.apps.length) {
        console.warn(`[Notification] Skipped sending to ${userId}: Firebase not initialized.`);
        return;
    }

    // 2. Fetch active FCM tokens for this user
    const tokens = await deviceRepo.getActiveTokensByUserId(userId);
    
    if (!tokens || tokens.length === 0) {
        console.info(`[Notification] No active devices found for user ${userId}.`);
        return;
    }

    // 3. Prepare the multicast message
    const message = {
        notification: {
            title,
            body,
        },
        data: {
            ...data,
            click_action: "FLUTTER_NOTIFICATION_CLICK", // Or platform specific key
        },
        tokens: tokens, // Array of strings
    };

    try {
        // 4. Send multicast message
        const response = await admin.messaging().sendEachForMulticast(message);
        
        console.log(`[Notification] Successfully sent to ${response.successCount} devices for user ${userId}.`);

        // 5. Cleanup failed tokens (Security & Cleanliness)
        if (response.failureCount > 0) {
            const tokensToRemove = [];
            response.responses.forEach((resp, idx) => {
                if (!resp.success) {
                    const error = resp.error;
                    // Prune only if the token is explicitly invalid or not registered
                    if (error.code === 'messaging/registration-token-not-registered' || 
                        error.code === 'messaging/invalid-registration-token') {
                        tokensToRemove.push(tokens[idx]);
                    }
                }
            });

            if (tokensToRemove.length > 0) {
                console.log(`[Notification] Pruning ${tokensToRemove.length} invalid tokens for user ${userId}.`);
                await Promise.all(tokensToRemove.map(token => deviceRepo.deleteDeviceByToken(token)));
            }
        }
    } catch (err) {
        console.error(`[Notification] Critical error sending multicast to user ${userId}:`, err.message);
    }
};

module.exports = {
    sendToUser,
};
