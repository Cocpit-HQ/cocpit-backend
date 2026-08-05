const pool = require("../../core/db/pool");
const redisClient = require("../../core/db/redis");
const { comparePassword, hashPassword } = require("../../core/utils/password");
const { requestOTP, verifyOTP } = require("../auth/otp.service");
const emailService = require("../../core/services/email.service");
const BlockModel = require("../../models/block.model");
const { revokeOtherSessions } = require("../settings/account.service");
const { UAParser } = require("ua-parser-js");
const geoip = require("geoip-lite");
const SocketService = require("../../core/infrastructure/socket.service");

// Helper to format date relative or formatted string
function formatDate(dateStr) {
    if (!dateStr) return "";
    const date = new Date(dateStr);
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// ─── 1. Account Settings ───────────────────────────────────────────────────────

/**
 * 1.1 Fetch Account Details
 * GET /api/user/account
 */
exports.getAccountDetails = async (req, res) => {
    try {
        const userId = req.user.sub;

        const userRes = await pool.query(
            `SELECT user_id, email, recovery_email, mobile_number
             FROM users WHERE user_id = $1`,
            [userId]
        );

        if (userRes.rowCount === 0) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        const user = userRes.rows[0];

        const companyRes = await pool.query(
            `SELECT COUNT(*) FROM organizations WHERE created_by = $1 AND is_deleted = FALSE`,
            [userId]
        );
        const hasCompanyAccount = parseInt(companyRes.rows[0].count, 10) > 0;

        return res.status(200).json({
            id: user.user_id,
            email: user.email || "",
            primaryEmail: user.email || "",
            recoveryEmail: user.recovery_email || "",
            phone: user.mobile_number || "",
            hasCompanyAccount: hasCompanyAccount,
        });
    } catch (error) {
        console.error("Get account details error:", error);
        return res.status(500).json({ success: false, message: "Failed to fetch account details" });
    }
};

/**
 * 1.2 Update Primary / Recovery Email
 * PUT /api/user/email
 */
exports.updateEmail = async (req, res) => {
    try {
        const userId = req.user.sub;
        const { type, newEmail, password } = req.body;

        if (!type || !["primary", "recovery"].includes(type)) {
            return res.status(400).json({ success: false, message: "Type must be 'primary' or 'recovery'" });
        }

        if (!newEmail) {
            return res.status(400).json({ success: false, message: "newEmail is required" });
        }

        const normalizedNewEmail = newEmail.toLowerCase().trim();

        const userRes = await pool.query(
            `SELECT email, password_hash FROM users WHERE user_id = $1`,
            [userId]
        );

        if (userRes.rowCount === 0) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        const user = userRes.rows[0];

        if (type === "primary") {
            if (user.email && user.email.toLowerCase() === normalizedNewEmail) {
                return res.status(400).json({ success: false, message: "New email must be different from current email" });
            }

            const checkExists = await pool.query(`SELECT 1 FROM users WHERE LOWER(email) = $1 AND user_id != $2`, [normalizedNewEmail, userId]);
            if (checkExists.rowCount > 0) {
                return res.status(409).json({ success: false, message: "An account with this primary email already exists" });
            }

            if (user.password_hash) {
                if (!password) {
                    return res.status(400).json({ success: false, message: "Current password is required to change primary email" });
                }
                const isMatch = await comparePassword(password, user.password_hash);
                if (!isMatch) {
                    return res.status(401).json({ success: false, message: "Invalid password" });
                }
            }

            const otpResult = await requestOTP(normalizedNewEmail, "email_change");
            if (otpResult.error) {
                return res.status(otpResult.error.status).json({ success: false, message: otpResult.error.message });
            }

            if (redisClient.isOpen) {
                await redisClient.setEx(`pending_email_change:${userId}`, 600, normalizedNewEmail);
            }

            return res.status(200).json({
                success: true,
                message: "Verification email sent to new address.",
            });
        } else {
            // recovery email
            if (user.email && user.email.toLowerCase() === normalizedNewEmail) {
                return res.status(400).json({ success: false, message: "Recovery email cannot be the same as primary email" });
            }

            // Check if this recovery email is already used as recovery email by ANOTHER user account
            const checkRecoveryInUse = await pool.query(
                `SELECT 1 FROM users WHERE LOWER(recovery_email) = $1 AND user_id != $2`,
                [normalizedNewEmail, userId]
            );
            if (checkRecoveryInUse.rowCount > 0) {
                return res.status(409).json({
                    success: false,
                    message: "This recovery email is already in use by another account."
                });
            }

            const otpResult = await requestOTP(normalizedNewEmail, "recovery");
            if (otpResult.error) {
                return res.status(otpResult.error.status).json({ success: false, message: otpResult.error.message });
            }

            if (redisClient.isOpen) {
                await redisClient.setEx(`pending_recovery_email:${userId}`, 600, normalizedNewEmail);
            }

            return res.status(200).json({
                success: true,
                message: "Verification email sent to new address.",
            });
        }
    } catch (error) {
        console.error("Update email error:", error);
        return res.status(500).json({ success: false, message: "Failed to update email address" });
    }
};

/**
 * 1.3 Delete Recovery Email
 * DELETE /api/user/email/recovery
 */
exports.deleteRecoveryEmail = async (req, res) => {
    try {
        const userId = req.user.sub;

        await pool.query(
            `UPDATE users SET recovery_email = NULL, recovery_email_verified_at = NULL, updated_at = NOW() WHERE user_id = $1`,
            [userId]
        );

        return res.status(200).json({ success: true });
    } catch (error) {
        console.error("Delete recovery email error:", error);
        return res.status(500).json({ success: false, message: "Failed to delete recovery email" });
    }
};

/**
 * 1.4 Update Password
 * PUT /api/user/password
 */
exports.updatePassword = async (req, res) => {
    try {
        const userId = req.user.sub;
        const currentSessionId = req.user.sid;
        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ success: false, message: "currentPassword and newPassword are required" });
        }

        const userRes = await pool.query(
            `SELECT password_hash FROM users WHERE user_id = $1`,
            [userId]
        );

        if (userRes.rowCount === 0) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        const user = userRes.rows[0];
        if (!user.password_hash) {
            return res.status(400).json({
                success: false,
                message: "No password set on this account (OAuth login).",
            });
        }

        const isMatch = await comparePassword(currentPassword, user.password_hash);
        if (!isMatch) {
            return res.status(400).json({ success: false, message: "Current password is incorrect" });
        }

        if (currentPassword === newPassword) {
            return res.status(400).json({ success: false, message: "New password must be different from current password" });
        }

        const newHash = await hashPassword(newPassword);

        await pool.query(
            `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE user_id = $2`,
            [newHash, userId]
        );

        await revokeOtherSessions(userId, currentSessionId);

        return res.status(200).json({ success: true });
    } catch (error) {
        console.error("Update password error:", error);
        return res.status(500).json({ success: false, message: "Failed to update password" });
    }
};

