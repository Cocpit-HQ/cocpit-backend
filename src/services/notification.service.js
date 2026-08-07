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
       WHERE cf.org_id = $1 AND cnp.${column} = TRUE
         AND NOT EXISTS (
           SELECT 1 FROM organization_blocked_accounts oba
           WHERE oba.org_id = $1 AND oba.blocked_id = cf.user_id
         )`,
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

/**
 * Send a broadcast notification to all members of all child organizations.
 * 
 * @param {string} parentOrgId - The parent organization sending the broadcast
 * @param {string} postId - The broadcasted post ID
 * @param {string} postContent - Summary of the post content
 */
async function notifyBroadcastToChildOrgs(parentOrgId, postId, postContent) {
    try {
        // 1. Get info about the parent organization
        const parentRes = await pool.query(
            `SELECT name, logo_url, slug FROM organizations WHERE org_id = $1`,
            [parentOrgId]
        );
        if (parentRes.rowCount === 0) return;
        const parent = parentRes.rows[0];

        // 2. Find all unique active members and their respective child organizations
        const recipientsRes = await pool.query(
            `SELECT om.user_id, child.org_id as child_org_id
             FROM organization_members om
             JOIN organizations child ON om.org_id = child.org_id
             WHERE child.parent_org_id = $1 
               AND child.is_deleted = FALSE 
               AND om.status = 'ACTIVE'`,
            [parentOrgId]
        );

        if (recipientsRes.rowCount === 0) {
            console.log(`ℹ️ No members found in child organizations for broadcast from ${parent.name}`);
            return;
        }

        // Deduplicate users for personal notifications
        const uniqueUsers = new Set();
        const personalRecipients = [];
        
        // Map orgs to one representative user (needed because user_id might be required/expected)
        const orgRepUsers = new Map();

        for (const row of recipientsRes.rows) {
            if (!uniqueUsers.has(row.user_id)) {
                uniqueUsers.add(row.user_id);
                personalRecipients.push(row.user_id);
            }
            if (!orgRepUsers.has(row.child_org_id)) {
                orgRepUsers.set(row.child_org_id, row.user_id);
            }
        }

        const type = "BROADCAST";
        const text = `📢 published an official announcement: ${postContent.substring(0, 100)}${postContent.length > 100 ? "..." : ""}`;

        // 3. Bulk insert notifications (Personal + Company)
        const values = [];
        const placeholders = [];
        let paramIdx = 1;

        // Add personal notifications (recipient_org_id = NULL)
        for (const userId of personalRecipients) {
            placeholders.push(`($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3}, $${paramIdx + 4}, $${paramIdx + 5}, $${paramIdx + 6})`);
            values.push(userId, null, type, text, postId, JSON.stringify({ org_id: parentOrgId, is_broadcast: true }), null);
            paramIdx += 7;
        }

        // Add organization notifications (recipient_org_id = orgId)
        for (const [orgId, repUserId] of orgRepUsers.entries()) {
            placeholders.push(`($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3}, $${paramIdx + 4}, $${paramIdx + 5}, $${paramIdx + 6})`);
            values.push(repUserId, null, type, text, postId, JSON.stringify({ org_id: parentOrgId, is_broadcast: true }), orgId);
            paramIdx += 7;
        }

        const insertQuery = `
            INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata, recipient_org_id)
            VALUES ${placeholders.join(", ")}
            RETURNING notification_id, user_id, recipient_org_id
        `;

        const insertRes = await pool.query(insertQuery, values);

        // 4. Emit real-time updates via Socket.IO
        // Note: For company notifications, the active socket for 'repUserId' will receive it.
        // If other admins are logged in, they will see it upon refresh.
        for (const row of insertRes.rows) {
            socketService.notifyUser(row.user_id, "notification", {
                notification_id: row.notification_id,
                type,
                text,
                reference_id: postId,
                is_read: false,
                created_at: new Date().toISOString(),
                actor_name: parent.name,
                actor_avatar: parent.logo_url,
                actor_slug: parent.slug,
                is_organization_actor: true,
                metadata: { org_id: parentOrgId, is_broadcast: true },
                recipient_org_id: row.recipient_org_id
            });
        }

        console.log(`✅ Broadcast alert sent to ${personalRecipients.length} personal feeds and ${orgRepUsers.size} organization feeds for ${parent.name}`);
    } catch (err) {
        console.error("notifyBroadcastToChildOrgs error:", err);
    }
}

module.exports = { notifyOrgFollowers, notifyBroadcastToChildOrgs };
