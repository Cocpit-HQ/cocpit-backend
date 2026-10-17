const pool = require("../../core/db/pool");
const socketService = require("../../core/infrastructure/socket.service");
const { sendToUser } = require("../notification/notification.service");

/**
 * sendJobOffer
 * Company admin sends a direct job offer to a user for an existing job post
 */
exports.sendJobOffer = async (req, res) => {
    const { companyId } = req.params;
    const { jobId, userId, message } = req.body;
    const sentBy = req.user.sub;

    if (!jobId || !userId) {
        return res.status(400).json({ message: "jobId and userId are required" });
    }

    if (userId === sentBy) {
        return res.status(400).json({ message: "You cannot send a job offer to yourself." });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const jobCheck = await client.query(
            `SELECT job_id, title FROM jobs 
             WHERE job_id = $1 AND is_active = TRUE 
               AND (org_id = $2 OR (org_id IS NULL AND recruiter_id = $3))`,
            [jobId, companyId || null, sentBy]
        );
        if (jobCheck.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: "Job not found or does not belong to this company/recruiter" });
        }

        // 2. Check for existing pending, accepted, or declined offer
        const dupCheck = await client.query(
            "SELECT 1 FROM job_offers WHERE job_id = $1 AND user_id = $2 AND status IN ('pending', 'accepted', 'declined')",
            [jobId, userId]
        );
        if (dupCheck.rowCount > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({ message: "An active or finalized offer for this job already exists for this user" });
        }

        // 3. Create the offer
        const result = await client.query(
            `INSERT INTO job_offers (job_id, org_id, user_id, sent_by, message)
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [jobId, companyId || null, userId, sentBy, message || null]
        );

        const offer = result.rows[0];
        const jobTitle = jobCheck.rows[0].title;

        // 4. Resolve sender name and avatar for notification
        let senderName = "A recruiter";
        let senderAvatar = null;
        if (companyId) {
            const companyRes = await client.query(
                "SELECT name, logo_url FROM organizations WHERE org_id = $1",
                [companyId]
            );
            if (companyRes.rowCount > 0) {
                senderName = companyRes.rows[0].name;
                senderAvatar = companyRes.rows[0].logo_url;
            }
        } else {
            const userRes = await client.query(
                "SELECT full_name, avatar_url FROM users WHERE user_id = $1",
                [sentBy]
            );
            if (userRes.rowCount > 0) {
                senderName = userRes.rows[0].full_name;
                senderAvatar = userRes.rows[0].avatar_url;
            }
        }

        const notifRes = await client.query(
            `INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [
                userId,
                sentBy,
                "job_offer_received",
                `${senderName} sent you a job offer: ${jobTitle}`,
                offer.offer_id,
                JSON.stringify({ org_id: companyId || null, offer_id: offer.offer_id, job_id: jobId })
            ]
        );

        // 5. Real-time socket notification
        socketService.notifyUser(userId, "notification", {
            type: "job_offer_received",
            text: `${senderName} sent you a job offer: ${jobTitle}`,
            from: companyId || sentBy,
            senderName: senderName,
            senderAvatar: senderAvatar,
            referenceId: offer.offer_id,
            isCompanyRequest: !!companyId,
            notification_id: notifRes.rows[0].notification_id,
            created_at: notifRes.rows[0].created_at.toISOString(),
            time: "Just now",
            metadata: { org_id: companyId || null, offer_id: offer.offer_id, job_id: jobId }
        });

        await client.query('COMMIT');
        res.status(201).json({ offer, message: "Offer sent successfully" });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Send job offer error:", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

/**
 * getMyOffers
 * User views all job offers they've received
 */