/**
 * 1.6 Update Phone Number
 * PUT /api/user/phone
 */
exports.updatePhone = async (req, res) => {
    try {
        const userId = req.user.sub;
        const { phone } = req.body;

        if (phone === undefined) {
            return res.status(400).json({ success: false, message: "phone is required" });
        }

        const phoneVal = (phone === "" || phone === null) ? null : phone;

        if (phoneVal !== null) {
            const digitCount = String(phoneVal).replace(/\D/g, '').length;
            if (digitCount !== 10) {
                return res.status(400).json({ success: false, message: "Phone number must be exactly 10 digits" });
            }
        }

        await pool.query(
            `UPDATE users SET mobile_number = $1, updated_at = NOW() WHERE user_id = $2`,
            [phoneVal, userId]
        );

        return res.status(200).json({ success: true });
    } catch (error) {
        console.error("Update phone error:", error);
        return res.status(500).json({ success: false, message: "Failed to update phone number" });
    }
};

/**
 * 1.7 Remove Phone Number
 * DELETE /api/user/phone
 */
exports.removePhone = async (req, res) => {
    try {
        const userId = req.user.sub;

        await pool.query(
            `UPDATE users SET mobile_number = NULL, updated_at = NOW() WHERE user_id = $1`,
            [userId]
        );

        return res.status(200).json({ success: true });
    } catch (error) {
        console.error("Remove phone error:", error);
        return res.status(500).json({ success: false, message: "Failed to remove phone number" });
    }
};

/**
 * 1.8 Delete Account
 * DELETE /api/user/account
 */
exports.deleteAccount = async (req, res) => {
    const client = await pool.connect();
    try {
        const userId = req.user.sub;

        const deletionDate = new Date();
        deletionDate.setDate(deletionDate.getDate() + 40);

        await client.query("BEGIN");

        await client.query(
            `UPDATE users SET deletion_execute_at = $1, updated_at = NOW() WHERE user_id = $2`,
            [deletionDate, userId]
        );

        await client.query(
            `DELETE FROM refresh_tokens WHERE user_id = $1`,
            [userId]
        );

        await client.query("COMMIT");

        res.clearCookie("refreshToken");

        return res.status(200).json({
            success: true,
            message: "Account deleted successfully.",
        });
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("Delete account error:", error);
        return res.status(500).json({ success: false, message: "Failed to delete account" });
    } finally {
        client.release();
    }
};

// ─── 2. Activity Settings ───────────────────────────────────────────────────────

