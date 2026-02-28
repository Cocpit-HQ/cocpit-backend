const pool = require("../db/pool");
const socketService = require("../services/socket.service");

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

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Verify job belongs to this company
        const jobCheck = await client.query(
            "SELECT job_id, title FROM jobs WHERE job_id = $1 AND company_id = $2 AND is_active = TRUE",
            [jobId, companyId]
        );
        if (jobCheck.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: "Job not found or does not belong to this company" });
        }

        // 2. Check for existing pending offer
        const dupCheck = await client.query(
            "SELECT 1 FROM job_offers WHERE job_id = $1 AND user_id = $2 AND status = 'pending'",
            [jobId, userId]
        );
        if (dupCheck.rowCount > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({ message: "A pending offer for this job already exists for this user" });
        }

        // 3. Create the offer
        const result = await client.query(
            `INSERT INTO job_offers (job_id, company_id, user_id, sent_by, message)
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [jobId, companyId, userId, sentBy, message || null]
        );

        const offer = result.rows[0];
        const jobTitle = jobCheck.rows[0].title;

        // 4. Create notification for user
        const companyRes = await client.query(
            "SELECT name, logo_url FROM companies WHERE company_id = $1",
            [companyId]
        );
        const company = companyRes.rows[0];

        const notifRes = await client.query(
            `INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [
                userId,
                sentBy,
                "job_offer_received",
                `${company.name} sent you a job offer: ${jobTitle}`,
                offer.offer_id,
                JSON.stringify({ company_id: companyId, offer_id: offer.offer_id, job_id: jobId })
            ]
        );

        // 5. Real-time socket notification
        socketService.notifyUser(userId, "notification", {
            type: "job_offer_received",
            text: `${company.name} sent you a job offer: ${jobTitle}`,
            from: companyId,
            senderName: company.name,
            senderAvatar: company.logo_url,
            referenceId: offer.offer_id,
            isCompanyRequest: true,
            notification_id: notifRes.rows[0].notification_id,
            created_at: notifRes.rows[0].created_at.toISOString(),
            time: "Just now"
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
                jo.*,
                TRUE AS is_offer,
                j.title, j.description, j.salary_min, j.salary_max, j.salary_currency,
                j.salary_period, j.job_type, j.work_mode, j.location, j.experience_level,
                j.company_name,
                c.name as company_display_name, c.logo_url as company_logo, c.slug as company_slug,
                u.full_name as sent_by_name
            FROM job_offers jo
            JOIN jobs j ON jo.job_id = j.job_id
            JOIN companies c ON jo.company_id = c.company_id
            LEFT JOIN users u ON jo.sent_by = u.user_id
            WHERE jo.user_id = $1
        `;
        const params = [userId];
        let paramIdx = 2;

        if (status && ['pending', 'accepted', 'declined', 'withdrawn', 'expired'].includes(status)) {
            query += ` AND jo.status = $${paramIdx}`;
            params.push(status);
            paramIdx++;
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
            JOIN companies c ON jo.company_id = c.company_id
            WHERE jo.company_id = $1
            GROUP BY j.job_id, j.title, j.job_type, j.work_mode, j.location,
                     j.experience_level, j.salary_min, j.salary_max, j.salary_currency,
                     j.salary_period, j.company_name, j.description,
                     c.name, c.logo_url, c.slug
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

    try {
        const result = await pool.query(`
            SELECT 
                jo.offer_id,
                jo.status,
                jo.message,
                jo.created_at,
                jo.responded_at,
                u.user_id,
                u.full_name,
                u.avatar_url,
                u.headline,
                sender.full_name AS sent_by_name
            FROM job_offers jo
            JOIN users u ON jo.user_id = u.user_id
            LEFT JOIN users sender ON jo.sent_by = sender.user_id
            WHERE jo.company_id = $1 AND jo.job_id = $2
            ORDER BY jo.created_at DESC
        `, [companyId, jobId]);

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

        // 1. Fetch + lock the offer
        const offerRes = await client.query(
            "SELECT * FROM job_offers WHERE offer_id = $1 AND user_id = $2 AND status = 'pending' FOR UPDATE",
            [offerId, userId]
        );

        if (offerRes.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: "Pending offer not found" });
        }

        const offer = offerRes.rows[0];

        // 2. Update status
        await client.query(
            "UPDATE job_offers SET status = $1, responded_at = NOW(), updated_at = NOW() WHERE offer_id = $2",
            [action, offerId]
        );

        // 3. Get context for notifications
        const userRes = await client.query("SELECT full_name, avatar_url FROM users WHERE user_id = $1", [userId]);
        const user = userRes.rows[0];

        const jobRes = await client.query("SELECT title FROM jobs WHERE job_id = $1", [offer.job_id]);
        const jobTitle = jobRes.rows[0]?.title || 'Unknown Job';

        const companyRes = await client.query("SELECT name, logo_url FROM companies WHERE company_id = $1", [offer.company_id]);
        const company = companyRes.rows[0];

        // 4. Notify company admins/managers (join company_roles for correct permission check)
        const adminsRes = await client.query(
            `SELECT cm.user_id FROM company_members cm
             JOIN company_roles cr ON cm.role_id = cr.role_id
             WHERE cm.company_id = $1 AND cm.status = 'ACTIVE'
               AND (cr.permissions @> '["*"]'::jsonb OR cr.permissions @> '["MANAGE_JOBS"]'::jsonb)`,
            [offer.company_id]
        );

        const actionText = action === 'accepted' ? 'accepted' : 'declined';

        for (const admin of adminsRes.rows) {
            const notifRes = await client.query(
                `INSERT INTO notifications (user_id, sender_id, type, text, reference_id, recipient_company_id, metadata)
                 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
                [
                    admin.user_id,
                    userId,
                    `job_offer_${actionText}`,
                    `${user.full_name} ${actionText} your offer for ${jobTitle}`,
                    offer.offer_id,
                    offer.company_id,
                    JSON.stringify({ company_id: offer.company_id, offer_id: offerId, job_id: offer.job_id })
                ]
            );

            socketService.notifyUser(admin.user_id, "notification", {
                type: `job_offer_${actionText}`,
                text: `${user.full_name} ${actionText} your offer for ${jobTitle}`,
                from: userId,
                senderName: user.full_name,
                senderAvatar: user.avatar_url,
                referenceId: offer.offer_id,
                notification_id: notifRes.rows[0].notification_id,
                created_at: notifRes.rows[0].created_at.toISOString(),
                time: "Just now"
            });
        }

        // 5. Notify the user (confirmation in their history)
        const userNotifRes = await client.query(
            `INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [
                userId,
                userId,
                `job_offer_${actionText}`,
                `You ${actionText} the offer from ${company.name} for ${jobTitle}`,
                offer.offer_id,
                JSON.stringify({ company_id: offer.company_id, offer_id: offerId })
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
            "SELECT * FROM job_offers WHERE offer_id = $1 AND company_id = $2 AND status = 'pending' FOR UPDATE",
            [offerId, companyId]
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

        // Notify the user
        const companyRes = await client.query("SELECT name, logo_url FROM companies WHERE company_id = $1", [companyId]);
        const company = companyRes.rows[0];

        const jobRes = await client.query("SELECT title FROM jobs WHERE job_id = $1", [offer.job_id]);
        const jobTitle = jobRes.rows[0]?.title || 'a position';

        const notifRes = await client.query(
            `INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [
                offer.user_id,
                req.user.sub,
                "job_offer_withdrawn",
                `${company.name} withdrew their offer for ${jobTitle}`,
                offerId,
                JSON.stringify({ company_id: companyId, offer_id: offerId })
            ]
        );

        socketService.notifyUser(offer.user_id, "notification", {
            type: "job_offer_withdrawn",
            text: `${company.name} withdrew their offer for ${jobTitle}`,
            from: companyId,
            senderName: company.name,
            senderAvatar: company.logo_url,
            referenceId: offerId,
            notification_id: notifRes.rows[0].notification_id,
            created_at: notifRes.rows[0].created_at.toISOString(),
            time: "Just now"
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
                jo.*,
                j.title, j.description, j.salary_min, j.salary_max, j.salary_currency,
                j.salary_period, j.job_type, j.work_mode, j.location, j.experience_level,
                j.about_company, j.company_name, j.industry,
                c.name as company_display_name, c.logo_url as company_logo, c.slug as company_slug,
                u.full_name as sent_by_name, u.avatar_url as sent_by_avatar
            FROM job_offers jo
            JOIN jobs j ON jo.job_id = j.job_id
            JOIN companies c ON jo.company_id = c.company_id
            LEFT JOIN users u ON jo.sent_by = u.user_id
            WHERE jo.offer_id = $1 AND (jo.user_id = $2 OR jo.company_id IN (
                SELECT company_id FROM company_members WHERE user_id = $2
            ))`,
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
 * See if a company has already sent a pending offer to a specific user
 */
exports.checkOfferStatus = async (req, res) => {
    const { companyId, targetUserId } = req.params;

    try {
        const result = await pool.query(
            `SELECT job_id FROM job_offers 
             WHERE company_id = $1 AND user_id = $2 AND status = 'pending'`,
            [companyId, targetUserId]
        );

        res.json({
            sent: result.rowCount > 0,
            jobIds: result.rows.map(r => r.job_id)
        });
    } catch (err) {
        console.error("Check offer status error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};
