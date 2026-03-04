/**
 * Company Notification Service
 * 
 * Central utility for dispatching preference-aware notifications
 * to company followers. Checks each follower's notification preferences
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
 * Send notifications to company followers who have the given category enabled.
 * 
 * @param {string} companyId - The company that produced the content
 * @param {string} category - One of: 'jobs', 'events', 'posts', 'announcements'
 * @param {object} notificationData - { type, text, referenceId, metadata }
 */
async function notifyCompanyFollowers(companyId, category, notificationData) {
    const column = CATEGORY_COLUMN_MAP[category];
    if (!column) {
        console.error(`notifyCompanyFollowers: Unknown category "${category}"`);
        return;
    }

    try {
        // 1. Get company info for notification text
        const companyRes = await pool.query(
            `SELECT name, logo_url, slug FROM companies WHERE company_id = $1`,
            [companyId]
        );
        if (companyRes.rowCount === 0) return;
        const company = companyRes.rows[0];

        // 2. Get opted-in followers (who have this category enabled)
        const followersRes = await pool.query(
            `SELECT cf.user_id
       FROM company_followers cf
       INNER JOIN company_notification_preferences cnp
         ON cf.user_id = cnp.user_id AND cf.company_id = cnp.company_id
       WHERE cf.company_id = $1 AND cnp.${column} = TRUE`,
            [companyId]
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
                null,                     // sender_id (company action, no individual sender)
                type,                     // type
                text,                     // text
                referenceId || null,      // reference_id
                JSON.stringify({ ...metadata, company_id: companyId }) // metadata
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
                is_company_actor: true,
                metadata: { ...metadata, company_id: companyId },
            });
        }

        console.log(
            `📢 Sent ${insertRes.rowCount} "${category}" notifications for company ${company.name}`
        );
    } catch (err) {
        console.error("notifyCompanyFollowers error:", err);
    }
}

module.exports = { notifyCompanyFollowers };