/**
 * 2.1 Fetch Activity Logs
 * GET /api/user/activity?type=likes|comments|tags
 */
exports.getActivityLogs = async (req, res) => {
    try {
        const userId = req.user.sub;
        const { type } = req.query;

        if (type === "comments") {
            const result = await pool.query(
                `SELECT 
                    pc.comment_id AS id,
                    pc.post_id AS "postId",
                    post_author.full_name AS "postAuthor",
                    post_author.avatar_url AS "postAuthorAvatar",
                    COALESCE(post_author.headline, 'Member') AS "postAuthorRole",
                    CASE WHEN p.post_type = 'poll' THEN COALESCE(NULLIF(p.title, ''), p.content) ELSE p.content END AS "postTitle",
                    commenter.full_name AS commenter,
                    commenter.avatar_url AS "commenterAvatar",
                    COALESCE(commenter.headline, 'Member') AS "commenterRole",
                    pc.content AS comment,
                    (SELECT COUNT(*) FROM comment_likes cl WHERE cl.comment_id = pc.comment_id) AS likes,
                    (SELECT COUNT(*) FROM post_comments sub_c WHERE sub_c.parent_id = pc.comment_id) AS replies,
                    (SELECT pm.url FROM post_media pm WHERE pm.post_id = p.post_id LIMIT 1) AS "mediaUrl",
                    CASE WHEN p.post_type IS NOT NULL THEN p.post_type::text ELSE 'text' END AS type,
                    (SELECT COUNT(*) FROM poll_votes pv WHERE pv.poll_id = (SELECT poll_id FROM post_polls pp WHERE pp.post_id = p.post_id LIMIT 1)) AS votes,
                    (SELECT (pp.created_at + COALESCE(pp.duration, '1 day')::interval > NOW()) FROM post_polls pp WHERE pp.post_id = p.post_id LIMIT 1) AS "isPollActive",
                    
                    (p.post_id IS NULL) AS "isDeleted",
                    (p.post_id IS NULL) AS is_deleted
                 FROM post_comments pc
                 LEFT JOIN posts p ON pc.post_id = p.post_id
                 LEFT JOIN active_users post_author ON p.author_id = post_author.user_id
                 LEFT JOIN active_users commenter ON pc.author_id = commenter.user_id
                 WHERE pc.author_id = $1
                 ORDER BY pc.created_at DESC
                 LIMIT 50`,
                [userId]
            );

            return res.status(200).json(result.rows);
        } else if (type === "tags") {
            const result = await pool.query(
                `SELECT 
                    pt.tag_id AS id,
                    p.post_id AS "postId",
                    u.full_name AS user,
                    u.avatar_url AS "avatarUrl",
                    COALESCE(u.headline, 'Member') AS role,
                    CASE WHEN p.post_type IS NOT NULL THEN p.post_type::text ELSE 'text' END AS type,
                    p.content AS content,
                    CASE WHEN p.post_type = 'poll' THEN COALESCE(NULLIF(p.title, ''), p.content) ELSE p.title END AS "postTitle",
                    (SELECT pm.url FROM post_media pm WHERE pm.post_id = p.post_id LIMIT 1) AS "mediaUrl",
                    (SELECT COUNT(*) FROM poll_votes pv WHERE pv.poll_id = (SELECT poll_id FROM post_polls pp WHERE pp.post_id = p.post_id LIMIT 1)) AS votes,
                    (SELECT (pp.created_at + COALESCE(pp.duration, '1 day')::interval > NOW()) FROM post_polls pp WHERE pp.post_id = p.post_id LIMIT 1) AS "isPollActive",
                    (p.post_id IS NULL) AS "isDeleted",
                    (p.post_id IS NULL) AS is_deleted
                 FROM post_tags pt
                 LEFT JOIN posts p ON pt.post_id = p.post_id
                 LEFT JOIN active_users u ON p.author_id = u.user_id
                 WHERE pt.tagged_user_id = $1 AND pt.is_active_tag = true
                 ORDER BY pt.updated_at DESC
                 LIMIT 50`,
                [userId]
            );

            return res.status(200).json(result.rows);
        } else {
            // Default: likes or fallback
            const result = await pool.query(
                `SELECT 
                    pl.post_id AS id,
                    u.full_name AS user,
                    u.avatar_url AS "avatarUrl",
                    COALESCE(u.headline, 'Member') AS role,
                    CASE WHEN p.post_type IS NOT NULL THEN p.post_type::text ELSE 'text' END AS type,
                    p.content AS content,
                    CASE WHEN p.post_type = 'poll' THEN COALESCE(NULLIF(p.title, ''), p.content) ELSE p.title END AS "postTitle",
                    (SELECT pm.url FROM post_media pm WHERE pm.post_id = p.post_id LIMIT 1) AS "mediaUrl",
                    (SELECT COUNT(*) FROM poll_votes pv WHERE pv.poll_id = (SELECT poll_id FROM post_polls pp WHERE pp.post_id = p.post_id LIMIT 1)) AS votes,
                    (SELECT (pp.created_at + COALESCE(pp.duration, '1 day')::interval > NOW()) FROM post_polls pp WHERE pp.post_id = p.post_id LIMIT 1) AS "isPollActive",
                    (p.post_id IS NULL) AS "isDeleted",
                    (p.post_id IS NULL) AS is_deleted
                 FROM (
                     SELECT post_id, MAX(created_at) as created_at
                     FROM post_likes
                     WHERE user_id = $1
                     GROUP BY post_id
                 ) pl
                 LEFT JOIN posts p ON pl.post_id = p.post_id
                 LEFT JOIN active_users u ON p.author_id = u.user_id
                 ORDER BY pl.created_at DESC
                 LIMIT 50`,
                [userId]
            );

            return res.status(200).json(result.rows);
        }
    } catch (error) {
        console.error("Get activity logs error:", error);
        return res.status(500).json({ success: false, message: "Failed to fetch activity logs" });
    }
};

