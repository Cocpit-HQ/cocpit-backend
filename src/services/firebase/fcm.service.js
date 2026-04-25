const admin = require('firebase-admin');
const pool = require('../../core/db/pool');

// Attempt to load the service account. This allows the backend to start even if it's missing,
// but push notifications will fail cleanly.
let serviceAccount;
try {
    serviceAccount = require('../../config/firebase-service-account.json');
} catch (err) {
    console.warn("⚠️ [FCM] firebase-service-account.json not found in config/. Push notifications disabled.");
}

if (serviceAccount && !admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log("✅ [FCM] Firebase Admin SDK initialized successfully.");
}

/**
 * Sends a push notification to all active devices for a specific user.
 * It automatically prunes invalid tokens from the database.
 * 
 * @param {string} userId - The UUID of the user to notify.
 * @param {string} title - The notification title.
 * @param {string} body - The notification body.
 * @param {Object} dataPayload - Optional key-value payload for background processing.
 */
const sendPushNotification = async (userId, title, body, dataPayload = {}) => {
    if (!admin.apps.length) {
        console.warn("⚠️ [FCM] Cannot send notification. Firebase Admin not initialized.");
        return;
    }

    try {
        // 1. Get all active FCM tokens for the user
        const devicesRes = await pool.query(
            'SELECT fcm_token FROM device_sessions WHERE user_id = $1 AND is_active = true', 
            [userId]
        );
        
        const tokens = devicesRes.rows.map(row => row.fcm_token);

        if (tokens.length === 0) {
            return; // No active devices registered for this user
        }

        // 2. Build the multicast message
        const message = {
            notification: {
                title,
                body
            },
            data: dataPayload,
            tokens: tokens,
        };

        // 3. Dispatch via Firebase Admin
        const response = await admin.messaging().sendEachForMulticast(message);
        console.log(`[FCM] 📤 Push notification sent to user ${userId} (${response.successCount} successful, ${response.failureCount} failed)`);

        // 4. Cleanup invalid tokens returned by FCM
        const failedTokens = [];
        response.responses.forEach((resp, idx) => {
            if (!resp.success) {
                const error = resp.error;
                // These errors indicate the token is permanently dead (app uninstalled, etc.)
                if (error.code === 'messaging/invalid-registration-token' ||
                    error.code === 'messaging/registration-token-not-registered') {
                    failedTokens.push(tokens[idx]);
                }
            }
        });

        // Delete the dead tokens from our database to prevent future failed attempts
        if (failedTokens.length > 0) {
            await pool.query(
                'DELETE FROM device_sessions WHERE fcm_token = ANY($1)', 
                [failedTokens]
            );
            console.log(`🧹 [FCM] Pruned ${failedTokens.length} dead tokens for user ${userId}`);
        }

    } catch (err) {
        console.error("❌ [FCM] Error sending push notification:", err);
    }
};

module.exports = {
    sendPushNotification
};
