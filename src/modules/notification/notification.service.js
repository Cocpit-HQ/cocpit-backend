/**
 * Notification Service
 * Orchestrates sending push notifications via Firebase Admin SDK.
 * Includes automatic token pruning based on delivery feedback.
 */
const admin = require("../../config/firebase.config");
const deviceRepo = require("../device/device.repository");
const pool = require("../../core/db/pool");
const socketService = require("../../core/infrastructure/socket.service");
const { sendDocumentVerifiedEmail, sendDocumentRejectedEmail, sendOrgDocumentVerifiedEmail, sendOrgDocumentRejectedEmail } = require("../../core/services/email.service");

const isNotificationAllowed = async (userId, notificationType = "post") => {
    try {
        const res = await pool.query(
            "SELECT all_notifications, post_notifications, job_alerts, message_notifications FROM user_notification_preferences WHERE user_id = $1",
            [userId]
        );
        if (res.rowCount === 0) return true;

        const pref = res.rows[0];
        if (pref.all_notifications === false) return false;

        if (["post", "like", "comment", "reply", "mention"].includes(notificationType) && pref.post_notifications === false) return false;
        
        const isJobAlert = notificationType === "job" || 
                           notificationType.includes("application") || 
                           notificationType.includes("offer");
        if (isJobAlert && pref.job_alerts === false) return false;
        
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
    // FCM requires all data payload values to be strings — coerce and filter nulls
    const safeData = Object.fromEntries(
        Object.entries({ ...data, click_action: "FLUTTER_NOTIFICATION_CLICK" })
              .filter(([, v]) => v != null)
              .map(([k, v]) => [k, String(v)])
    );
    const message = {
        notification: {
            title,
            body,
        },
        data: safeData,
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

/**
 * Sends a silent push notification (data-only, no alert/sound).
 */
const sendSilentPushToUser = async (userId, data = {}) => {
    const allowed = await isNotificationAllowed(userId, data.type || "post");
    if (!allowed) return;

    if (!admin.apps.length) return;

    const tokens = await deviceRepo.getActiveTokensByUserId(userId);
    if (!tokens || tokens.length === 0) return;

    const safeData = Object.fromEntries(
        Object.entries(data)
              .filter(([, v]) => v != null)
              .map(([k, v]) => [k, String(v)])
    );

    const message = {
        data: safeData,
        tokens: tokens,
    };

    try {
        const response = await admin.messaging().sendEachForMulticast(message);
        if (response.failureCount > 0) {
            const tokensToRemove = [];
            response.responses.forEach((resp, idx) => {
                if (!resp.success) {
                    const error = resp.error;
                    if (error.code === 'messaging/registration-token-not-registered' || 
                        error.code === 'messaging/invalid-registration-token') {
                        tokensToRemove.push(tokens[idx]);
                    }
                }
            });

            if (tokensToRemove.length > 0) {
                await Promise.all(tokensToRemove.map(token => deviceRepo.deleteDeviceByToken(token)));
            }
        }
    } catch (err) {
        console.error(`[Notification] Critical error sending silent push to user ${userId}:`, err.message);
    }
};

/**
 * Dispatches all required notifications when a document is verified.
 */
const notifyDocumentVerified = async (userId) => {
    const type = "doc_verification_success";
    const title = "Document verification completed";
    const timestamp = new Date().toISOString();

    try {
        const userRes = await pool.query("SELECT email, full_name, account_name FROM active_users WHERE user_id = $1", [userId]);
        if (userRes.rowCount === 0) return;
        const { email, full_name, account_name } = userRes.rows[0];

        const username = account_name || full_name || "user";
        const message = `Congratulations ${username}, we have successfully reviewed and verified your documents. Your profile is now verified.`;

        // 1. Insert into notifications DB (system notification, sender_id is null)
        await pool.query(
            `INSERT INTO notifications (user_id, sender_id, type, text, metadata)
             VALUES ($1, $2, $3, $4, $5)`,
            [userId, null, type, message, JSON.stringify({ title })]
        );

        // 2. Socket Notification
        socketService.notifyUser(userId, "notification", { type, title, message, timestamp });

        // 3. Email Notification
        sendDocumentVerifiedEmail(email, full_name).catch(err => console.error("Email err:", err));
    } catch (err) {
        console.error("Failed to notify doc verified:", err);
    }
};

/**
 * Dispatches all required notifications when a document is rejected.
 */
const notifyDocumentRejected = async (userId, reason) => {
    const type = "doc_verification_rejected";
    const title = "Document verification unsuccessful";
    const message = `We couldn't verify your documents. Please review and resubmit. Reason: ${reason}.`;
    const timestamp = new Date().toISOString();

    try {
        const userRes = await pool.query("SELECT email, full_name FROM active_users WHERE user_id = $1", [userId]);
        if (userRes.rowCount === 0) return;
        const { email, full_name } = userRes.rows[0];

        // 1. Insert into notifications DB
        await pool.query(
            `INSERT INTO notifications (user_id, sender_id, type, text, metadata)
             VALUES ($1, $2, $3, $4, $5)`,
            [userId, userId, type, message, JSON.stringify({ title, reason })]
        );

        // 2. Socket Notification
        socketService.notifyUser(userId, "notification", { type, title, message, timestamp });

        // 3. Email Notification
        sendDocumentRejectedEmail(email, full_name, reason).catch(err => console.error("Email err:", err));
    } catch (err) {
        console.error("Failed to notify doc rejected:", err);
    }
};

/**
 * Dispatches notifications when an organization's documents are verified.
 */
const notifyOrgDocumentVerified = async (orgId) => {
    const type = "org_doc_verification_success";
    const title = "Document verification completed";
    const message = "Your company documents have been reviewed and verified successfully. You now have full access to Cocpit's hiring tools.";
    const timestamp = new Date().toISOString();

    try {
        const orgRes = await pool.query(
            "SELECT created_by, name FROM organizations WHERE org_id = $1", 
            [orgId]
        );
        if (orgRes.rowCount === 0) return;
        const { created_by: owner_id, name } = orgRes.rows[0];

        const userRes = await pool.query("SELECT email FROM active_users WHERE user_id = $1", [owner_id]);
        if (userRes.rowCount === 0) return;
        const { email } = userRes.rows[0];

        // 1. Insert into notifications DB for the owner
        await pool.query(
            `INSERT INTO notifications (user_id, sender_id, type, text, metadata)
             VALUES ($1, $2, $3, $4, $5)`,
            [owner_id, owner_id, type, message, JSON.stringify({ title, orgId })]
        );

        // 2. Socket Notification (Silent/Toast)
        socketService.notifyUser(owner_id, "notification", { type, title, message, timestamp });

        // 3. Email Notification
        sendOrgDocumentVerifiedEmail(email, name).catch(err => console.error("Email err:", err));
    } catch (err) {
        console.error("Failed to notify org doc verified:", err);
    }
};

/**
 * Dispatches notifications when an organization's documents are rejected.
 */
const notifyOrgDocumentRejected = async (orgId, reason) => {
    const type = "org_doc_verification_rejected";
    const title = "Document verification unsuccessful";
    const message = `We couldn't verify your documents for {Company Name}. Please review and resubmit. Reason: ${reason}.`;
    const timestamp = new Date().toISOString();

    try {
        const orgRes = await pool.query(
            "SELECT created_by, name FROM organizations WHERE org_id = $1", 
            [orgId]
        );
        if (orgRes.rowCount === 0) return;
        const { created_by: owner_id, name } = orgRes.rows[0];

        const userRes = await pool.query("SELECT email FROM active_users WHERE user_id = $1", [owner_id]);
        if (userRes.rowCount === 0) return;
        const { email } = userRes.rows[0];

        // Replace template variable if present
        const finalMessage = message.replace("{Company Name}", name || "your company");

        // 1. Insert into notifications DB for the owner
        await pool.query(
            `INSERT INTO notifications (user_id, sender_id, type, text, metadata)
             VALUES ($1, $2, $3, $4, $5)`,
            [owner_id, owner_id, type, finalMessage, JSON.stringify({ title, reason, orgId })]
        );

        // 2. Socket Notification (Silent/Toast)
        socketService.notifyUser(owner_id, "notification", { type, title, message: finalMessage, timestamp });

        // 3. Email Notification
        sendOrgDocumentRejectedEmail(email, name, reason).catch(err => console.error("Email err:", err));
    } catch (err) {
        console.error("Failed to notify org doc rejected:", err);
    }
};

module.exports = {
    sendToUser,
    sendSilentPushToUser,
    notifyDocumentVerified,
    notifyDocumentRejected,
    notifyOrgDocumentVerified,
    notifyOrgDocumentRejected,
};