/**
 * 2.2 Remove Like / Tag
 * DELETE /api/user/activity/{type}/{id}
 */
exports.removeActivity = async (req, res) => {
    try {
        const userId = req.user.sub;
        const { type, id } = req.params;

        if (type === "like") {
            await pool.query(
                `DELETE FROM post_likes WHERE post_id = $1 AND user_id = $2`,
                [id, userId]
            );
        } else if (type === "tag") {
            await pool.query(
                `UPDATE post_tags SET is_active_tag = false, updated_at = NOW()
                 WHERE (post_id::text = $1 OR tag_id::text = $1) AND tagged_user_id = $2`,
                [id, userId]
            );
        }

        return res.status(200).json({ success: true });
    } catch (error) {
        console.error("Remove activity error:", error);
        return res.status(500).json({ success: false, message: "Failed to remove activity item" });
    }
};

// ─── 3. Privacy & Security Settings ──────────────────────────────────────────

/**
 * 3.1 Fetch Privacy Settings
 * GET /api/user/privacy
 */
exports.getPrivacySettings = async (req, res) => {
    try {
        const userId = req.user.sub;
        const result = await pool.query(
            `SELECT profile_show_email, profile_show_phone, tag_permission
             FROM users WHERE user_id = $1`,
            [userId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        const row = result.rows[0];

        let tagPermission = row.tag_permission || "everyone";
        if (tagPermission === "connections_only") tagPermission = "connections";
        if (tagPermission === "followers_only") tagPermission = "followers";
        if (tagPermission === "no_one") tagPermission = "noone";

        return res.status(200).json({
            showEmail: row.profile_show_email || false,
            showPhone: row.profile_show_phone || false,
            tagPermission: tagPermission,
        });
    } catch (error) {
        console.error("Get privacy settings error:", error);
        return res.status(500).json({ success: false, message: "Failed to fetch privacy settings" });
    }
};

/**
 * 3.2 Update Privacy Settings
 * PUT /api/user/privacy
 */
exports.updatePrivacySettings = async (req, res) => {
    try {
        const userId = req.user.sub;
        const { showEmail, showPhone, tagPermission } = req.body;

        let dbTagPermission = tagPermission;
        if (tagPermission === "connections") dbTagPermission = "connections_only";
        if (tagPermission === "followers") dbTagPermission = "followers_only";
        if (tagPermission === "noone") dbTagPermission = "no_one";

        await pool.query(
            `UPDATE users SET
                profile_show_email = COALESCE($1, profile_show_email),
                profile_show_phone = COALESCE($2, profile_show_phone),
                tag_permission = COALESCE($3, tag_permission),
                updated_at = NOW()
             WHERE user_id = $4`,
            [
                showEmail !== undefined ? showEmail : null,
                showPhone !== undefined ? showPhone : null,
                dbTagPermission || null,
                userId,
            ]
        );

        if (SocketService.io) {
            SocketService.io.emit("USER_PRIVACY_UPDATED", {
                userId,
                showEmail,
                showPhone,
            });
        }

        return res.status(200).json({ success: true });
    } catch (error) {
        console.error("Update privacy settings error:", error);
        return res.status(500).json({ success: false, message: "Failed to update privacy settings" });
    }
};

/**
 * 3.3 Fetch Active Sessions
 * GET /api/user/sessions
 */
exports.getActiveSessions = async (req, res) => {
    try {
        const userId = req.user.sub;
        const currentSid = req.user.sid;

        const result = await pool.query(
            `SELECT session_id, user_agent, ip_address, created_at, expires_at
             FROM refresh_tokens
             WHERE user_id = $1 AND revoked = FALSE AND expires_at > NOW()
             ORDER BY created_at DESC`,
            [userId]
        );

        const sessions = result.rows.map((row, index) => {
            const isCurrent = row.session_id === currentSid;
            
            // Parse User-Agent for a cleaner display
            const parser = new UAParser(row.user_agent || "");
            const browser = parser.getBrowser();
            const os = parser.getOS();
            const device = parser.getDevice();
            
            let deviceName = "Web Browser";
            if (browser.name && os.name) {
                deviceName = `${browser.name} on ${os.name}`;
            } else if (os.name) {
                deviceName = os.name;
            } else if (row.user_agent) {
                // fallback to a truncated raw string if parsing totally fails
                deviceName = row.user_agent.substring(0, 30) + "...";
            }

            const isPhone = device.type === 'mobile' || device.type === 'tablet' || /mobile|iphone|android|ipad/i.test(row.user_agent || "");

            // Get Location from IP
            let locationStr = "Unknown location";
            if (row.ip_address) {
                // Strip IPv6 mapped IPv4 prefix if present (e.g. ::ffff:192.168.1.3)
                const cleanIp = row.ip_address.replace(/^::ffff:/, '');
                const geo = geoip.lookup(cleanIp);
                if (geo && geo.city && geo.country) {
                    locationStr = `${geo.city}, ${geo.country}`;
                } else {
                    locationStr = `IP: ${cleanIp}`;
                }
            }

            return {
                id: row.session_id || index + 1,
                type: isPhone ? "phone" : "laptop",
                device: deviceName,
                location: locationStr,
                createdAt: row.created_at,
                isCurrent: isCurrent,
            };
        });

        return res.status(200).json(sessions);
    } catch (error) {
        console.error("Get active sessions error:", error);
        return res.status(500).json({ success: false, message: "Failed to fetch active sessions" });
    }
};

/**
 * 3.4 Logout Specific Session
 * DELETE /api/user/sessions/{id}
 */
exports.logoutSession = async (req, res) => {
    try {
        const userId = req.user.sub;
        const { id } = req.params;

        await pool.query(
            `UPDATE refresh_tokens SET revoked = TRUE WHERE session_id = $1 AND user_id = $2`,
            [id, userId]
        );

        if (redisClient.isOpen) {
            await redisClient.setEx(`revoked_session:${id}`, 15 * 60, "1");
        }

        return res.status(200).json({ success: true });
    } catch (error) {
        console.error("Logout session error:", error);
        return res.status(500).json({ success: false, message: "Failed to logout session" });
    }
};

/**
 * 3.5 Logout All Other Sessions
 * DELETE /api/user/sessions/others
 */
exports.logoutOtherSessions = async (req, res) => {
    try {
        const userId = req.user.sub;
        const currentSid = req.user.sid;

        await revokeOtherSessions(userId, currentSid);

        return res.status(200).json({ success: true });
    } catch (error) {
        console.error("Logout other sessions error:", error);
        return res.status(500).json({ success: false, message: "Failed to logout other sessions" });
    }
};

// ─── 4. Notification Settings ───────────────────────────────────────────────────

/**
 * 4.1 Fetch Notification Preferences
 * GET /api/user/notifications/preferences
 */
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
                all: true,
                posts: true,
                jobs: true,
                messages: true,
                emails: true,
            });
        }

        const prefs = result.rows[0];

        return res.status(200).json({
            all: prefs.all_notifications ?? true,
            posts: prefs.post_notifications ?? true,
            jobs: prefs.job_alerts ?? true,
            messages: prefs.message_notifications ?? true,
            emails: prefs.email_notifications ?? true,
        });
    } catch (error) {
        console.error("Get notification preferences error:", error);
        return res.status(500).json({ success: false, message: "Failed to fetch notification preferences" });
    }
};

