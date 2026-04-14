const pool = require("../core/db/pool");

/**
 * Log user activity into the new MVP intent table (user_activities).
 * 
 * @param {Object} params
 * @param {number} params.userId - INT ID of the user.
 * @param {string} params.action - String action strictly mapped to MVP Intents (e.g., 'apply_job').
 * @param {Object} [params.metadata={}] - Optional JSON metadata.
 */
const logActivity = async ({ userId, action, metadata = {} }) => {
    if (!userId || !action) return;

    try {
        await pool.query(
            `INSERT INTO user_activities (user_id, action, metadata)
             VALUES ($1, $2, $3)`,
            [userId, action, JSON.stringify(metadata)]
        );
    } catch (err) {
        console.error(`[ActivityLogger] Failed to log action '${action}' for user ${userId}:`, err);
    }
};

module.exports = {
    logActivity
};
