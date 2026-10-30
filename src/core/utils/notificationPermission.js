const pool = require("../db/pool");

const POST_NOTIFICATION_TYPES = [
    "post", "like", "comment", "reply", "mention", 
    "post_tag", "repost", "share", "channel_article", 
    "organization_post", "story_comment", "story_like"
];

/**
 * Checks if a notification of a specific type is allowed for a user
 * based on user_notification_preferences.
 * 
 * @param {string} userId 
 * @param {string} notificationType 
 * @returns {Promise<boolean>}
 */
const isNotificationAllowed = async (userId, notificationType = "post") => {
    if (!userId) return false;
    try {
        const res = await pool.query(
            "SELECT all_notifications, post_notifications, job_alerts, message_notifications FROM user_notification_preferences WHERE user_id = $1",
            [userId]
        );
        if (res.rowCount === 0) return true;

        const pref = res.rows[0];
        if (pref.all_notifications === false) return false;

        const type = (notificationType || "post").toLowerCase();

        if (POST_NOTIFICATION_TYPES.includes(type) && pref.post_notifications === false) {
            return false;
        }
        
        const isJobAlert = type === "job" || 
                           type.includes("application") || 
                           type.includes("offer");
        if (isJobAlert && pref.job_alerts === false) {
            return false;
        }
        
        if (type === "message" && pref.message_notifications === false) {
            return false;
        }

        return true;
    } catch (err) {
        console.error("Error checking notification preferences:", err);
        return true;
    }
};

/**
 * Checks if a notification of a specific type is allowed for an organization
 * based on organization_notification_settings.
 * 
 * @param {string} orgId 
 * @param {string} notificationType 
 * @returns {Promise<boolean>}
 */
const isOrgNotificationAllowed = async (orgId, notificationType = "post") => {
    if (!orgId) return false;
    try {
        const res = await pool.query(
            "SELECT posts_enabled, jobs_enabled, events_enabled, messages_enabled, messages_chat_enabled, messages_jobs_enabled FROM organization_notification_settings WHERE org_id = $1",
            [orgId]
        );
        if (res.rowCount === 0) return true;

        const pref = res.rows[0];
        const type = (notificationType || "post").toLowerCase();

        if (POST_NOTIFICATION_TYPES.includes(type) && pref.posts_enabled === false) {
            return false;
        }
        
        const isJobAlert = type === "job" || 
                           type.includes("application") || 
                           type.includes("offer");
        if (isJobAlert && pref.jobs_enabled === false) {
            return false;
        }

        if (type === "event" && pref.events_enabled === false) {
            return false;
        }
        
        if (type === "message" && pref.messages_enabled === false) {
            return false;
        }

        return true;
    } catch (err) {
        console.error("Error checking org notification settings:", err);
        return true;
    }
};

module.exports = {
    isNotificationAllowed,
    isOrgNotificationAllowed,
    POST_NOTIFICATION_TYPES
};
