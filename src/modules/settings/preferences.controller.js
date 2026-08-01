const pool = require("../../core/db/pool");

// ─── 1. Appearance ─────────────────────────────────────────────────────────────

exports.getAppearance = async (req, res) => {
    try {
        const userId = req.user.sub;
        const result = await pool.query(
            "SELECT theme_preference FROM users WHERE user_id = $1",
            [userId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        return res.status(200).json({
            success: true,
            theme: result.rows[0].theme_preference || "system",
        });
    } catch (error) {
        console.error("Get appearance error:", error);
        return res.status(500).json({ success: false, message: "Failed to fetch appearance settings" });
    }
};

exports.updateAppearance = async (req, res) => {
    try {
        const userId = req.user.sub;
        const { theme } = req.body;

        if (!["system", "light", "dark"].includes(theme)) {
            return res.status(400).json({ success: false, message: "Theme must be system, light, or dark" });
        }

        await pool.query(
            "UPDATE users SET theme_preference = $1, updated_at = NOW() WHERE user_id = $2",
            [theme, userId]
        );

        return res.status(200).json({
            success: true,
            message: "Appearance preference updated",
            theme,
        });
    } catch (error) {
        console.error("Update appearance error:", error);
        return res.status(500).json({ success: false, message: "Failed to update appearance settings" });
    }
};

// ─── 2. Notification Preferences ─────────────────────────────────────────────

exports.getNotificationPreferences = async (req, res) => {
    try {
        const userId = req.user.sub;
        const result = await pool.query(
            `SELECT all_notifications, post_notifications, job_alerts, message_notifications, email_notifications
             FROM user_notification_preferences WHERE user_id = $1`,
            [userId]
        );

        if (result.rowCount === 0) {
            return res.status(200).json({
                success: true,
                preferences: {
                    all_notifications: true,
                    post_notifications: true,
                    job_alerts: true,
                    message_notifications: true,
                    email_notifications: true,
                },
            });
        }

        return res.status(200).json({
            success: true,
            preferences: result.rows[0],
        });
    } catch (error) {
        console.error("Get notification preferences error:", error);
        return res.status(500).json({ success: false, message: "Failed to fetch notification preferences" });
    }
};

exports.updateNotificationPreferences = async (req, res) => {
    try {
        const userId = req.user.sub;
        const {
            all_notifications = true,
            post_notifications = true,
            job_alerts = true,
            message_notifications = true,
            email_notifications = true,
        } = req.body;

        const result = await pool.query(
            `INSERT INTO user_notification_preferences
                (user_id, all_notifications, post_notifications, job_alerts, message_notifications, email_notifications, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW())
             ON CONFLICT (user_id) DO UPDATE SET
                all_notifications = EXCLUDED.all_notifications,
                post_notifications = EXCLUDED.post_notifications,
                job_alerts = EXCLUDED.job_alerts,
                message_notifications = EXCLUDED.message_notifications,
                email_notifications = EXCLUDED.email_notifications,
                updated_at = NOW()
             RETURNING all_notifications, post_notifications, job_alerts, message_notifications, email_notifications`,
            [userId, all_notifications, post_notifications, job_alerts, message_notifications, email_notifications]
        );

        return res.status(200).json({
            success: true,
            message: "Notification preferences updated",
            preferences: result.rows[0],
        });
    } catch (error) {
        console.error("Update notification preferences error:", error);
        return res.status(500).json({ success: false, message: "Failed to update notification preferences" });
    }
};

// ─── 3. Privacy & Security Settings ──────────────────────────────────────────

exports.getPrivacySettings = async (req, res) => {
    try {
        const userId = req.user.sub;
        const result = await pool.query(
            `SELECT email, mobile_number, recovery_email,
                    profile_show_email, profile_show_phone, tag_permission
             FROM users WHERE user_id = $1`,
            [userId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        const row = result.rows[0];

        return res.status(200).json({
            success: true,
            privacy: {
                show_email: row.profile_show_email || false,
                show_phone: row.profile_show_phone || false,
                tag_permission: row.tag_permission || "everyone",
                email: row.email,
                mobile_number: row.mobile_number,
                recovery_email: row.recovery_email,
            },
        });
    } catch (error) {
        console.error("Get privacy settings error:", error);
        return res.status(500).json({ success: false, message: "Failed to fetch privacy settings" });
    }
};

exports.updatePrivacySettings = async (req, res) => {
    try {
        const userId = req.user.sub;
        const { show_email, show_phone, tag_permission } = req.body;

        if (tag_permission && !["everyone", "connections_only", "followers_only", "no_one"].includes(tag_permission)) {
            return res.status(400).json({ success: false, message: "Invalid tag_permission value" });
        }

        const result = await pool.query(
            `UPDATE users SET
                profile_show_email = COALESCE($1, profile_show_email),
                profile_show_phone = COALESCE($2, profile_show_phone),
                tag_permission = COALESCE($3, tag_permission),
                updated_at = NOW()
             WHERE user_id = $4
             RETURNING profile_show_email AS show_email, profile_show_phone AS show_phone, tag_permission`,
            [show_email !== undefined ? show_email : null, show_phone !== undefined ? show_phone : null, tag_permission || null, userId]
        );

        return res.status(200).json({
            success: true,
            message: "Privacy settings updated",
            privacy: result.rows[0],
        });
    } catch (error) {
        console.error("Update privacy settings error:", error);
        return res.status(500).json({ success: false, message: "Failed to update privacy settings" });
    }
};
