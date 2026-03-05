/**
 * Organization Notification Service
 * 
 * Central utility for dispatching preference-aware notifications
 * to organization followers. Checks each follower's notification preferences
 * before creating DB entries and emitting real-time events.
 */

const pool = require("../core/db/pool");
const socketService = require("../core/infrastructure/socket.service");

// Map notification types to preference columns
const CATEGORY_COLUMN_MAP = {
    jobs: "jobs_enabled",
    events: "events_enabled",
    posts: "posts_enabled",
};

/**
 * Send notifications to organization followers who have the given category enabled.
 * 
 * @param {string} orgId - The organization that produced the content
 * @param {string} category - One of: 'jobs', 'events', 'posts', 'announcements'
 * @param {object} notificationData - { type, text, referenceId, metadata }
 */
async function notifyOrgFollowers(orgId, category, notificationData) {
    const column = CATEGORY_COLUMN_MAP[category];
    if (!column) {
        console.error(`notifyOrgFollowers: Unknown category "${category}"`);
        return;
    }

    try {
        // 1. Get organization info for notification text
        const companyRes = await pool.query(
            `SELECT name, logo_url, slug FROM organizations WHERE org_id = $1`,
            [orgId]
        );
        if (companyRes.rowCount === 0) return;
        const company = companyRes.rows[0];

        // 2. Get opted-in followers (who have this category enabled)
        const followersRes = await pool.query(
            `SELECT cf.user_id
       FROM organization_followers cf
       INNER JOIN organization_notification_preferences cnp
         ON cf.user_id = cnp.user_id AND cf.org_id = cnp.org_id
       WHERE cf.org_id = $1 AND cnp.${column} = TRUE`,
            [orgId]
        );

        if (followersRes.rowCount === 0) return;

        const { type, text, referenceId, metadata = {} } = notificationData;

        // 3. Bulk insert notifications for all opted-in followers
        const values = [];
        const placeholders = [];
        let paramIdx = 1;

        for (const row of followersRes.rows) {
            placeholders.push(
                `($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3}, $${paramIdx + 4}, $${paramIdx + 5})`
            );
            values.push(
                row.user_id,             // user_id (recipient)
                null,                     // sender_id (organization action, no individual sender)
                type,                     // type
                text,                     // text
                referenceId || null,      // reference_id
                JSON.stringify({ ...metadata, org_id: orgId }) // metadata
            );
            paramIdx += 6;
        }

        const insertQuery = `
      INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata)
      VALUES ${placeholders.join(", ")}
      RETURNING notification_id, user_id
    `;

        const insertRes = await pool.query(insertQuery, values);

        // 4. Emit real-time notifications to each opted-in user
        for (const row of insertRes.rows) {
            socketService.notifyUser(row.user_id, "notification", {
                notification_id: row.notification_id,
                type,
                text,
                reference_id: referenceId || null,
                is_read: false,
                created_at: new Date().toISOString(),
                actor_name: company.name,
                actor_avatar: company.logo_url,
                actor_slug: company.slug,
                is_organization_actor: true,
                metadata: { ...metadata, org_id: orgId },
            });
        }

        console.log(
            `📢 Sent ${insertRes.rowCount} "${category}" notifications for organization ${company.name}`
        );
    } catch (err) {
        console.error("notifyOrgFollowers error:", err);
    }
}

module.exports = { notifyOrgFollowers };
