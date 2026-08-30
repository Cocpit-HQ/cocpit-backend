const pool = require("../core/db/pool");
const logger = require("../core/logger/logger");
const socketService = require("../core/infrastructure/socket.service");
const { sendToUser: sendPush } = require("../modules/notification/notification.service");

/**
 * Unread Messages Nudge Cron Worker
 * Checks company unread message counts. If a company has 9+, 20+, or 50+ unread messages,
 * it triggers a nudge notification to all company members.
 */
const processUnreadMessagesNudges = async () => {
    let client;
    try {
        try {
            client = await pool.connect();
            client.once('error', (err) => {
                logger.error("[UnreadMessagesCron] Unexpected client error:", err.message);
            });
        } catch (connErr) {
            logger.warn("[UnreadMessagesCron] Database connection unavailable. Skipping execution.");
            return;
        }

        logger.info("[UnreadMessagesCron] Starting unread messages check...");
        
        // Find organizations with 9 or more unread messages
        const unreadRes = await client.query(`
            SELECT cp.org_id, COUNT(m.message_id)::int AS total_unread
            FROM conversation_participants cp
            JOIN messages m ON m.conversation_id = cp.conversation_id
            WHERE cp.org_id IS NOT NULL
              AND cp.left_at IS NULL
              AND (m.author_org_id != cp.org_id OR m.author_org_id IS NULL)
              AND (cp.last_read_at IS NULL OR m.created_at > cp.last_read_at)
            GROUP BY cp.org_id
            HAVING COUNT(m.message_id) >= 9
        `);
        
        let organizationsNudged = 0;

        for (const row of unreadRes.rows) {
            const orgId = row.org_id;
            const totalUnread = parseInt(row.total_unread, 10);

            // Determine threshold label
            let thresholdLabel = "9+";
            if (totalUnread >= 50) thresholdLabel = "50+";
            else if (totalUnread >= 20) thresholdLabel = "20+";

            const title = "You have pending messages";
            const message = `You have "${thresholdLabel}" unread messages waiting in your chatbot. Review them now`;
            const type = "unread_messages_nudge";


            let notifRes;
            try {
                // Check if a nudge was already sent in the last 24 hours
                const existingNotif = await client.query(
                    `SELECT notification_id FROM notifications 
                     WHERE type = $1 AND recipient_org_id = $2 
                     AND created_at >= NOW() - INTERVAL '24 hours'`,
                    [type, orgId]
                );

                if (existingNotif.rows.length > 0) {
                    logger.info(`[UnreadMessagesCron] Skipped org ${orgId} (already nudged within 24h).`);
                    continue;
                }

                // Persist ONE notification in DB so it shows in the company's notification center
                notifRes = await client.query(
                    `INSERT INTO notifications (type, text, metadata, recipient_org_id)
                     VALUES ($1, $2, $3, $4) RETURNING notification_id, created_at`,
                    [type, message, JSON.stringify({ title, orgId }), orgId]
                );
            } catch (err) {
                logger.error(`[UnreadMessagesCron] Failed to persist DB notification for org ${orgId}:`, err.message);
                continue;
            }

            // Fetch active members of the organization
            const membersRes = await client.query(
                'SELECT user_id FROM organization_members WHERE org_id = $1',
                [orgId]
            );

            for (const member of membersRes.rows) {
                const userId = member.user_id;

                try {
                    // Send socket notification (In-App)
                    const payload = {
                        type,
                        title,
                        message,
                        timestamp: new Date().toISOString(),
                        notification_id: notifRes.rows[0].notification_id,
                        created_at: notifRes.rows[0].created_at.toISOString(),
                        recipient_company_id: orgId
                    };
                    const targetActorScope = `org:${orgId}`;
                    
                    // We dispatch it to the specific org actor scope, so they see it if active as company
                    socketService.notifyUserScoped(userId, "notification", payload, targetActorScope);
                    
                    // Also dispatch to their general user scope just in case
                    socketService.notifyUser(userId, "notification", payload);

                    // Send Push Notification
                    await sendPush(userId, title, message, { type }).catch(() => {});
                } catch (err) {
                    logger.error(`[UnreadMessagesCron] Failed to nudge user ${userId} for org ${orgId}:`, err.message);
                }
            }

            organizationsNudged++;
        }

        logger.info(`[UnreadMessagesCron] Completed successfully. Nudged ${organizationsNudged} organizations.`);

    } catch (error) {
        logger.error("[UnreadMessagesCron] Critical error during execution:", error);
    } finally {
        if (client) {
            client.release();
        }
    }
};

module.exports = {
    processUnreadMessagesNudges
};