/**
 * 4.2 Update Notification Preferences
 * PUT /api/user/notifications/preferences
 */
exports.updateNotificationPreferences = async (req, res) => {
    try {
        const userId = req.user.sub;
        const { all = true, posts = true, jobs = true, messages = true, emails = true } = req.body;

        await pool.query(
            `INSERT INTO user_notification_preferences
                (user_id, all_notifications, post_notifications, job_alerts, message_notifications, email_notifications, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW())
             ON CONFLICT (user_id) DO UPDATE SET
                all_notifications = EXCLUDED.all_notifications,
                post_notifications = EXCLUDED.post_notifications,
                job_alerts = EXCLUDED.job_alerts,
                message_notifications = EXCLUDED.message_notifications,
                email_notifications = EXCLUDED.email_notifications,
                updated_at = NOW()`,
            [userId, all, posts, jobs, messages, emails]
        );

        return res.status(200).json({ success: true });
    } catch (error) {
        console.error("Update notification preferences error:", error);
        return res.status(500).json({ success: false, message: "Failed to update notification preferences" });
    }
};

// ─── 5. Blocked Accounts ───────────────────────────────────────────────────────

/**
 * 5.1 Fetch Blocked Users
 * GET /api/user/blocked
 */
exports.getBlockedUsers = async (req, res) => {
    try {
        const userId = req.user.sub;

        const blockedList = await BlockModel.getBlockedUsersDetails(userId);

        const formatted = blockedList.map((item) => ({
            id: item.user_id,
            name: item.full_name || item.account_name || "User",
            date: "Blocked recently",
            avatar: item.avatar_url || "",
        }));

        return res.status(200).json(formatted);
    } catch (error) {
        console.error("Get blocked users error:", error);
        return res.status(500).json({ success: false, message: "Failed to fetch blocked users" });
    }
};

