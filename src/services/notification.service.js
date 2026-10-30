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

        // 2. Get opted-in followers (who have this category enabled and are not blocked)
        const followersRes = await pool.query(
            `SELECT cf.user_id
       FROM organization_followers cf
       INNER JOIN organization_notification_preferences cnp
         ON cf.user_id = cnp.user_id AND cf.org_id = cnp.org_id
       WHERE cf.org_id = $1 AND cnp.${column} = TRUE
         AND NOT EXISTS (
           SELECT 1 FROM blocks b
           WHERE (b.blocker_id = $1 AND b.blocked_id = cf.user_id)
              OR (b.blocker_id = cf.user_id AND b.blocked_id = $1)
         )
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

        // 2. Find all unique active members and their respective child organizations (excluding blocked users)
        const recipientsRes = await pool.query(
            `SELECT om.user_id, child.org_id as child_org_id
             FROM organization_members om
             JOIN organizations child ON om.org_id = child.org_id
             WHERE child.parent_org_id = $1 
               AND child.is_deleted = FALSE 
               AND om.status = 'ACTIVE'
               AND NOT EXISTS (
                 SELECT 1 FROM blocks b
                 WHERE (b.blocker_id = $1 AND b.blocked_id = om.user_id)
                    OR (b.blocker_id = om.user_id AND b.blocked_id = $1)
               )`,
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

const ACTION_CONFIG = {
    company_deactivated: {
        title: "Company Deactivated",
        textTemplate: (name) => `${name} has been deactivated.`
    },
    company_reactivated: {
        title: "Company Reactivated",
        textTemplate: (name) => `${name} has been reactivated.`
    },
    company_deleted: {
        title: "Company Scheduled for Deletion",
        textTemplate: (name) => `${name} has been scheduled for deletion.`
    },
    company_recovered: {
        title: "Company Recovered",
        textTemplate: (name) => `${name} has been recovered.`
    }
};

/**
 * Dispatches notifications to all stakeholders (Owner, Admins, and all Team Members)
 * of an organization into their personal Notification Center when an organization's state changes.
 *
 * @param {string} orgId - Target organization ID
 * @param {string} actorId - ID of user who performed the state change
 * @param {string} actionType - 'company_deactivated' | 'company_reactivated' | 'company_deleted' | 'company_recovered'
 */
async function notifyAllOrgStakeholders(orgId, actorId, actionType) {
    const config = ACTION_CONFIG[actionType];
    if (!config) {
        console.error(`notifyAllOrgStakeholders: Unknown actionType "${actionType}"`);
        return;
    }

    try {
        // 1. Fetch organization details using pool (decoupled from any caller transaction)
        const orgRes = await pool.query(
            `SELECT org_id, name, logo_url, slug, created_by FROM organizations WHERE org_id = $1`,
            [orgId]
        );
        if (orgRes.rowCount === 0) return;
        const org = orgRes.rows[0];

        // 2. Fetch all unique stakeholders: Owner (created_by) + all active organization_members
        const stakeholdersRes = await pool.query(
            `SELECT created_by AS user_id FROM organizations WHERE org_id = $1 AND created_by IS NOT NULL
             UNION
             SELECT user_id FROM organization_members WHERE org_id = $1 AND (status = 'ACTIVE' OR status IS NULL) AND user_id IS NOT NULL`,
            [org.org_id]
        );

        if (stakeholdersRes.rowCount === 0) return;

        const notifText = config.textTemplate(org.name || "Company");
        const baseMetadata = {
            org_id: org.org_id,
            orgId: org.org_id,
            org_name: org.name,
            orgName: org.name,
            org_logo: org.logo_url,
            orgLogo: org.logo_url,
            org_slug: org.slug,
            orgSlug: org.slug,
            owner_id: org.created_by,
            ownerId: org.created_by,
            title: config.title
        };

        // 3. Prepare bulk insert into notifications table with recipient_org_id = NULL (personal feed)
        const values = [];
        const placeholders = [];
        let paramIdx = 1;

        for (const row of stakeholdersRes.rows) {
            const isOwner = row.user_id === org.created_by;
            const stakeholderMetadata = {
                ...baseMetadata,
                is_owner: isOwner,
                isOwner: isOwner,
                can_recover: isOwner,
                canRecover: isOwner
            };
            const metadataJson = JSON.stringify(stakeholderMetadata);

            placeholders.push(
                `($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3}, $${paramIdx + 4}, $${paramIdx + 5}::jsonb, NULL)`
            );
            values.push(
                row.user_id,             // user_id (personal feed)
                actorId || null,         // sender_id
                actionType,              // type
                notifText,               // text
                org.org_id,              // reference_id
                metadataJson             // metadata
            );
            paramIdx += 6;
        }

        const insertQuery = `
            INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata, recipient_org_id)
            VALUES ${placeholders.join(", ")}
            RETURNING notification_id, user_id
        `;

        const insertRes = await pool.query(insertQuery, values);

        // 4. Dispatch real-time socket events and push notifications
        let sendPush = null;
        try {
            sendPush = require("../modules/notification/notification.service").sendToUser;
        } catch {
            // Push service optional
        }

        const timestamp = new Date().toISOString();

        for (const row of insertRes.rows) {
            const isOwner = row.user_id === org.created_by;
            const stakeholderMetadata = {
                ...baseMetadata,
                is_owner: isOwner,
                isOwner: isOwner,
                can_recover: isOwner,
                canRecover: isOwner
            };

            // Real-time socket notification
            try {
                socketService.notifyUser(row.user_id, "notification", {
                    notification_id: row.notification_id,
                    type: actionType,
                    text: notifText,
                    reference_id: org.org_id,
                    referenceId: org.org_id,
                    actor_name: org.name,
                    actor_avatar: org.logo_url,
                    actor_slug: org.slug,
                    is_company_actor: true,
                    is_organization_actor: true,
                    can_recover: isOwner,
                    canRecover: isOwner,
                    is_owner: isOwner,
                    isOwner: isOwner,
                    metadata: stakeholderMetadata,
                    is_read: false,
                    created_at: timestamp,
                    recipient_org_id: null
                });
            } catch (sockErr) {
                console.error(`[notifyAllOrgStakeholders] Socket emit error for user ${row.user_id}:`, sockErr.message);
            }

            // Mobile push notification
            if (typeof sendPush === 'function') {
                sendPush(row.user_id, config.title, notifText, {
                    type: actionType,
                    org_id: org.org_id
                }).catch(err => console.error(`[Push Notification] Error sending to ${row.user_id}:`, err?.message));
            }
        }

        console.log(`[notifyAllOrgStakeholders] Dispatched ${actionType} notifications to ${insertRes.rowCount} users for ${org.name}`);
    } catch (err) {
        console.error(`[notifyAllOrgStakeholders] Error dispatching ${actionType} for org ${orgId}:`, err);
    }
}

module.exports = { notifyOrgFollowers, notifyBroadcastToChildOrgs, notifyAllOrgStakeholders };
