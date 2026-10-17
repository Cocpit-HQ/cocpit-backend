const pool = require("../core/db/pool");
const socketService = require("../services/socket.service");
const { sendToUser } = require("../modules/notification/notification.service");

/**
 * Checks for job offers that are expiring within the next 24 hours
 * and sends a nudge to the candidates.
 */
const processOfferExpiryNudges = async () => {
    try {
        console.log(`[INFO] ${new Date().toISOString()} [OfferExpiryCron] Starting check for expiring offers...`);

        // Find pending offers expiring in the next 24 hours
        // We also check if we already sent an offer_expiring notification for this job & user
        const result = await pool.query(`
            SELECT 
                jo.offer_id, 
                jo.user_id, 
                jo.job_id, 
                jo.org_id, 
                jo.expires_at,
                j.title as job_title, 
                o.name as company_name, 
                o.logo_url as company_avatar, 
                u.email as applicant_email
            FROM job_offers jo
            JOIN jobs j ON jo.job_id = j.job_id
            JOIN organizations o ON jo.org_id = o.org_id
            JOIN users u ON jo.user_id = u.user_id
            WHERE jo.status = 'pending'
              AND jo.expires_at > NOW() 
              AND jo.expires_at <= NOW() + INTERVAL '24 hours'
              AND NOT EXISTS (
                  SELECT 1 FROM notifications n 
                  WHERE n.user_id = jo.user_id 
                    AND n.type = 'offer_expiring' 
                    AND n.reference_id = jo.job_id
              )
        `);

        if (result.rowCount === 0) {
            console.log(`[INFO] ${new Date().toISOString()} [OfferExpiryCron] No expiring offers found.`);
            return;
        }

        let nudgedCount = 0;
        for (const offer of result.rows) {
            const { 
                user_id, job_id, org_id, job_title, 
                company_name, company_avatar, applicant_email 
            } = offer;

            const type = 'offer_expiring';
            const title = "Last day to respond to your offer";
            const text = `Your offer from ${company_name} expires tomorrow. Don't miss it.`;

            // Insert notification
            const notifRes = await pool.query(`
                INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata)
                VALUES ($1, $2, $3, $4, $5, $6)
                RETURNING notification_id
            `, [
                user_id,
                null, // System generated nudge
                type,
                text,
                job_id,
                JSON.stringify({ job_id, org_id })
            ]);
            const notificationId = notifRes.rows[0]?.notification_id;

            // Real-time socket event
            socketService.notifyUser(user_id, "notification", {
                notification_id: notificationId,
                type,
                title,
                text,
                senderName: company_name,
                senderAvatar: company_avatar,
                referenceId: job_id,
                timestamp: new Date().toISOString()
            });

            // Push Notification
            sendToUser(user_id, title, text, {
                type,
                referenceId: job_id
            }).catch(() => {});


            nudgedCount++;
        }

        console.log(`[INFO] ${new Date().toISOString()} [OfferExpiryCron] Completed successfully. Nudged ${nudgedCount} candidates.`);
    } catch (error) {
        console.error(`[ERROR] ${new Date().toISOString()} [OfferExpiryCron] Failed to process expiring offers:`, error);
    }
};

module.exports = {
    processOfferExpiryNudges
};
