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
            const result = await pool.query(
                `SELECT events_enabled, jobs_enabled, posts_enabled,
                        messages_enabled, messages_chat_enabled, messages_jobs_enabled, email_enabled, push_enabled
                 FROM organization_notification_settings WHERE org_id = $1`,
                [orgId]
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
                        push_notifications: true,
                    },
                });
            }

            const row = result.rows[0];
            // all_notifications reflects all primary and sub-preferences
            const allEnabled =
                (row.posts_enabled ?? true) &&
                (row.jobs_enabled ?? true) &&
                (row.messages_enabled ?? true) &&
                (row.messages_chat_enabled ?? true) &&
                (row.messages_jobs_enabled ?? true) &&
                (row.email_enabled ?? true) &&
                (row.push_enabled ?? true);

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
                    push_notifications: row.push_enabled ?? true,
                },
            });
        }

        // Default: Personal User Actor
        const userId = req.user.sub;
        const result = await pool.query(
            `SELECT all_notifications, post_notifications, job_alerts, message_notifications, email_notifications, push_notifications
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
                    push_notifications: true,
                },
            });
        }

        const prefs = result.rows[0];
        return res.status(200).json({
            success: true,
            preferences: {
                ...prefs,
                all: prefs.all_notifications ?? true,
                posts: prefs.post_notifications ?? true,
                jobs: prefs.job_alerts ?? true,
                messages: prefs.message_notifications ?? true,
                emails: prefs.email_notifications ?? true,
                push: prefs.push_notifications ?? true,
            },
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

            const body = req.body || {};
            const masterToggle = body.all_notifications !== undefined ? body.all_notifications : null;

            // If masterToggle is set, default unset children to masterToggle; otherwise keep null for COALESCE preservation
            const post_notifications = body.post_notifications !== undefined 
                ? body.post_notifications 
                : (masterToggle !== null ? masterToggle : null);
            const job_alerts = body.job_alerts !== undefined 
                ? body.job_alerts 
                : (masterToggle !== null ? masterToggle : null);
            const message_notifications = body.message_notifications !== undefined 
                ? body.message_notifications 
                : (masterToggle !== null ? masterToggle : null);
            const messages_chat_enabled = body.messages_chat_enabled !== undefined 
                ? body.messages_chat_enabled 
                : (masterToggle !== null ? masterToggle : null);
            const messages_jobs_enabled = body.messages_jobs_enabled !== undefined 
                ? body.messages_jobs_enabled 
                : (masterToggle !== null ? masterToggle : null);
            const email_notifications = body.email_notifications !== undefined 
                ? body.email_notifications 
                : (masterToggle !== null ? masterToggle : null);
            const push_notifications = body.push_notifications !== undefined 
                ? body.push_notifications 
                : (masterToggle !== null ? masterToggle : null);

            // Fetch previous settings to detect which notification setting changed
            const prevResult = await pool.query(
                `SELECT * FROM organization_notification_settings WHERE org_id = $1`,
                [orgId]
            );
            const prevRow = prevResult.rows[0] || {};
            const prevPosts = prevRow.posts_enabled ?? true;
            const prevJobs = prevRow.jobs_enabled ?? true;
            const prevMessages = prevRow.messages_enabled ?? true;
            const prevChat = prevRow.messages_chat_enabled ?? true;
            const prevMsgJobs = prevRow.messages_jobs_enabled ?? true;
            const prevEmail = prevRow.email_enabled ?? true;
            const prevAll = prevPosts && prevJobs && prevMessages && prevChat && prevMsgJobs && prevEmail;

            // Safe upsert using COALESCE so partial updates do not overwrite omitted fields with defaults
            // org_id is PRIMARY KEY; user_id stores the user who made the update
            const result = await pool.query(
                `INSERT INTO organization_notification_settings
                    (org_id, user_id, events_enabled, jobs_enabled, posts_enabled, messages_enabled, messages_chat_enabled, messages_jobs_enabled, email_enabled, push_enabled, updated_at)
                 VALUES ($1, $2, COALESCE($3, true), COALESCE($4, true), COALESCE($5, true), COALESCE($6, true), COALESCE($7, true), COALESCE($8, true), COALESCE($9, true), COALESCE($10, true), NOW())
                 ON CONFLICT (org_id) DO UPDATE SET
                    user_id = $2,
                    events_enabled = COALESCE($3, organization_notification_settings.events_enabled),
                    jobs_enabled = COALESCE($4, organization_notification_settings.jobs_enabled),
                    posts_enabled = COALESCE($5, organization_notification_settings.posts_enabled),
                    messages_enabled = COALESCE($6, organization_notification_settings.messages_enabled),
                    messages_chat_enabled = COALESCE($7, organization_notification_settings.messages_chat_enabled),
                    messages_jobs_enabled = COALESCE($8, organization_notification_settings.messages_jobs_enabled),
                    email_enabled = COALESCE($9, organization_notification_settings.email_enabled),
                    push_enabled = COALESCE($10, organization_notification_settings.push_enabled),
                    updated_at = NOW()
                 RETURNING *`,
                [orgId, userId, masterToggle, job_alerts, post_notifications, message_notifications, messages_chat_enabled, messages_jobs_enabled, email_notifications, push_notifications]
            );

            const row = result.rows[0];
            const allEnabled =
                (row.posts_enabled ?? true) &&
                (row.jobs_enabled ?? true) &&
                (row.messages_enabled ?? true) &&
                (row.messages_chat_enabled ?? true) &&
                (row.messages_jobs_enabled ?? true) &&
                (row.email_enabled ?? true) &&
                (row.push_enabled ?? true);

            const updatedPreferences = {
                all_notifications: allEnabled,
                post_notifications: row.posts_enabled ?? true,
                job_alerts: row.jobs_enabled ?? true,
                message_notifications: row.messages_enabled ?? true,
                messages_chat_enabled: row.messages_chat_enabled ?? true,
                messages_jobs_enabled: row.messages_jobs_enabled ?? true,
                email_notifications: row.email_enabled ?? true,
                push_notifications: row.push_enabled ?? true,
            };

            // Detect which notification setting was toggled and whether it was turned on or off
            let changedItem = null;

            // 1. Check if the master "All notifications" toggle was clicked
            if (body.all_notifications !== undefined && body.all_notifications !== prevAll) {
                const targetState = Boolean(body.all_notifications);
                const allSynced = (row.posts_enabled === targetState) &&
                                  (row.jobs_enabled === targetState) &&
                                  (row.messages_enabled === targetState) &&
                                  (row.email_enabled === targetState);
                if (allSynced) {
                    changedItem = {
                        key: 'all_notifications',
                        label: 'all notifications',
                        state: targetState ? 'on' : 'off',
                        oldValue: prevAll,
                        newValue: targetState
                    };
                }
            }

            // 2. Check individual settings if master toggle wasn't the sole trigger
            if (!changedItem) {
                if (body.post_notifications !== undefined && body.post_notifications !== prevPosts) {
                    changedItem = {
                        key: 'post_notifications',
                        label: 'post notifications',
                        state: body.post_notifications ? 'on' : 'off',
                        oldValue: prevPosts,
                        newValue: Boolean(body.post_notifications)
                    };
                } else if (body.job_alerts !== undefined && body.job_alerts !== prevJobs) {
                    changedItem = {
                        key: 'job_alerts',
                        label: 'job alerts',
                        state: body.job_alerts ? 'on' : 'off',
                        oldValue: prevJobs,
                        newValue: Boolean(body.job_alerts)
                    };
                } else if (body.messages_chat_enabled !== undefined && body.messages_chat_enabled !== prevChat) {
                    changedItem = {
                        key: 'messages_chat_enabled',
                        label: 'chat message notifications',
                        state: body.messages_chat_enabled ? 'on' : 'off',
                        oldValue: prevChat,
                        newValue: Boolean(body.messages_chat_enabled)
                    };
                } else if (body.messages_jobs_enabled !== undefined && body.messages_jobs_enabled !== prevMsgJobs) {
                    changedItem = {
                        key: 'messages_jobs_enabled',
                        label: 'job message notifications',
                        state: body.messages_jobs_enabled ? 'on' : 'off',
                        oldValue: prevMsgJobs,
                        newValue: Boolean(body.messages_jobs_enabled)
                    };
                } else if (body.message_notifications !== undefined && body.message_notifications !== prevMessages) {
                    changedItem = {
                        key: 'message_notifications',
                        label: 'message notifications',
                        state: body.message_notifications ? 'on' : 'off',
                        oldValue: prevMessages,
                        newValue: Boolean(body.message_notifications)
                    };
                } else if (body.email_notifications !== undefined && body.email_notifications !== prevEmail) {
                    changedItem = {
                        key: 'email_notifications',
                        label: 'email notifications',
                        state: body.email_notifications ? 'on' : 'off',
                        oldValue: prevEmail,
                        newValue: Boolean(body.email_notifications)
                    };
                } else if (body.all_notifications !== undefined && body.all_notifications !== prevAll) {
                    changedItem = {
                        key: 'all_notifications',
                        label: 'all notifications',
                        state: body.all_notifications ? 'on' : 'off',
                        oldValue: prevAll,
                        newValue: Boolean(body.all_notifications)
                    };
                }
            }

            // Fallback default
            if (!changedItem) {
                changedItem = {
                    key: 'notifications',
                    label: 'company notification preferences',
                    state: allEnabled ? 'on' : 'off',
                    oldValue: prevAll,
                    newValue: allEnabled
                };
            }

            // Log Audit Entry
            await logAudit(pool, {
                entityId: orgId,
                entityType: 'ORGANIZATION',
                actorId: userId,
                actorRole: req.actor?.roleName || null,
                action: 'ORGANIZATION_NOTIFICATIONS_UPDATED',
                metadata: {
                    settingKey: changedItem.key,
                    settingLabel: changedItem.label,
                    state: changedItem.state,
                    oldValue: changedItem.oldValue,
                    newValue: changedItem.newValue,
                    preferences: updatedPreferences
                }
            });

            // Emit Real-time Socket Event
            if (socketService.io) {
                socketService.io.to(`org_${orgId}`).emit("ORGANIZATION_NOTIFICATIONS_UPDATED", {
                    orgId,
                    preferences: updatedPreferences
                });
                socketService.io.emit("company_notifications_updated", {
                    orgId,
                    preferences: updatedPreferences
                });
            }

            return res.status(200).json({
                success: true,
                message: "Organization notification preferences updated",
                preferences: updatedPreferences,
            });
        }

        // Personal User Context Branching
        const userId = req.user.sub;
        const body = req.body || {};

        const all_notifications = body.all_notifications !== undefined ? body.all_notifications : (body.all !== undefined ? body.all : null);
        const post_notifications = body.post_notifications !== undefined ? body.post_notifications : (body.posts !== undefined ? body.posts : null);
        const job_alerts = body.job_alerts !== undefined ? body.job_alerts : (body.jobs !== undefined ? body.jobs : null);
        const message_notifications = body.message_notifications !== undefined ? body.message_notifications : (body.messages !== undefined ? body.messages : null);
        const email_notifications = body.email_notifications !== undefined ? body.email_notifications : (body.emails !== undefined ? body.emails : null);
        const push_notifications = body.push_notifications !== undefined ? body.push_notifications : (body.push !== undefined ? body.push : null);

        const result = await pool.query(
            `INSERT INTO user_notification_preferences
                (user_id, all_notifications, post_notifications, job_alerts, message_notifications, email_notifications, push_notifications, updated_at)
             VALUES ($1, COALESCE($2, true), COALESCE($3, true), COALESCE($4, true), COALESCE($5, true), COALESCE($6, true), COALESCE($7, true), NOW())
             ON CONFLICT (user_id) DO UPDATE SET
                all_notifications = COALESCE($2, user_notification_preferences.all_notifications),
                post_notifications = COALESCE($3, user_notification_preferences.post_notifications),
                job_alerts = COALESCE($4, user_notification_preferences.job_alerts),
                message_notifications = COALESCE($5, user_notification_preferences.message_notifications),
                email_notifications = COALESCE($6, user_notification_preferences.email_notifications),
                push_notifications = COALESCE($7, user_notification_preferences.push_notifications),
                updated_at = NOW()
             RETURNING all_notifications, post_notifications, job_alerts, message_notifications, email_notifications, push_notifications`,
            [userId, all_notifications, post_notifications, job_alerts, message_notifications, email_notifications, push_notifications]
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