/**
 * 5.2 Unblock User
 * DELETE /api/user/blocked/{id}
 */
exports.unblockUser = async (req, res) => {
    try {
        const userId = req.user.sub;
        const { id } = req.params;

        await BlockModel.unblockUser(userId, id, false);

        return res.status(200).json({ success: true });
    } catch (error) {
        console.error("Unblock user error:", error);
        return res.status(500).json({ success: false, message: "Failed to unblock user" });
    }
};

// ─── 6. Reports ────────────────────────────────────────────────────────────────

const REPORT_STATUS_LABELS = {
    pending:      'Submitted',
    under_review: 'Under review',
    action_taken: 'Action taken',
    no_action:    'No action taken',
    dismissed:    'Dismissed',
};

const ACTION_STATUS_LABELS = {
    active:     'Active',
    completed:  'Completed',
    appealed:   'Appealed',
    overturned: 'Overturned',
};

const ACTION_TYPE_LABELS = {
    warning:         'Warning',
    post_removed:    'Post removed',
    comment_removed: 'Comment removed',
    suspension:      'Temporary account suspension',
    ban:             'Account banned',
};

/**
 * 6.1 Fetch User Reports (with entity name resolution)
 * GET /api/user/reports
 */
exports.getUserReports = async (req, res) => {
    try {
        const userId = req.user.sub;
        const page  = parseInt(req.query.page)  || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;

        const countRes = await pool.query(
            'SELECT COUNT(*) FROM reports WHERE reporter_id = $1',
            [userId]
        );
        const total = parseInt(countRes.rows[0].count);

        const result = await pool.query(
            `SELECT
                r.id,
                r.target_type,
                r.target_id,
                r.status,
                r.created_at,
                COALESCE(rr.label, r.custom_reason, 'Reported') AS reason_label,
                CASE r.target_type
                    WHEN 'POST'    THEN CONCAT('Report about content posted by ', COALESCE(po.name, CONCAT('@', pu.account_name), 'unknown'))
                    WHEN 'USER'    THEN CONCAT('Reported profile: @', COALESCE(u.account_name, 'unknown'))
                    WHEN 'COMMENT' THEN CONCAT('Report about a comment by @', COALESCE(cu.account_name, 'unknown'))
                    WHEN 'COMPANY' THEN CONCAT('Reported company: ', COALESCE(o.name, 'unknown'))
                    ELSE 'Reported content'
                END AS title,
                COALESCE(u.account_name, po.name, pu.account_name, cu.account_name) AS reported_username
            FROM reports r
            LEFT JOIN report_reasons rr ON r.reason_id = rr.id
            LEFT JOIN users u           ON r.target_type = 'USER'    AND r.target_id = u.user_id
            LEFT JOIN posts p           ON r.target_type = 'POST'    AND r.target_id = p.post_id
            LEFT JOIN users pu          ON p.author_id = pu.user_id
            LEFT JOIN organizations po  ON p.author_org_id = po.org_id
            LEFT JOIN post_comments pc  ON r.target_type = 'COMMENT' AND r.target_id = pc.comment_id
            LEFT JOIN users cu          ON pc.author_id = cu.user_id
            LEFT JOIN organizations o   ON r.target_type = 'COMPANY' AND r.target_id = o.org_id
            WHERE r.reporter_id = $1
            ORDER BY r.created_at DESC
            LIMIT $2 OFFSET $3`,
            [userId, limit, offset]
        );

        const reports = result.rows.map((row) => ({
            id:               row.id,
            targetType:       row.target_type,
            targetId:         row.target_id,
            reportedUsername: row.reported_username || null,
            type:             row.target_type
                ? row.target_type.charAt(0).toUpperCase() + row.target_type.slice(1).toLowerCase()
                : 'Profile',
            date:        formatDate(row.created_at),
            reason:      row.reason_label,
            title:       row.title,
            status:      row.status || 'pending',
            statusLabel: REPORT_STATUS_LABELS[row.status] || 'Submitted',
        }));

        return res.status(200).json({
            reports,
            pagination: {
                page,
                limit,
                total,
                hasMore: offset + result.rows.length < total,
            },
        });
    } catch (error) {
        console.error('Get user reports error:', error);
        return res.status(500).json({ success: false, message: 'Failed to fetch reports' });
    }
};

