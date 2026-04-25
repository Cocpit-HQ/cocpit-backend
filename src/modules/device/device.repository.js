/**
 * Device Repository
 * Handles all database operations related to device sessions and FCM tokens.
 */
const pool = require("../../core/db/pool");

/**
 * Registers or updates a device session.
 * Uses an upsert-like logic to ensure (device_id, session_id) uniqueness.
 */
const upsertDeviceSession = async ({ userId, sessionId, deviceId, fcmToken, platform }) => {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // 1. Upsert the new device registration
        const query = `
            INSERT INTO device_sessions (device_id, user_id, session_id, fcm_token, device_type, is_active)
            VALUES ($1, $2, $3, $4, $5, TRUE)
            ON CONFLICT (user_id, device_id) 
            DO UPDATE SET 
                session_id = EXCLUDED.session_id,
                fcm_token = EXCLUDED.fcm_token,
                is_active = TRUE
            RETURNING device_id;
        `;
        const params = [deviceId, userId, sessionId, fcmToken, platform];
        const result = await client.query(query, params);

        // 2. Enforce max 5 devices limit (delete older devices if exceeding limit)
        // Cleanup happens after insert, keeping the top 5 most recently active devices
        await client.query(
            `DELETE FROM device_sessions
             WHERE user_id = $1 AND device_id NOT IN (
                 SELECT device_id FROM device_sessions
                 WHERE user_id = $1 
                 ORDER BY last_active_at DESC 
                 LIMIT 5
             )`,
            [userId]
        );

        await client.query("COMMIT");
        return result.rows[0];
    } catch (err) {
        await client.query("ROLLBACK");
        throw err;
    } finally {
        client.release();
    }
};

/**
 * Soft-deletes a device session by setting it to inactive.
 */
const deactivateDevice = async (userId, deviceId) => {
    const query = `
        UPDATE device_sessions 
        SET is_active = FALSE, updated_at = NOW()
        WHERE user_id = $1 AND device_id = $2;
    `;
    const result = await pool.query(query, [userId, deviceId]);
    return result.rowCount > 0;
};

/**
 * Hard-deletes a device session (e.g., when token is permanently invalid).
 */
const deleteDeviceByToken = async (fcmToken) => {
    const query = `DELETE FROM device_sessions WHERE fcm_token = $1`;
    await pool.query(query, [fcmToken]);
};

/**
 * Retrieves all active FCM tokens for a specific user.
 */
const getActiveTokensByUserId = async (userId) => {
    const query = `
        SELECT fcm_token 
        FROM device_sessions 
        WHERE user_id = $1 AND is_active = TRUE AND fcm_token IS NOT NULL;
    `;
    const result = await pool.query(query, [userId]);
    return result.rows.map(r => r.fcm_token);
};

/**
 * Validates if a session belongs to a specific user.
 */
const validateSessionOwner = async (userId, sessionId) => {
    const query = `SELECT 1 FROM refresh_tokens WHERE user_id = $1 AND session_id = $2 AND expires_at > NOW()`;
    const result = await pool.query(query, [userId, sessionId]);
    return result.rowCount > 0;
};

module.exports = {
    upsertDeviceSession,
    deactivateDevice,
    deleteDeviceByToken,
    getActiveTokensByUserId,
    validateSessionOwner
};
