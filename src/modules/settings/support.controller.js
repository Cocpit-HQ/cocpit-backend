const pool = require("../../core/db/pool");
const socketService = require("../../core/infrastructure/socket.service");
const APP_VERSION = require("../../../package.json").version;

// ─── 1. Support Tickets ────────────────────────────────────────────────────────

exports.createTicket = async (req, res) => {
    try {
        const userId = req.user?.sub || null;
        const { email, description } = req.body;
        const attachment_url = req.file ? req.file.path : null;

        if (!email || !description) {
            return res.status(400).json({ success: false, message: "Email and description are required" });
        }

        const result = await pool.query(
            `INSERT INTO support_tickets (user_id, email, description, attachment_url)
             VALUES ($1, $2, $3, $4)
             RETURNING ticket_id, status, created_at`,
            [userId, email, description, attachment_url]
        );

        return res.status(201).json({
            success: true,
            message: "Support ticket created successfully",
            ticket: result.rows[0],
        });
    } catch (error) {
        console.error("Create ticket error:", error);
        return res.status(500).json({ success: false, message: "Failed to submit support ticket" });
    }
};

// ─── 2. User Feedback ─────────────────────────────────────────────────────────

exports.submitFeedback = async (req, res) => {
    try {
        const userId = req.user?.sub || null;
        const { rating, comment, app_version } = req.body;

        if (!rating || rating < 1 || rating > 5) {
            return res.status(400).json({ success: false, message: "Rating must be an integer between 1 and 5" });
        }
        if (!app_version) {
            return res.status(400).json({ success: false, message: "App version is required" });
        }

        const result = await pool.query(
            `INSERT INTO user_feedback (user_id, rating, comment, app_version)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (user_id, app_version) DO UPDATE SET
                rating = EXCLUDED.rating,
                comment = EXCLUDED.comment,
                created_at = NOW()
             RETURNING feedback_id, rating, comment, app_version`,
            [userId, rating, comment || null, app_version]
        );

        // Emit real-time event so all connected clients (web, mobile) can hide the feedback UI
        if (userId) {
            socketService.notifyUser(userId, "FEEDBACK_SUBMITTED", {
                userId,
                app_version,
                has_submitted_feedback: true,
            });
        }

        return res.status(200).json({
            success: true,
            message: "Feedback submitted successfully",
            feedback: result.rows[0],
        });
    } catch (error) {
        console.error("Submit feedback error:", error);
        return res.status(500).json({ success: false, message: "Failed to submit feedback" });
    }
};

exports.getVersion = async (req, res) => {
    try {
        const version = `v${APP_VERSION}`;
        const userId = req.user?.sub || null;

        let hasFeedback = false;
        if (userId) {
            const fbRes = await pool.query(
                `SELECT 1 FROM user_feedback WHERE user_id = $1 AND app_version = $2 LIMIT 1`,
                [userId, version]
            );
            hasFeedback = fbRes.rowCount > 0;
        }

        return res.status(200).json({
            success: true,
            version,
            build: process.env.APP_BUILD || new Date().toISOString().slice(0, 10),
            has_submitted_feedback: hasFeedback,
        });
    } catch (error) {
        console.error("Get version error:", error);
        return res.status(500).json({ success: false, message: "Failed to fetch version info" });
    }
};


exports.getFaqs = (req, res) => {
    const faqs = [
        {
            question: "How do I change my primary email address?",
            answer: "Go to Settings > Account > Manage Email. You will be guided through a 4-step verification process verifying both your current and new email address via OTP.",
        },
        {
            question: "What happens when I delete my account?",
            answer: "Your account enters a 40-day recovery period. Within 40 days, you can restore your account via the link sent to your email. After 40 days, all data is permanently purged.",
        },
        {
            question: "Who can tag me in posts?",
            answer: "You can control who tags you under Settings > Privacy & Security. Choose between Everyone, Connections Only, Followers Only, or No One.",
        },
        {
            question: "How do saved posts collections work?",
            answer: "You can create custom collections to group your saved posts. A default 'General' collection is always present.",
        },
    ];

    return res.status(200).json({ success: true, faqs });
};

// ─── 4. Legal & Privacy Links ──────────────────────────────────────────────────

exports.getLegalDocs = (req, res) => {
    const docs = [
        { title: "Privacy Policy", url: "https://cocpit.in/privacy" },
        { title: "Terms of Service", url: "https://cocpit.in/terms" },
        { title: "Community Guidelines", url: "https://cocpit.in/community" },
        { title: "Cookie Policy", url: "https://cocpit.in/cookies" },
    ];

    return res.status(200).json({ success: true, docs });
};

// ─── 5. Your Reports History (Reporter-facing) ──────────────────────────────────

exports.getMyReports = async (req, res) => {
    try {
        const userId = req.user.sub;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;

        const countRes = await pool.query("SELECT COUNT(*) FROM reports WHERE reporter_id = $1", [userId]);
        const total = parseInt(countRes.rows[0].count);

        const result = await pool.query(
            `SELECT r.id, r.target_type, r.target_id, r.custom_reason, r.created_at,
                    rr.label AS reason_label
             FROM reports r
             LEFT JOIN report_reasons rr ON r.reason_id = rr.id
             WHERE r.reporter_id = $1
             ORDER BY r.created_at DESC
             LIMIT $2 OFFSET $3`,
            [userId, limit, offset]
        );

        return res.status(200).json({
            success: true,
            reports: result.rows,
            pagination: {
                page,
                limit,
                total,
                hasMore: offset + result.rows.length < total,
            },
        });
    } catch (error) {
        console.error("Get my reports error:", error);
        return res.status(500).json({ success: false, message: "Failed to fetch reports history" });
    }
};

exports.getMyReportById = async (req, res) => {
    try {
        const userId = req.user.sub;
        const { reportId } = req.params;

        const result = await pool.query(
            `SELECT r.id, r.target_type, r.target_id, r.custom_reason, r.created_at,
                    rr.label AS reason_label
             FROM reports r
             LEFT JOIN report_reasons rr ON r.reason_id = rr.id
             WHERE r.id = $1 AND r.reporter_id = $2`,
            [reportId, userId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, message: "Report not found" });
        }

        return res.status(200).json({
            success: true,
            report: result.rows[0],
        });
    } catch (error) {
        console.error("Get report by ID error:", error);
        return res.status(500).json({ success: false, message: "Failed to fetch report detail" });
    }
};