/**
 * 6.2 Fetch a Single Report with Review Notes Timeline
 * GET /api/user/reports/:id
 */
exports.getUserReportById = async (req, res) => {
    try {
        const userId   = req.user.sub;
        const reportId = req.params.id;

        const result = await pool.query(
            `SELECT
                r.id,
                r.target_type,
                r.target_id,
                r.status,
                r.created_at,
                COALESCE(rr.label, r.custom_reason, 'Reported') AS reason_label,
                CASE r.target_type
                    WHEN 'POST'    THEN CONCAT('Report about content posted by ', COALESCE(po.name, CONCAT('@', pu.account_name), 'unknown'))
                    WHEN 'USER'    THEN CONCAT('Reported profile: @', COALESCE(u.account_name, 'unknown'))
                    WHEN 'COMMENT' THEN CONCAT('Report about a comment by @', COALESCE(cu.account_name, 'unknown'))
                    WHEN 'COMPANY' THEN CONCAT('Reported company: ', COALESCE(o.name, 'unknown'))
                    ELSE 'Reported content'
                END AS title,
                COALESCE(u.account_name, po.name, pu.account_name, cu.account_name) AS reported_username
            FROM reports r
            LEFT JOIN report_reasons rr ON r.reason_id = rr.id
            LEFT JOIN users u           ON r.target_type = 'USER'    AND r.target_id = u.user_id
            LEFT JOIN posts p           ON r.target_type = 'POST'    AND r.target_id = p.post_id
            LEFT JOIN users pu          ON p.author_id = pu.user_id
            LEFT JOIN organizations po  ON p.author_org_id = po.org_id
            LEFT JOIN post_comments pc  ON r.target_type = 'COMMENT' AND r.target_id = pc.comment_id
            LEFT JOIN users cu          ON pc.author_id = cu.user_id
            LEFT JOIN organizations o   ON r.target_type = 'COMPANY' AND r.target_id = o.org_id
            WHERE r.id = $1 AND r.reporter_id = $2`,
            [reportId, userId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, message: 'Report not found' });
        }

        const notesRes = await pool.query(
            `SELECT id, message, is_system, created_at
             FROM report_review_notes
             WHERE report_id = $1
             ORDER BY created_at ASC`,
            [reportId]
        );

        const row = result.rows[0];
        return res.status(200).json({
            id:               row.id,
            targetType:       row.target_type,
            targetId:         row.target_id,
            reportedUsername: row.reported_username || null,
            type:             row.target_type
                ? row.target_type.charAt(0).toUpperCase() + row.target_type.slice(1).toLowerCase()
                : 'Profile',
            date:        formatDate(row.created_at),
            reason:      row.reason_label,
            title:       row.title,
            status:      row.status || 'pending',
            statusLabel: REPORT_STATUS_LABELS[row.status] || 'Submitted',
            reviewNotes: notesRes.rows.map((n) => ({
                id:        n.id,
                message:   n.message,
                isSystem:  n.is_system,
                createdAt: n.created_at,
            })),
        });
    } catch (error) {
        console.error('Get report by ID error:', error);
        return res.status(500).json({ success: false, message: 'Failed to fetch report detail' });
    }
};



// ─── 7. Appearance Settings ─────────────────────────────────────────────────────

/**
 * 7.1 Fetch Theme Preference
 * GET /api/user/appearance
 */