exports.getMyOffers = async (req, res) => {
    const userId = req.user.sub;
    const { status } = req.query;

    try {
        let query = `
            SELECT 
                jo.offer_id, jo.job_id, jo.org_id, jo.user_id, jo.sent_by, jo.message, jo.responded_at, jo.expires_at, jo.created_at, jo.updated_at, jo.context_sent,
                CASE
                    WHEN jo.status = 'pending' AND jo.expires_at <= NOW() THEN 'expired'
                    ELSE jo.status
                END AS status,
                TRUE AS is_offer,
                j.title, j.description, j.salary_min, j.salary_max, j.salary_currency,
                j.salary_period, j.job_type, j.work_mode, j.location, j.experience_level,
                j.company_name, j.recruiter_id,
                j.is_active, j.status as job_status,
                COALESCE(c.name, j.company_name) as company_display_name, c.logo_url as company_logo, c.slug as company_slug,
                u.full_name as sent_by_name,
                u.avatar_url as sent_by_avatar,
                u.headline as sent_by_headline
            FROM job_offers jo
            JOIN jobs j ON jo.job_id = j.job_id
            LEFT JOIN organizations c ON jo.org_id = c.org_id
            LEFT JOIN active_users u ON jo.sent_by = u.user_id
            WHERE jo.user_id = $1 AND j.is_active = TRUE
        `;
        const params = [userId];
        let paramIdx = 2;

        if (status && ['pending', 'accepted', 'declined', 'withdrawn', 'expired'].includes(status)) {
            if (status === 'expired') {
                query += ` AND (jo.status = 'expired' OR (jo.status = 'pending' AND jo.expires_at <= NOW()))`;
            } else if (status === 'pending') {
                query += ` AND jo.status = 'pending' AND (jo.expires_at IS NULL OR jo.expires_at > NOW())`;
            } else {
                query += ` AND jo.status = $${paramIdx}`;
                params.push(status);
                paramIdx++;
            }
        }

        query += ` ORDER BY jo.created_at DESC`;

        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        console.error("Get my offers error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

/**
 * getCompanySentOffers
 * Company views all offers they've sent, GROUPED by job_id
 * Each row = one job with aggregated offer counts
 */
exports.getCompanySentOffers = async (req, res) => {
    const { companyId } = req.params;

    try {
        const query = `
            SELECT 
                j.job_id,
                j.title,
                j.job_type,
                j.work_mode,
                j.location,
                j.experience_level,
                j.salary_min,
                j.salary_max,
                j.salary_currency,
                j.salary_period,
                j.company_name,
                j.description,
                c.name AS company_display_name,
                c.logo_url AS company_logo,
                COALESCE(c.logo_url, '') AS company_avatar,
                c.slug AS company_slug,
                TRUE AS is_offer,
                COUNT(jo.offer_id) AS total_offers,
                COUNT(jo.offer_id) FILTER (WHERE jo.status = 'pending') AS pending_count,
                COUNT(jo.offer_id) FILTER (WHERE jo.status = 'accepted') AS accepted_count,
                COUNT(jo.offer_id) FILTER (WHERE jo.status = 'declined') AS declined_count,
                COUNT(jo.offer_id) FILTER (WHERE jo.status = 'withdrawn') AS withdrawn_count,
                MAX(jo.created_at) AS latest_offer_at
            FROM job_offers jo
            JOIN jobs j ON jo.job_id = j.job_id
            JOIN organizations c ON j.org_id = c.org_id
            LEFT JOIN active_users u ON j.recruiter_id = u.user_id
            WHERE jo.org_id = $1 AND j.is_active = TRUE
            GROUP BY j.job_id, j.title, j.job_type, j.work_mode, j.location,
                     j.experience_level, j.salary_min, j.salary_max, j.salary_currency,
                     j.salary_period, j.company_name, j.description,
                     c.name, c.logo_url, c.slug, u.avatar_url
            ORDER BY latest_offer_at DESC
        `;

        const result = await pool.query(query, [companyId]);

        // Cast counts to numbers (pg returns strings for aggregate)
        const rows = result.rows.map(r => ({
            ...r,
            total_offers: Number(r.total_offers),
            pending_count: Number(r.pending_count),
            accepted_count: Number(r.accepted_count),
            declined_count: Number(r.declined_count),
            withdrawn_count: Number(r.withdrawn_count),
        }));

        res.json(rows);
    } catch (err) {
        console.error("Get company sent offers error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

/**
 * getCompanyOfferRecipients
 * Get individual recipients for a specific job's offers
 */
exports.getCompanyOfferRecipients = async (req, res) => {
    const { companyId, jobId } = req.params;
    const userId = req.user.sub;

    try {
        let query = `
            SELECT 
                jo.offer_id,
                jo.org_id,
                jo.status,
                jo.message,
                jo.created_at,
                jo.responded_at,
                u.user_id,
                u.full_name,
                u.avatar_url,
                u.headline,
                u.company_name AS candidate_company_name,
                sender.full_name AS sent_by_name,
                sender.headline AS sent_by_headline
            FROM job_offers jo
            JOIN active_users u ON jo.user_id = u.user_id
            LEFT JOIN active_users sender ON jo.sent_by = sender.user_id
        `;
        let params = [];
        if (companyId) {
            query += ` WHERE jo.org_id = $1 AND jo.job_id = $2 `;
            params = [companyId, jobId];
        } else {
            query += ` WHERE jo.sent_by = $1 AND jo.job_id = $2 `;
            params = [userId, jobId];
        }
        query += ` ORDER BY jo.created_at DESC `;

        const result = await pool.query(query, params);

        res.json(result.rows);
    } catch (err) {
        console.error("Get company offer recipients error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

/**
 * respondToOffer
 * User accepts or declines a job offer
 */
exports.respondToOffer = async (req, res) => {
    const { offerId } = req.params;
    const { action } = req.body; // 'accepted' or 'declined'
    const userId = req.user.sub;

    if (!['accepted', 'declined'].includes(action)) {
        return res.status(400).json({ message: "Action must be 'accepted' or 'declined'" });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        let resolvedOfferId = offerId;
        const jobCheck = await client.query(
            "SELECT offer_id FROM job_offers WHERE job_id = $1 AND user_id = $2 AND status = 'pending'",
            [offerId, userId]
        );
        if (jobCheck.rowCount > 0) {
            resolvedOfferId = jobCheck.rows[0].offer_id;
        }

        // 1. Fetch + lock the offer
        const offerRes = await client.query(
            "SELECT * FROM job_offers WHERE offer_id = $1 AND user_id = $2 FOR UPDATE",
            [resolvedOfferId, userId]
        );

        if (offerRes.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: "Pending offer not found" });
        }

        const offer = offerRes.rows[0];

        if (offer.status !== 'pending') {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: `Offer is already ${offer.status}` });
        }

        if (offer.expires_at && new Date(offer.expires_at) <= new Date()) {
            await client.query(
                "UPDATE job_offers SET status = 'expired', updated_at = NOW() WHERE offer_id = $1",
                [resolvedOfferId]
            );
            await client.query('COMMIT');
            return res.status(400).json({ message: "Offer has expired" });
        }

        // 2. Update status
        await client.query(
            "UPDATE job_offers SET status = $1, responded_at = NOW(), updated_at = NOW() WHERE offer_id = $2",
            [action, resolvedOfferId]
        );

        // 3. Get context for notifications
        const userRes = await client.query("SELECT full_name, avatar_url FROM users WHERE user_id = $1", [userId]);
        const user = userRes.rows[0];

        const jobRes = await client.query("SELECT title FROM jobs WHERE job_id = $1", [offer.job_id]);
        const jobTitle = jobRes.rows[0]?.title || 'Unknown Job';

        let senderName = 'a recruiter';
        if (offer.org_id) {
            const companyRes = await client.query("SELECT name FROM organizations WHERE org_id = $1", [offer.org_id]);
            if (companyRes.rowCount > 0) {
                senderName = companyRes.rows[0].name;
            }
        } else {
            const recruiterRes = await client.query("SELECT full_name FROM users WHERE user_id = $1", [offer.sent_by]);
            if (recruiterRes.rowCount > 0) {
                senderName = recruiterRes.rows[0].full_name;
            }
        }

        // 4. Notify company admins/managers AND/OR the original sender recruiter
        const notifyUserIds = new Set();
        if (offer.org_id) {
            const adminsRes = await client.query(
                `SELECT cm.user_id FROM organization_members cm
                 JOIN organization_roles cr ON cm.role_id = cr.role_id
                 WHERE cm.org_id = $1 AND cm.status = 'ACTIVE'
                   AND (cr.permissions @> '["*"]'::jsonb OR cr.permissions @> '["MANAGE_JOBS"]'::jsonb)`,
                [offer.org_id]
            );
            adminsRes.rows.forEach(r => notifyUserIds.add(r.user_id));
        }
        notifyUserIds.add(offer.sent_by); // Always notify the original recruiter

        const actionText = action === 'accepted' ? 'accepted' : 'declined';
        const notificationType = action === 'accepted' ? 'offer_accepted' : 'job_offer_declined';
        const notificationText = action === 'accepted' 
            ? `"${user.full_name}" accepted your offer for the job role "${jobTitle}"`
            : `${user.full_name} declined your offer for ${jobTitle}`;

        // Insert exactly ONE row for the company dashboard
        const adminIdsArray = Array.from(notifyUserIds);
        let dbNotification = null;
        
        if (adminIdsArray.length > 0) {
            const notifRes = await client.query(
                `INSERT INTO notifications (user_id, sender_id, type, text, reference_id, recipient_org_id, metadata)
                 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
                [
                    adminIdsArray[0], // Nominal owner for the DB row
                    userId,
                    notificationType,
                    notificationText,
                    offer.job_id, // Use job_id so clicking routes to the job applicants page
                    offer.org_id || null,
                    JSON.stringify({ org_id: offer.org_id || null, offer_id: offerId, job_id: offer.job_id })
                ]
            );
            dbNotification = notifRes.rows[0];
        }

        // Send real-time socket and push notifications to ALL admins
        for (const notifyUserId of adminIdsArray) {
            if (dbNotification) {
                socketService.notifyUser(notifyUserId, "notification", {
                    notification_id: dbNotification.notification_id,
                    type: notificationType,
                    text: notificationText,
                    reference_id: offer.job_id,
                    is_read: false,
                    created_at: dbNotification.created_at.toISOString(),
                    actor_name: user.full_name,
                    actor_avatar: user.avatar_url,
                    actor_slug: null,
                    is_company_actor: false,
                    metadata: { org_id: offer.org_id || null, offer_id: offerId, job_id: offer.job_id }
                });
            }
            
            if (action === 'accepted') {
                sendToUser(
                    notifyUserId,
                    "Offer accepted",
                    notificationText,
                    { type: 'offer_accepted', referenceId: offer.job_id }
                ).catch(() => {});
            }
        }

        // 5. Notify the user (confirmation in their history)
        const userNotifRes = await client.query(
            `INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [
                userId,
                userId,
                `job_offer_${actionText}`,
                `You ${actionText} the offer from ${senderName} for ${jobTitle}`,
                offer.offer_id,
                JSON.stringify({ org_id: offer.org_id || null, offer_id: offerId, job_id: offer.job_id })
            ]
        );

        await client.query('COMMIT');
        res.json({ status: action, message: `Offer ${actionText} successfully` });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Respond to offer error:", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

/**
 * withdrawOffer
 * Company withdraws a pending offer
 */
exports.withdrawOffer = async (req, res) => {
    const { companyId, offerId } = req.params;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const offerRes = await client.query(
            `SELECT * FROM job_offers 
             WHERE offer_id = $1 AND status = 'pending' 
               AND (org_id = $2 OR (org_id IS NULL AND sent_by = $3))
             FOR UPDATE`,
            [offerId, companyId || null, req.user.sub]
        );

        if (offerRes.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: "Pending offer not found" });
        }

        const offer = offerRes.rows[0];

        await client.query(
            "UPDATE job_offers SET status = 'withdrawn', updated_at = NOW() WHERE offer_id = $1",
            [offerId]
        );

        // Resolve sender details for notification
        let senderName = "A recruiter";
        let senderAvatar = null;
        if (offer.org_id) {
            const companyRes = await client.query("SELECT name, logo_url FROM organizations WHERE org_id = $1", [offer.org_id]);
            if (companyRes.rowCount > 0) {
                senderName = companyRes.rows[0].name;
                senderAvatar = companyRes.rows[0].logo_url;
            }
        } else {
            const userRes = await client.query("SELECT full_name, avatar_url FROM users WHERE user_id = $1", [offer.sent_by]);
            if (userRes.rowCount > 0) {
                senderName = userRes.rows[0].full_name;
                senderAvatar = userRes.rows[0].avatar_url;
            }
        }

        const jobRes = await client.query("SELECT title FROM jobs WHERE job_id = $1", [offer.job_id]);
        const jobTitle = jobRes.rows[0]?.title || 'a position';

        const notifRes = await client.query(
            `INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [
                offer.user_id,
                req.user.sub,
                "job_offer_withdrawn",
                `${senderName} withdrew the offer for ${jobTitle}`,
                offerId,
                JSON.stringify({ org_id: offer.org_id || null, offer_id: offerId, job_id: offer.job_id })
            ]
        );

        socketService.notifyUser(offer.user_id, "notification", {
            type: "job_offer_withdrawn",
            text: `${senderName} withdrew the offer for ${jobTitle}`,
            from: offer.org_id || offer.sent_by,
            senderName: senderName,
            senderAvatar: senderAvatar,
            referenceId: offerId,
            notification_id: notifRes.rows[0].notification_id,
            created_at: notifRes.rows[0].created_at.toISOString(),
            time: "Just now",
            metadata: { org_id: offer.org_id || null, offer_id: offerId, job_id: offer.job_id }
        });

        await client.query('COMMIT');
        res.json({ status: 'withdrawn', message: "Offer withdrawn successfully" });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Withdraw offer error:", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

/**
 * getOfferDetail
 * Get full details of a single offer
 */
exports.getOfferDetail = async (req, res) => {
    const { offerId } = req.params;
    const userId = req.user.sub;

    try {
        const result = await pool.query(
            `SELECT 
                jo.offer_id, jo.job_id, jo.org_id, jo.user_id, jo.sent_by, jo.message, jo.responded_at, jo.expires_at, jo.created_at, jo.updated_at,
                CASE
                    WHEN jo.status = 'pending' AND jo.expires_at <= NOW() THEN 'expired'
                    ELSE jo.status
                END AS status,
                j.title, j.description, j.salary_min, j.salary_max, j.salary_currency,
                j.salary_period, j.job_type, j.work_mode, j.location, j.experience_level,
                j.about_company, j.company_name, j.industry, j.recruiter_id,
                COALESCE(c.name, j.company_name) as company_display_name, c.logo_url as company_logo, c.slug as company_slug,
                u.full_name as sent_by_name, u.avatar_url as sent_by_avatar
            FROM job_offers jo
            JOIN jobs j ON jo.job_id = j.job_id
            LEFT JOIN organizations c ON jo.org_id = c.org_id
            LEFT JOIN active_users u ON jo.sent_by = u.user_id
            WHERE jo.offer_id = $1 AND (jo.user_id = $2 OR jo.sent_by = $2 OR (jo.org_id IS NOT NULL AND jo.org_id IN (
                SELECT org_id FROM organization_members WHERE user_id = $2
            )))`,
            [offerId, userId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ message: "Offer not found" });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error("Get offer detail error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

/**
 * checkOfferStatus
 * See if a company or recruiter has already sent a pending offer to a specific user
 */
exports.checkOfferStatus = async (req, res) => {
    const { companyId, targetUserId } = req.params;
    const userId = req.user.sub;

    try {
        let result;
        if (companyId) {
            result = await pool.query(
                `SELECT job_id FROM job_offers 
                 WHERE org_id = $1 AND user_id = $2 AND status = 'pending'`,
                [companyId, targetUserId]
            );
        } else {
            result = await pool.query(
                `SELECT job_id FROM job_offers 
                 WHERE sent_by = $1 AND user_id = $2 AND status = 'pending'`,
                [userId, targetUserId]
            );
        }

        res.json({
            sent: result.rowCount > 0,
            jobIds: result.rows.map(r => r.job_id)
        });
    } catch (err) {
        console.error("Check offer status error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

/**
 * getRecruiterSentOffers
 * Recruiter views all offers they've sent across all their jobs (both company and independent)
 */
exports.getRecruiterSentOffers = async (req, res) => {
    const userId = req.user.sub;

    try {
        const query = `
            SELECT 
                j.job_id,
                j.title,
                j.job_type,
                j.work_mode,
                j.location,
                j.experience_level,
                j.salary_min,
                j.salary_max,
                j.salary_currency,
                j.salary_period,
                j.company_name,
                j.description,
                COALESCE(c.name, j.company_name) AS company_display_name,
                c.logo_url AS company_logo,
                COALESCE(c.logo_url, '') AS company_avatar,
                c.slug AS company_slug,
                TRUE AS is_offer,
                COUNT(jo.offer_id) AS total_offers,
                COUNT(jo.offer_id) FILTER (WHERE jo.status = 'pending') AS pending_count,
                COUNT(jo.offer_id) FILTER (WHERE jo.status = 'accepted') AS accepted_count,
                COUNT(jo.offer_id) FILTER (WHERE jo.status = 'declined') AS declined_count,
                COUNT(jo.offer_id) FILTER (WHERE jo.status = 'withdrawn') AS withdrawn_count,
                MAX(jo.created_at) AS latest_offer_at
            FROM job_offers jo
            JOIN jobs j ON jo.job_id = j.job_id
            LEFT JOIN organizations c ON j.org_id = c.org_id
            LEFT JOIN active_users u ON j.recruiter_id = u.user_id
            WHERE jo.sent_by = $1
            GROUP BY j.job_id, j.title, j.job_type, j.work_mode, j.location,
                     j.experience_level, j.salary_min, j.salary_max, j.salary_currency,
                     j.salary_period, j.company_name, j.description,
                     c.name, c.logo_url, c.slug, u.avatar_url
            ORDER BY latest_offer_at DESC
        `;

        const result = await pool.query(query, [userId]);

        const rows = result.rows.map(r => ({
            ...r,
            total_offers: Number(r.total_offers),
            pending_count: Number(r.pending_count),
            accepted_count: Number(r.accepted_count),
            declined_count: Number(r.declined_count),
            withdrawn_count: Number(r.withdrawn_count),
        }));

        res.json(rows);
    } catch (err) {
        console.error("Get recruiter sent offers error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

/**
 * sendChatContext
 * Automatically sends a one-time rich job card context message when a candidate accepts an offer and starts chatting
 */
exports.sendChatContext = async (req, res) => {
    const { offerId } = req.params;
    const userId = req.user.sub || req.user.user_id;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Fetch job offer
        const offerRes = await client.query(
            "SELECT * FROM job_offers WHERE offer_id = $1 AND user_id = $2 AND status = 'accepted' FOR UPDATE",
            [offerId, userId]
        );
        if (offerRes.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: "Accepted offer not found" });
        }
        const offer = offerRes.rows[0];

        // 2. Check if context has already been sent
        if (offer.context_sent) {
            await client.query('COMMIT');
            return res.json({ sent: false, already_sent: true });
        }

        const targetUserId = offer.sent_by;

        // 3. Find if there is an existing conversation between candidate (userId) and recruiter (targetUserId)
        const existingConv = await client.query(
            `SELECT c.conversation_id
             FROM conversations c
             JOIN conversation_participants cp1 ON c.conversation_id = cp1.conversation_id AND cp1.user_id = $1
             JOIN conversation_participants cp2 ON c.conversation_id = cp2.conversation_id AND cp2.user_id = $2
             WHERE c.is_group = FALSE AND c.is_active = TRUE`,
            [userId, targetUserId]
        );

        if (existingConv.rowCount === 0) {
            // No conversation yet. Let the frontend know so it can retry later.
            await client.query('COMMIT');
            return res.json({ sent: false, no_conversation: true });
        }

        const conversationId = existingConv.rows[0].conversation_id;

        // 4. Fetch details for context message text
        // - Candidate full name
        const userRes = await client.query("SELECT full_name, avatar_url FROM users WHERE user_id = $1", [userId]);
        const candidateName = userRes.rows[0]?.full_name || 'Candidate';
        const candidateAvatar = userRes.rows[0]?.avatar_url || null;

        // - Job role
        const jobRes = await client.query("SELECT title, company_name, org_id FROM jobs WHERE job_id = $1", [offer.job_id]);
        const jobTitle = jobRes.rows[0]?.title || 'Job';
        const jobCompany = jobRes.rows[0]?.company_name || 'Company';
        const jobOrgId = jobRes.rows[0]?.org_id;

        let companyName = jobCompany;
        if (jobOrgId) {
            const orgRes = await client.query("SELECT name FROM organizations WHERE org_id = $1", [jobOrgId]);
            if (orgRes.rowCount > 0) {
                companyName = orgRes.rows[0].name;
            }
        }

        const contextText = `Hi! I'm ${candidateName}. I accepted your offer for '${jobTitle}' at ${companyName} and wanted to connect! 🎉`;

        // 5. Insert context message:
        // Use message_type = 'offer_context', entity_type = 'job', entity_id = offer.job_id
        const msgRes = await client.query(
            `INSERT INTO messages (
                conversation_id, sender_id, text_content,
                message_type, entity_type, entity_id, sender_type
             ) VALUES ($1, $2, $3, 'offer_context', 'job', $4, 'USER')
             RETURNING *`,
            [conversationId, userId, '', offer.job_id]
        );
        const newMessage = msgRes.rows[0];

        // 6. Update conversation
        await client.query(
            `UPDATE conversations
             SET last_message = $1, last_message_at = NOW(), updated_at = NOW()
             WHERE conversation_id = $2`,
            [contextText, conversationId]
        );

        // 7. Set context_sent = TRUE
        await client.query(
            `UPDATE job_offers SET context_sent = TRUE, updated_at = NOW() WHERE offer_id = $1`,
            [offerId]
        );

        await client.query('COMMIT');

        // 8. Emit socket notification to the recruiter (targetUserId)
        const socketPayload = {
            ...newMessage,
            sender_name: candidateName,
            sender_avatar: candidateAvatar,
            entity_type: 'job',
            entity_id: offer.job_id,
            // To make sure frontend renders it correctly (legacy formats)
            entity_preview: {
                entityType: 'job',
                entityId: offer.job_id,
                title: jobTitle,
                subtitle: companyName,
                image: null,
                url: `/jobs/${offer.job_id}`
            }
        };

        // Notify recruiter via socket
        socketService.notifyUser(targetUserId, "newMessage", socketPayload);
        socketService.notifyUser(targetUserId, "notification", {
            type: "message",
            isJobChat: true,
            from: userId,
            senderName: candidateName,
            senderAvatar: candidateAvatar,
            conversationId,
            text: `Shared a job`,
        });

        // Also notify the sender user (candidate) on other active tabs/devices so it synchronizes
        socketService.notifyUser(userId, "newMessage", socketPayload);

        return res.json({ sent: true, conversation_id: conversationId, message_id: newMessage.message_id });

    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error("Send chat context error:", err);
        return res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};


