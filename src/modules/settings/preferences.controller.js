const pool = require("../../core/db/pool");
const { logAudit } = require("../../services/audit.service");
const socketService = require("../../core/infrastructure/socket.service");

// ─── 1. Appearance (Device-Scoped — Pure Local Storage / Client State) ─────────

exports.getAppearance = async (req, res) => {
    try {
        const userId = req.user.sub;
        const result = await pool.query(
            "SELECT theme_preference FROM users WHERE user_id = $1",
            [userId]
        );

        return res.status(200).json({
            success: true,
            theme: result.rows[0]?.theme_preference || "system",
        });
    } catch (error) {
        console.error("Get appearance error:", error);
        return res.status(500).json({ success: false, message: "Failed to fetch appearance settings" });
    }
};

exports.updateAppearance = async (req, res) => {
    try {
        const { theme } = req.body;

        if (!["system", "light", "dark"].includes(theme)) {
            return res.status(400).json({ success: false, message: "Theme must be system, light, or dark" });
        }

        // Appearance is device-scoped. DB persistence is deprecated to support pure client-side theme switching.
        return res.status(200).json({
            success: true,
            message: "Appearance preference updated (device-scoped)",
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
        // Check if request is acting as Organization actor
        if (req.actor && req.actor.type === "ORGANIZATION") {
            const orgId = req.actor.orgId;
            const userId = req.user.sub;
            const result = await pool.query(
                `SELECT events_enabled, jobs_enabled, posts_enabled,
                        messages_enabled, messages_chat_enabled, messages_jobs_enabled, email_enabled
                 FROM organization_notification_preferences WHERE user_id = $1 AND org_id = $2`,
                [userId, orgId]
            );

            if (result.rowCount === 0) {
                return res.status(200).json({
                    success: true,
                    preferences: {
                        all_notifications: true,
                        post_notifications: true,
                        job_alerts: true,
                        message_notifications: true,
                        messages_chat_enabled: true,
                        messages_jobs_enabled: true,
                        email_notifications: true,
                    },
                });
            }

            const row = result.rows[0];
            // Fix Bug 3: all_notifications must reflect ALL sub-preferences, not just posts+jobs+events
            const allEnabled =
                (row.posts_enabled ?? true) &&
                (row.jobs_enabled ?? true) &&
                (row.messages_enabled ?? true) &&
                (row.email_enabled ?? true);

            return res.status(200).json({
                success: true,
                preferences: {
                    all_notifications: allEnabled,
                    post_notifications: row.posts_enabled ?? true,
                    job_alerts: row.jobs_enabled ?? true,
                    message_notifications: row.messages_enabled ?? true,
                    messages_chat_enabled: row.messages_chat_enabled ?? true,
                    messages_jobs_enabled: row.messages_jobs_enabled ?? true,
                    email_notifications: row.email_enabled ?? true,
                },
            });
        }

        // Default: Personal User Actor
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
        // Organization Context Branching
        if (req.actor && req.actor.type === "ORGANIZATION") {
            const orgId = req.actor.orgId;
            const userId = req.user.sub;

            // Check permissions: Owner or member with SETTINGS permission
            const isOwner = req.actor.roleName === 'Owner' || req.actor.permissions.includes('*');
            const hasSettingsPerm = req.actor.permissions.some(p => ['SETTINGS', 'MANAGE_SETTINGS', 'MANAGE_COMPANY', 'MANAGE_INSTITUTION'].includes(p.toUpperCase()));
            
            if (!isOwner && !hasSettingsPerm) {
                return res.status(403).json({ success: false, message: "You do not have permission to manage organization notification settings" });
            }

            const {
                all_notifications = true,
                post_notifications = true,
                job_alerts = true,
                message_notifications = true,
                messages_chat_enabled = true,
                messages_jobs_enabled = true,
                email_notifications = true,
            } = req.body;

            // Fix ON CONFLICT error (42P10): Table has primary key (user_id, org_id)
            await pool.query(
                `INSERT INTO organization_notification_preferences
                    (user_id, org_id, events_enabled, jobs_enabled, posts_enabled, messages_enabled, messages_chat_enabled, messages_jobs_enabled, email_enabled, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
                 ON CONFLICT (user_id, org_id) DO UPDATE SET
                    events_enabled = EXCLUDED.events_enabled,
                    jobs_enabled = EXCLUDED.jobs_enabled,
                    posts_enabled = EXCLUDED.posts_enabled,
                    messages_enabled = EXCLUDED.messages_enabled,
                    messages_chat_enabled = EXCLUDED.messages_chat_enabled,
                    messages_jobs_enabled = EXCLUDED.messages_jobs_enabled,
                    email_enabled = EXCLUDED.email_enabled,
                    updated_at = NOW()`,
                [userId, orgId, all_notifications, job_alerts, post_notifications, message_notifications, messages_chat_enabled, messages_jobs_enabled, email_notifications]
            );

            // Log Audit Entry
            await logAudit(pool, {
                entityId: orgId,
                entityType: 'ORGANIZATION',
                actorId: userId,
                action: 'ORGANIZATION_NOTIFICATIONS_UPDATED',
                metadata: { all_notifications, post_notifications, job_alerts, message_notifications, messages_chat_enabled, messages_jobs_enabled, email_notifications }
            });

            // Emit Real-time Socket Event
            if (socketService.io) {
                socketService.io.to(`org_${orgId}`).emit("ORGANIZATION_NOTIFICATIONS_UPDATED", {
                    orgId,
                    preferences: { all_notifications, post_notifications, job_alerts, message_notifications, messages_chat_enabled, messages_jobs_enabled, email_notifications }
                });
            }

            return res.status(200).json({
                success: true,
                message: "Organization notification preferences updated",
                preferences: req.body,
            });
        }

        // Personal User Context Branching
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

        const savedPrefs = result.rows[0];

        // Fix Bug 4: Emit socket event so other open tabs/windows refresh their cached prefs
        // This ensures preference changes are reflected immediately across all sessions
        socketService.notifyUser(userId, "USER_NOTIFICATIONS_UPDATED", {
            preferences: savedPrefs
        });

        return res.status(200).json({
            success: true,
            message: "Notification preferences updated",
            preferences: savedPrefs,
        });
    } catch (error) {
        console.error("Update notification preferences error:", error);
        return res.status(500).json({ success: false, message: "Failed to update notification preferences" });
    }
};

// ─── 3. Privacy & Security Settings ──────────────────────────────────────────

exports.getPrivacySettings = async (req, res) => {
    try {
        // Organization Context Branching
        if (req.actor && req.actor.type === "ORGANIZATION") {
            const orgId = req.actor.orgId;
            const result = await pool.query(
                `SELECT show_email, show_phone, tag_permission,
                        following_visibility, followers_visibility, message_permission
                 FROM organization_privacy_settings WHERE org_id = $1`,
                [orgId]
            );

            if (result.rowCount === 0) {
                return res.status(200).json({
                    success: true,
                    privacy: {
                        show_email: true,
                        show_phone: true,
                        showEmail: true,
                        showPhone: true,
                        tag_permission: "everyone",
                        tagPermission: "everyone",
                        following_visibility: "everyone",
                        followingVisibility: "everyone",
                        followers_visibility: "everyone",
                        followersVisibility: "everyone",
                        message_permission: "everyone",
                        messagePermission: "everyone",
                    },
                });
            }

            const row = result.rows[0];
            const showEmail = row.show_email ?? true;
            const showPhone = row.show_phone ?? true;
            const tagPermission = row.tag_permission || "everyone";
            const followingVisibility = row.following_visibility || "everyone";
            const followersVisibility = row.followers_visibility || "everyone";
            const messagePermission = row.message_permission || "everyone";

            return res.status(200).json({
                success: true,
                privacy: {
                    show_email: showEmail,
                    show_phone: showPhone,
                    showEmail,
                    showPhone,
                    tag_permission: tagPermission,
                    tagPermission,
                    following_visibility: followingVisibility,
                    followingVisibility,
                    followers_visibility: followersVisibility,
                    followersVisibility,
                    message_permission: messagePermission,
                    messagePermission,
                },
            });
        }

        // Personal User Context Branching
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
        const showEmail = row.profile_show_email || false;
        const showPhone = row.profile_show_phone || false;
        const tagPermission = row.tag_permission || "everyone";

        return res.status(200).json({
            success: true,
            privacy: {
                show_email: showEmail,
                show_phone: showPhone,
                showEmail,
                showPhone,
                tag_permission: tagPermission,
                tagPermission,
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
        // Organization Context Branching
        if (req.actor && req.actor.type === "ORGANIZATION") {
            const orgId = req.actor.orgId;
            const userId = req.user.sub;

            // Check if user created the organization or is owner/has settings permission
            const orgCheck = await pool.query("SELECT created_by FROM organizations WHERE org_id = $1", [orgId]);
            const isCreatedBy = orgCheck.rows[0]?.created_by === userId;
            const isOwner = isCreatedBy || req.actor.roleName === 'Owner' || (req.actor.permissions && req.actor.permissions.includes('*'));
            const hasSettingsPerm = (req.actor.permissions || []).some(p => ['SETTINGS', 'MANAGE_SETTINGS', 'PRIVACY', 'MANAGE_PRIVACY', 'MANAGE_COMPANY', 'MANAGE_INSTITUTION', 'MANAGE_ORGANIZATION'].includes(p.toUpperCase()));

            if (!isOwner && !hasSettingsPerm) {
                return res.status(403).json({ success: false, message: "You do not have permission to manage organization privacy settings" });
            }

            // Fetch existing settings to support partial updates
            const existingRes = await pool.query(
                "SELECT show_email, show_phone, tag_permission, following_visibility, followers_visibility, message_permission FROM organization_privacy_settings WHERE org_id = $1",
                [orgId]
            );
            const current = existingRes.rows[0] || {};

            const show_email = req.body.show_email !== undefined ? req.body.show_email : (req.body.showEmail !== undefined ? req.body.showEmail : (current.show_email ?? true));
            const show_phone = req.body.show_phone !== undefined ? req.body.show_phone : (req.body.showPhone !== undefined ? req.body.showPhone : (current.show_phone ?? true));
            const tag_permission = req.body.tag_permission || req.body.tagPermission || current.tag_permission || "everyone";
            const following_visibility = req.body.following_visibility || req.body.followingVisibility || current.following_visibility || "everyone";
            const followers_visibility = req.body.followers_visibility || req.body.followersVisibility || current.followers_visibility || "everyone";
            const message_permission = req.body.message_permission || req.body.messagePermission || current.message_permission || "everyone";

            // Validate 3-option tag scale for organization
            if (tag_permission && !["everyone", "followers_only", "no_one"].includes(tag_permission)) {
                return res.status(400).json({ success: false, message: "Invalid tag_permission for organization (allowed: everyone, followers_only, no_one)" });
            }

            await pool.query(
                `INSERT INTO organization_privacy_settings
                    (org_id, show_email, show_phone, tag_permission, following_visibility, followers_visibility, message_permission, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
                 ON CONFLICT (org_id) DO UPDATE SET
                    show_email = EXCLUDED.show_email,
                    show_phone = EXCLUDED.show_phone,
                    tag_permission = EXCLUDED.tag_permission,
                    following_visibility = EXCLUDED.following_visibility,
                    followers_visibility = EXCLUDED.followers_visibility,
                    message_permission = EXCLUDED.message_permission,
                    updated_at = NOW()`,
                [orgId, show_email, show_phone, tag_permission, following_visibility, followers_visibility, message_permission]
            );

            // Log Audit Entry
            await logAudit(pool, {
                entityId: orgId,
                entityType: 'ORGANIZATION',
                actorId: userId,
                action: 'ORGANIZATION_PRIVACY_UPDATED',
                metadata: { show_email, show_phone, tag_permission, following_visibility, followers_visibility, message_permission }
            });

            // Emit Socket IO Event
            if (socketService.io) {
                const payload = {
                    orgId,
                    privacy: { show_email, show_phone, showEmail: show_email, showPhone: show_phone, tag_permission, following_visibility, followers_visibility, message_permission }
                };
                socketService.io.to(`org_${orgId}`).emit("ORGANIZATION_PRIVACY_UPDATED", payload);
                socketService.io.emit("company_privacy_updated", payload);
            }

            return res.status(200).json({
                success: true,
                message: "Organization privacy settings updated",
                privacy: { show_email, show_phone, showEmail: show_email, showPhone: show_phone, tag_permission, following_visibility, followers_visibility, message_permission },
            });
        }

        // Personal User Context Branching
        const userId = req.user.sub;
        const show_email = req.body.show_email !== undefined ? req.body.show_email : req.body.showEmail;
        const show_phone = req.body.show_phone !== undefined ? req.body.show_phone : req.body.showPhone;
        const tag_permission = req.body.tag_permission || req.body.tagPermission;

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

        const updatedRow = result.rows[0] || {};

        return res.status(200).json({
            success: true,
            message: "Privacy settings updated",
            privacy: {
                ...updatedRow,
                showEmail: updatedRow.show_email,
                showPhone: updatedRow.show_phone,
                tagPermission: updatedRow.tag_permission,
            },
        });
    } catch (error) {
        console.error("Update privacy settings error:", error);
        return res.status(500).json({ success: false, message: "Failed to update privacy settings" });
    }
};