exports.getAppearance = async (req, res) => {
    try {
        const userId = req.user.sub;
        const result = await pool.query(
            `SELECT theme_preference FROM users WHERE user_id = $1`,
            [userId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        return res.status(200).json({
            theme: result.rows[0].theme_preference || "system",
        });
    } catch (error) {
        console.error("Get appearance error:", error);
        return res.status(500).json({ success: false, message: "Failed to fetch appearance" });
    }
};

/**
 * 7.2 Update Theme Preference
 * PUT /api/user/appearance
 */
exports.updateAppearance = async (req, res) => {
    try {
        const userId = req.user.sub;
        const { theme } = req.body;

        if (!["system", "light", "dark"].includes(theme)) {
            return res.status(400).json({ success: false, message: "Theme must be system, light, or dark" });
        }

        await pool.query(
            `UPDATE users SET theme_preference = $1, updated_at = NOW() WHERE user_id = $2`,
            [theme, userId]
        );

        return res.status(200).json({ success: true });
    } catch (error) {
        console.error("Update appearance error:", error);
        return res.status(500).json({ success: false, message: "Failed to update appearance" });
    }
};

// ─── 8. Account Actions ─────────────────────────────────────────────────────────

/**
 * 8.1 Fetch Account Actions (moderation actions taken against this user)
 * GET /api/user/account-actions
 * Status is auto-resolved: if expires_at < NOW() → resolved_status = 'completed'
 */
exports.getAccountActions = async (req, res) => {
    try {
        const userId = req.user.sub;

        const result = await pool.query(
            `SELECT
                aa.id,
                aa.action_type,
                aa.duration_days,
                aa.expires_at,
                aa.created_at,
                aa.affected_title,
                COALESCE(rr.label, aa.custom_reason, 'Policy violation') AS reason_label,
                CASE
                    WHEN aa.action_type = 'suspension'
                         AND aa.expires_at IS NOT NULL
                         AND aa.expires_at < NOW()
                    THEN 'completed'
                    ELSE aa.status
                END AS resolved_status,
                CASE aa.action_type
                    WHEN 'warning'         THEN 'Warning'
                    WHEN 'post_removed'    THEN CONCAT('Post removed "', COALESCE(aa.affected_title, 'content'), '"')
                    WHEN 'comment_removed' THEN 'Comment removed'
                    WHEN 'suspension'      THEN CONCAT('Temporary account suspension for ', aa.duration_days, ' days')
                    WHEN 'ban'             THEN 'Account banned'
                    ELSE 'Account action'
                END AS label
            FROM account_actions aa
            LEFT JOIN report_reasons rr ON aa.reason_id = rr.id
            WHERE aa.user_id = $1
            ORDER BY aa.created_at DESC`,
            [userId]
        );

        const actions = result.rows.map((row) => ({
            id:          row.id,
            actionType:  row.action_type,
            label:       row.label,
            reason:      row.reason_label,
            date:        formatDate(row.created_at),
            status:      row.resolved_status,
            statusLabel: ACTION_STATUS_LABELS[row.resolved_status] || 'Active',
        }));

        return res.status(200).json({ actions });
    } catch (error) {
        console.error('Get account actions error:', error);
        return res.status(500).json({ success: false, message: 'Failed to fetch account actions' });
    }
};

/**
 * 8.2 Fetch a Single Account Action Detail
 * GET /api/user/account-actions/:id
 */
exports.getAccountActionById = async (req, res) => {
    try {
        const userId   = req.user.sub;
        const actionId = req.params.id;

        const result = await pool.query(
            `SELECT
                aa.id,
                aa.action_type,
                aa.affected_type,
                aa.affected_id,
                aa.affected_title,
                aa.moderator_note,
                aa.duration_days,
                aa.expires_at,
                aa.created_at,
                COALESCE(rr.label, aa.custom_reason, 'Policy violation') AS reason_label,
                CASE
                    WHEN aa.action_type = 'suspension'
                         AND aa.expires_at IS NOT NULL
                         AND aa.expires_at < NOW()
                    THEN 'completed'
                    ELSE aa.status
                END AS resolved_status,
                CASE aa.action_type
                    WHEN 'warning'         THEN 'Warning'
                    WHEN 'post_removed'    THEN CONCAT('Post removed "', COALESCE(aa.affected_title, 'content'), '"')
                    WHEN 'comment_removed' THEN 'Comment removed'
                    WHEN 'suspension'      THEN CONCAT('Temporary account suspension for ', aa.duration_days, ' days')
                    WHEN 'ban'             THEN 'Account banned'
                    ELSE 'Account action'
                END AS label
            FROM account_actions aa
            LEFT JOIN report_reasons rr ON aa.reason_id = rr.id
            WHERE aa.id = $1 AND aa.user_id = $2`,
            [actionId, userId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, message: 'Action not found' });
        }

        const row = result.rows[0];
        return res.status(200).json({
            id:                   row.id,
            actionType:           row.action_type,
            label:                row.label,
            reason:               row.reason_label,
            date:                 formatDate(row.created_at),
            status:               row.resolved_status,
            statusLabel:          ACTION_STATUS_LABELS[row.resolved_status] || 'Active',
            affectedContentType:  row.affected_type  || null,
            affectedContentId:    row.affected_id    || null,
            affectedContentTitle: row.affected_title || null,
            moderatorNote:        row.moderator_note || null,
            durationDays:         row.duration_days  || null,
        });
    } catch (error) {
        console.error('Get account action by ID error:', error);
        return res.status(500).json({ success: false, message: 'Failed to fetch action detail' });
    }
};
