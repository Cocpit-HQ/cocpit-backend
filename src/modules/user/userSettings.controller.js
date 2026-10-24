const pool = require("../../core/db/pool");
const redisClient = require("../../core/db/redis");
const { comparePassword, hashPassword } = require("../../core/utils/password");
const { requestOTP, verifyOTP } = require("../auth/otp.service");
const emailService = require("../../core/services/email.service");
const BlockModel = require("../../models/block.model");
const { logAudit } = require("../../services/audit.service");
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
        // Organization Context Branching
        if (req.actor && req.actor.type === "ORGANIZATION") {
            const orgId = req.actor.orgId;
            const orgRes = await pool.query(
                `SELECT o.org_id, o.email, o.phone, o.country_code, o.is_deactivated, o.deactivated_at,
                        o.entity_type, o.name, o.created_by, u.full_name AS owner_name
                 FROM organizations o
                 LEFT JOIN users u ON o.created_by = u.user_id
                 WHERE o.org_id = $1 AND o.is_deleted = FALSE`,
                [orgId]
            );

            if (orgRes.rowCount === 0) {
                return res.status(404).json({ success: false, message: "Organization not found" });
            }

            const org = orgRes.rows[0];
            return res.status(200).json({
                id: org.org_id,
                email: org.email || "",
                primaryEmail: org.email || "",
                phone: org.phone || "",
                countryCode: org.country_code || "",
                isDeactivated: org.is_deactivated || false,
                deactivatedAt: org.deactivated_at || null,
                entityType: org.entity_type || "COMPANY",
                companyName: org.name,
                ownerUserId: org.created_by,
                ownerName: org.owner_name || "",
                hasCompanyAccount: true,
            });
        }

        // Personal User Context Branching
        const userId = req.user.sub;

        const userRes = await pool.query(
            `SELECT user_id, email, recovery_email, mobile_number, country_code, is_deactivated, password_hash
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

        const hasPassword = Boolean(user.password_hash && user.password_hash.trim() !== "");

        return res.status(200).json({
            id: user.user_id,
            email: user.email || "",
            primaryEmail: user.email || "",
            recoveryEmail: user.recovery_email || "",
            phone: user.mobile_number || "",
            countryCode: user.country_code || "",
            hasCompanyAccount: hasCompanyAccount,
            isDeactivated: user.is_deactivated || false,
            hasPassword,
        });
    } catch (error) {
        console.error("Get account details error:", error);
        return res.status(500).json({ success: false, message: "Failed to fetch account details" });
    }
};

/**
 * 1.1b Request Deletion OTP (User or Organization)
 * POST /api/user/account/delete-otp
 */
exports.requestDeleteOTP = async (req, res) => {
    try {
        let targetEmail = "";
        let purpose = "account_deletion";

        if (req.actor && req.actor.type === "ORGANIZATION") {
            const orgId = req.actor.orgId;
            // Verify Owner permission
            const orgRes = await pool.query(
                `SELECT created_by FROM organizations WHERE org_id = $1 AND is_deleted = FALSE`,
                [orgId]
            );
            if (orgRes.rowCount === 0) {
                return res.status(404).json({ success: false, message: "Organization not found" });
            }
            if (orgRes.rows[0].created_by !== req.user.sub && req.actor.roleName !== 'Owner') {
                return res.status(403).json({ success: false, message: "Only the organization owner can request deletion OTP" });
            }

            // Get Owner registered primary email
            const ownerRes = await pool.query(`SELECT email FROM users WHERE user_id = $1`, [req.user.sub]);
            if (ownerRes.rowCount === 0 || !ownerRes.rows[0].email) {
                return res.status(400).json({ success: false, message: "Owner registered primary email not found" });
            }
            targetEmail = ownerRes.rows[0].email;
            purpose = `org_deletion_${orgId}`;
        } else {
            const userId = req.user.sub;
            const userRes = await pool.query(`SELECT email FROM users WHERE user_id = $1`, [userId]);
            if (userRes.rowCount === 0 || !userRes.rows[0].email) {
                return res.status(400).json({ success: false, message: "Registered primary email not found" });
            }
            targetEmail = userRes.rows[0].email;
            purpose = `user_deletion_${userId}`;
        }

        const otpResult = await requestOTP(targetEmail, purpose);
        if (otpResult.error) {
            return res.status(otpResult.error.status).json({ success: false, message: otpResult.error.message });
        }

        return res.status(200).json({
            success: true,
            message: "Deletion OTP sent to registered primary email.",
        });
    } catch (error) {
        console.error("Request delete OTP error:", error);
        return res.status(500).json({ success: false, message: "Failed to request deletion OTP" });
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
                    return res.status(400).json({ success: false, message: "Invalid password" });
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


        
        if (!newPassword) {
            return res.status(400).json({ success: false, message: "newPassword is required" });
        }

        const userRes = await pool.query(
            `SELECT email, password_hash FROM users WHERE user_id = $1`,
            [userId]
        );

        if (userRes.rowCount === 0) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        const user = userRes.rows[0];
        const hasExistingPassword = Boolean(user.password_hash && user.password_hash.trim() !== "");

        // If user already has a password, verify old password
        if (hasExistingPassword) {
            if (!currentPassword) {
                return res.status(400).json({ success: false, message: "Current password is required" });
            }
            const isMatch = await comparePassword(currentPassword, user.password_hash);
            if (!isMatch) {
                return res.status(400).json({ success: false, message: "Current password is incorrect" });
            }
            if (currentPassword === newPassword) {
                return res.status(400).json({ success: false, message: "New password must be different from current password" });
            }
        }

        const newHash = await hashPassword(newPassword);

        await pool.query(
            `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE user_id = $2`,
            [newHash, userId]
        );

        await revokeOtherSessions(userId, currentSessionId);

        // ─── Trigger Password Changed Notification (Row 2) ───
        console.log(`[PasswordChange] ✅ Password updated for userId=${userId}, email=${user.email}. Now triggering notification...`);
        try {
            const now = new Date();
            const dateStr = now.toLocaleDateString();
            const timeStr = now.toLocaleTimeString();
            const msgText = `Your password was changed on ${dateStr}, ${timeStr}. If this wasn't you, secure your account.`;

            await pool.query(
                `INSERT INTO notifications (user_id, type, text, is_read, metadata)
                 VALUES ($1, 'password_changed', $2, false, $3)`,
                [userId, msgText, JSON.stringify({ title: 'Your password was changed' })]
            );
            console.log(`[PasswordChange] ✅ Notification inserted into DB`);

            if (SocketService.io) {
                SocketService.notifyUser(userId, {
                    type: 'password_changed',
                    title: 'Your password was changed',
                    text: msgText,
                    created_at: now.toISOString()
                });
                console.log(`[PasswordChange] ✅ Socket notification sent`);
            } else {
                console.log(`[PasswordChange] ⚠️ SocketService.io is falsy, skipping socket`);
            }

            if (user.email) {
                console.log(`[PasswordChange] Sending email to ${user.email}...`);
                emailService.sendPasswordChangedEmail(user.email, `${dateStr}, ${timeStr}`)
                    .then(() => console.log(`[PasswordChange] ✅ Email sent successfully`))
                    .catch(e => console.error(`[PasswordChange] ❌ Email failed:`, e));
            } else {
                console.log(`[PasswordChange] ⚠️ user.email is falsy, skipping email`);
            }
        } catch (e) {
            console.error("[PasswordChange] ❌ Failed to trigger password changed notification:", e);
        }

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
        const isOrgActor = req.actor && req.actor.type === "ORGANIZATION";
        const { phone } = req.body;

        if (phone === undefined) {
            return res.status(400).json({ success: false, message: "phone is required" });
        }

        const phoneVal = (phone === "" || phone === null) ? null : phone;

        if (phoneVal !== null) {
            const digitCount = String(phoneVal).replace(/\D/g, '').length;
            if (digitCount < 10) {
                return res.status(400).json({ success: false, message: "Phone number must be at least 10 digits" });
            }
        }

        if (isOrgActor) {
            const orgId = req.actor.orgId;
            await pool.query(
                `UPDATE organizations SET phone = $1, updated_at = NOW() WHERE org_id = $2`,
                [phoneVal, orgId]
            );
        } else {
            const userId = req.user.sub;
            await pool.query(
                `UPDATE users SET mobile_number = $1, updated_at = NOW() WHERE user_id = $2`,
                [phoneVal, userId]
            );
        }

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
        const isOrgActor = req.actor && req.actor.type === "ORGANIZATION";

        if (isOrgActor) {
            const orgId = req.actor.orgId;
            await pool.query(
                `UPDATE organizations SET phone = NULL, country_code = NULL, updated_at = NOW() WHERE org_id = $1`,
                [orgId]
            );
            return res.status(200).json({ success: true, message: "Phone number removed successfully." });
        }

        const userId = req.user.sub;

        await pool.query(
            `UPDATE users SET mobile_number = NULL, country_code = NULL, updated_at = NOW() WHERE user_id = $1`,
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
        const { otp } = req.body;

        if (!otp) {
            return res.status(400).json({ success: false, message: "OTP is required to confirm deletion" });
        }

        // Organization Deletion Branching
        if (req.actor && req.actor.type === "ORGANIZATION") {
            const orgId = req.actor.orgId;
            const orgRes = await pool.query(
                `SELECT created_by FROM organizations WHERE org_id = $1 AND is_deleted = FALSE`,
                [orgId]
            );

            if (orgRes.rowCount === 0) {
                return res.status(404).json({ success: false, message: "Organization not found" });
            }

            if (orgRes.rows[0].created_by !== userId && req.actor.roleName !== 'Owner') {
                return res.status(403).json({ success: false, message: "Only the organization owner can delete the organization page" });
            }

            const ownerRes = await pool.query(`SELECT email FROM users WHERE user_id = $1`, [userId]);
            if (ownerRes.rowCount === 0 || !ownerRes.rows[0].email) {
                return res.status(400).json({ success: false, message: "Owner registered primary email not found" });
            }

            const verifyResult = await verifyOTP(ownerRes.rows[0].email, otp, true, `org_deletion_${orgId}`);
            if (verifyResult.error) {
                return res.status(verifyResult.error.status).json({ success: false, message: verifyResult.error.message });
            }

            const deletionDate = new Date();
            deletionDate.setDate(deletionDate.getDate() + 40);

            await client.query("BEGIN");
            await client.query(
                `UPDATE organizations SET is_deleted = TRUE, deletion_scheduled_at = $1, updated_at = NOW() WHERE org_id = $2`,
                [deletionDate, orgId]
            );
            await logAudit(client, {
                entityId: orgId,
                entityType: 'ORGANIZATION',
                actorId: userId,
                action: 'ORGANIZATION_SCHEDULED_FOR_DELETION',
                metadata: { scheduledAt: deletionDate }
            });
            await client.query("COMMIT");

            return res.status(200).json({
                success: true,
                message: "Organization scheduled for deletion (40-day grace period).",
            });
        }

        // Personal User Account Deletion Branching
        const userFetch = await client.query(
            "SELECT user_id, email, recovery_email FROM users WHERE user_id = $1",
            [userId]
        );

        if (userFetch.rowCount === 0) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        const userObj = userFetch.rows[0];
        const verifyResult = await verifyOTP(userObj.email, otp, true, `user_deletion_${userId}`);
        if (verifyResult.error) {
            return res.status(verifyResult.error.status).json({ success: false, message: verifyResult.error.message });
        }

        const deletionDate = new Date();
        deletionDate.setDate(deletionDate.getDate() + 40);

        await client.query("BEGIN");

        await client.query(
            `UPDATE users SET is_deleted = TRUE, deleted_at = NOW(), deletion_scheduled_at = NOW(), deletion_execute_at = $1, updated_at = NOW() WHERE user_id = $2`,
            [deletionDate, userId]
        );

        await client.query(
            `UPDATE organization_members SET status = 'REMOVED', updated_at = NOW() WHERE user_id = $1 AND status = 'ACTIVE'`,
            [userId]
        );

        await client.query(
            `DELETE FROM refresh_tokens WHERE user_id = $1`,
            [userId]
        );

        await client.query("COMMIT");

        res.clearCookie("refreshToken");

        // Broadcast user deletion socket events to invalidate real-time chat and post caches for other clients
        if (SocketService && SocketService.io) {
            SocketService.io.emit('user_deleted', { userId });
            SocketService.io.emit('USER_DELETED', { userId });
            SocketService.io.emit('user_deactivated', { userId });
            SocketService.io.emit('USER_DEACTIVATED', { userId });
            SocketService.io.emit('account_state_changed', { userId, type: 'user', action: 'deleted' });
        }

        if (userObj) {
            const recipientEmails = Array.from(
                new Set([userObj.recovery_email, userObj.email].filter((e) => Boolean(e) && typeof e === "string" && e.trim() !== ""))
            );
            const { sendAccountDeletionEmail } = require("../../core/services/email.service");
            for (const recipientEmail of recipientEmails) {
                sendAccountDeletionEmail(recipientEmail, userObj.full_name, null, deletionDate)
                    .catch((err) => console.error(`[userSettings.deleteAccount] Failed to send recovery email to ${recipientEmail}:`, err));
            }
        }

        return res.status(200).json({
            success: true,
            message: "Account scheduled for deletion (40-day grace period).",
        });
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("Delete account error:", error);
        return res.status(500).json({ success: false, message: "Failed to delete account" });
    } finally {
        client.release();
    }
};

/**
 * 1.9 Deactivate Account
 * PATCH /api/user/account/deactivate
 */
exports.deactivateAccount = async (req, res) => {
    const client = await pool.connect();
    try {
        const userId = req.user.sub;
        const { password } = req.body;

        if (!password) {
            return res.status(400).json({ success: false, message: "Password is required to confirm deactivation" });
        }

        // Verify user exists and password is correct
        const userFetch = await client.query(
            "SELECT user_id, password_hash FROM users WHERE user_id = $1",
            [userId]
        );

        if (userFetch.rowCount === 0) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        const userObj = userFetch.rows[0];
        const isMatch = await comparePassword(password, userObj.password_hash);
        if (!isMatch) {
            return res.status(400).json({ success: false, message: "Invalid password" });
        }

        await client.query("BEGIN");

        // 1. Deactivate user account
        await client.query(
            `UPDATE users SET is_deactivated = TRUE, deactivated_at = NOW(), updated_at = NOW() WHERE user_id = $1`,
            [userId]
        );

        // 2. Deactivate all owned company accounts that aren't deleted
        const orgsRes = await client.query(
            `UPDATE organizations SET is_deactivated = TRUE, deactivated_at = NOW(), updated_at = NOW() WHERE created_by = $1 AND is_deleted = FALSE RETURNING org_id`,
            [userId]
        );
        const deactivatedOrgIds = orgsRes.rows.map((r) => r.org_id);

        // 3. Mark organization memberships as REMOVED
        await client.query(
            `UPDATE organization_members SET status = 'REMOVED', updated_at = NOW() WHERE user_id = $1 AND status = 'ACTIVE'`,
            [userId]
        );

        // 3. Transfer group chat admin roles if this user was a group admin
        const GroupChatService = require("../../services/groupChat.service");
        await GroupChatService.handleAdminDeactivationOrDeletion(userId, client);

        // 4. Delete refresh tokens
        const sessionsRes = await client.query(
            "DELETE FROM refresh_tokens WHERE user_id = $1 RETURNING session_id",
            [userId]
        );
        const sessionIds = sessionsRes.rows.map((r) => r.session_id);

        await client.query("COMMIT");

        // 4. Blacklist in Redis
        if (redisClient.isOpen && sessionIds.length > 0) {
            await Promise.allSettled(
                sessionIds.map((sid) => redisClient.setEx(`revoked_session:${sid}`, 900, "1"))
            );
        }

        // 5. Disconnect sockets
        if (sessionIds.length > 0) {
            Promise.allSettled(
                sessionIds.map((sid) => SocketService.disconnectUserSession(userId, sid))
            ).catch((err) => console.error("[deactivateAccount] Socket disconnect failed:", err));
        }

        // 6. Clear cookies
        res.clearCookie("refreshToken", {
            httpOnly: true,
            secure: true,
            sameSite: "None",
            path: "/",
        });

        // 7. Notify organization members to switch back to personal profile
        deactivatedOrgIds.forEach((orgId) => {
            SocketService.notifyOrg(orgId, 'ORGANIZATION_DEACTIVATED', { orgId });
        });

        // 8. Broadcast user deactivation event
        if (SocketService.io) {
            SocketService.io.emit('user_deactivated', { userId });
            SocketService.io.emit('USER_DEACTIVATED', { userId });
        }

        return res.status(200).json({
            success: true,
            message: "Account deactivated successfully.",
        });
    } catch (error) {
        if (client) await client.query("ROLLBACK");
        console.error("Deactivate account error:", error);
        return res.status(500).json({ success: false, message: "Failed to deactivate account" });
    } finally {
        if (client) client.release();
    }
};


// ─── 2. Activity Settings ───────────────────────────────────────────────────────

/**
 * 2.1 Fetch Activity Logs
 * GET /api/user/activity?type=likes|comments|tags
 */
exports.getActivityLogs = async (req, res) => {
    try {
        // For personal activity, only treat as org actor when explicitly requested via headers
        // (NOT from cookie). The activeActor cookie is always sent with requests, so using
        // req.actor.type here would return org data even on the personal settings page.
        const explicitActorType = req.headers["x-actor-type"];
        const explicitActorId = req.headers["x-actor-id"] || req.query.companyId || null;
        let isOrgActor = (explicitActorType === "ORGANIZATION" || Boolean(req.query.companyId)) && !!explicitActorId;
        let actorOrgId = isOrgActor ? explicitActorId : null;

        if (isOrgActor && actorOrgId) {
            const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(actorOrgId);
            if (!isUuid) {
                const orgRes = await pool.query('SELECT org_id FROM organizations WHERE slug = $1 LIMIT 1', [actorOrgId]);
                if (orgRes.rows.length > 0) {
                    actorOrgId = orgRes.rows[0].org_id;
                }
            }
        }
        const targetId = isOrgActor ? actorOrgId : req.user.sub;
        const { type } = req.query;

        if (type === "comments") {
            const query = isOrgActor
                ? `SELECT 
                    pc.comment_id AS id,
                    pc.post_id AS "postId",
                    COALESCE(post_comp.name, post_author.full_name) AS "postAuthor",
                    CASE WHEN p.author_org_id IS NOT NULL THEN post_comp.logo_url ELSE post_author.avatar_url END AS "postAuthorAvatar",
                    CASE WHEN p.author_org_id IS NOT NULL THEN COALESCE(post_comp.headline, '') ELSE COALESCE(post_author.headline, '') END AS "postAuthorRole",
                    (p.author_org_id IS NOT NULL) AS "isPostCompany",
                    (p.author_org_id IS NOT NULL) AS "isCompanyPost",
                    (p.author_org_id IS NOT NULL) AS "isCompany",
                    p.author_org_id,
                    CASE WHEN p.post_type = 'poll' THEN COALESCE(NULLIF(p.title, ''), p.content) ELSE p.content END AS "postTitle",
                    COALESCE(commenter_comp.name, commenter.full_name) AS commenter,
                    CASE WHEN pc.author_org_id IS NOT NULL THEN commenter_comp.logo_url ELSE commenter.avatar_url END AS "commenterAvatar",
                    CASE WHEN pc.author_org_id IS NOT NULL THEN COALESCE(commenter_comp.headline, '') ELSE COALESCE(commenter.headline, '') END AS "commenterRole",
                    (pc.author_org_id IS NOT NULL) AS "isCommenterCompany",
                    pc.author_org_id AS "commenterOrgId",
                    pc.content AS comment,
                    (SELECT COUNT(*) FROM active_comment_likes cl WHERE cl.comment_id = pc.comment_id) AS likes,
                    (SELECT COUNT(*) FROM active_post_comments sub_c WHERE sub_c.parent_id = pc.comment_id) AS replies,
                    (SELECT pm.url FROM post_media pm WHERE pm.post_id = p.post_id LIMIT 1) AS "mediaUrl",
                    CASE WHEN p.post_type IS NOT NULL THEN p.post_type::text ELSE 'text' END AS type,
                    p.shared_post_id AS "sharedPostId",
                    (SELECT COUNT(*) FROM poll_votes pv WHERE pv.poll_id = (SELECT poll_id FROM post_polls pp WHERE pp.post_id = p.post_id LIMIT 1)) AS votes,
                    (SELECT (pp.created_at + COALESCE(pp.duration, '1 day')::interval > NOW()) FROM post_polls pp WHERE pp.post_id = p.post_id LIMIT 1) AS "isPollActive",
                    (p.post_id IS NULL) AS "isDeleted",
                    (p.post_id IS NULL) AS is_deleted
                 FROM active_post_comments pc
                 JOIN posts p ON pc.post_id = p.post_id
                 LEFT JOIN users post_author ON p.author_id = post_author.user_id
                 LEFT JOIN organizations post_comp ON p.author_org_id = post_comp.org_id
                 LEFT JOIN users commenter ON pc.author_id = commenter.user_id
                 LEFT JOIN organizations commenter_comp ON pc.author_org_id = commenter_comp.org_id
                 WHERE pc.author_org_id = $1::uuid
                   AND p.is_active = true AND (p.is_removed IS FALSE OR p.is_removed IS NULL)
                   AND (
                       (p.author_org_id IS NULL AND post_author.user_id IS NOT NULL AND (post_author.is_deactivated IS FALSE OR post_author.is_deactivated IS NULL) AND (post_author.is_deleted IS NULL OR post_author.is_deleted = FALSE))
                       OR
                       (p.author_org_id IS NOT NULL AND post_comp.org_id IS NOT NULL AND post_comp.is_deleted = FALSE AND (post_comp.deletion_execute_at IS NULL OR post_comp.deletion_execute_at > NOW()) AND post_comp.is_deactivated = FALSE)
                   )
                 ORDER BY pc.created_at DESC
                 LIMIT 50`
                : `SELECT 
                    pc.comment_id AS id,
                    pc.post_id AS "postId",
                    COALESCE(post_comp.name, post_author.full_name) AS "postAuthor",
                    CASE WHEN p.author_org_id IS NOT NULL THEN post_comp.logo_url ELSE post_author.avatar_url END AS "postAuthorAvatar",
                    CASE WHEN p.author_org_id IS NOT NULL THEN COALESCE(post_comp.headline, '') ELSE COALESCE(post_author.headline, '') END AS "postAuthorRole",
                    (p.author_org_id IS NOT NULL) AS "isPostCompany",
                    (p.author_org_id IS NOT NULL) AS "isCompanyPost",
                    (p.author_org_id IS NOT NULL) AS "isCompany",
                    p.author_org_id,
                    CASE WHEN p.post_type = 'poll' THEN COALESCE(NULLIF(p.title, ''), p.content) ELSE p.content END AS "postTitle",
                    COALESCE(commenter_comp.name, commenter.full_name) AS commenter,
                    CASE WHEN pc.author_org_id IS NOT NULL THEN commenter_comp.logo_url ELSE commenter.avatar_url END AS "commenterAvatar",
                    CASE WHEN pc.author_org_id IS NOT NULL THEN COALESCE(commenter_comp.headline, '') ELSE COALESCE(commenter.headline, '') END AS "commenterRole",
                    (pc.author_org_id IS NOT NULL) AS "isCommenterCompany",
                    pc.author_org_id AS "commenterOrgId",
                    pc.content AS comment,
                    (SELECT COUNT(*) FROM active_comment_likes cl WHERE cl.comment_id = pc.comment_id) AS likes,
                    (SELECT COUNT(*) FROM active_post_comments sub_c WHERE sub_c.parent_id = pc.comment_id) AS replies,
                    (SELECT pm.url FROM post_media pm WHERE pm.post_id = p.post_id LIMIT 1) AS "mediaUrl",
                    CASE WHEN p.post_type IS NOT NULL THEN p.post_type::text ELSE 'text' END AS type,
                    p.shared_post_id AS "sharedPostId",
                    (SELECT COUNT(*) FROM poll_votes pv WHERE pv.poll_id = (SELECT poll_id FROM post_polls pp WHERE pp.post_id = p.post_id LIMIT 1)) AS votes,
                    (SELECT (pp.created_at + COALESCE(pp.duration, '1 day')::interval > NOW()) FROM post_polls pp WHERE pp.post_id = p.post_id LIMIT 1) AS "isPollActive",
                    (p.post_id IS NULL) AS "isDeleted",
                    (p.post_id IS NULL) AS is_deleted
                 FROM active_post_comments pc
                 JOIN posts p ON pc.post_id = p.post_id
                 LEFT JOIN users post_author ON p.author_id = post_author.user_id
                 LEFT JOIN organizations post_comp ON p.author_org_id = post_comp.org_id
                 LEFT JOIN users commenter ON pc.author_id = commenter.user_id
                 LEFT JOIN organizations commenter_comp ON pc.author_org_id = commenter_comp.org_id
                 WHERE pc.author_id = $1 AND pc.author_org_id IS NULL
                   AND p.is_active = true AND (p.is_removed IS FALSE OR p.is_removed IS NULL)
                   AND (
                       (p.author_org_id IS NULL AND post_author.user_id IS NOT NULL AND (post_author.is_deactivated IS FALSE OR post_author.is_deactivated IS NULL) AND (post_author.is_deleted IS NULL OR post_author.is_deleted = FALSE))
                       OR
                       (p.author_org_id IS NOT NULL AND post_comp.org_id IS NOT NULL AND post_comp.is_deleted = FALSE AND (post_comp.deletion_execute_at IS NULL OR post_comp.deletion_execute_at > NOW()) AND post_comp.is_deactivated = FALSE)
                   )
                 ORDER BY pc.created_at DESC
                 LIMIT 50`;

            const result = await pool.query(query, [targetId]);
            return res.status(200).json(result.rows);

        } else if (type === "tags") {
            const query = isOrgActor
                ? `SELECT 
                    COALESCE(pt.tag_id::text, p.post_id::text) AS id,
                    p.post_id AS "postId",
                    COALESCE(o.name, u.full_name) AS user,
                    CASE WHEN p.author_org_id IS NOT NULL THEN o.logo_url ELSE u.avatar_url END AS "avatarUrl",
                    CASE WHEN p.author_org_id IS NOT NULL THEN COALESCE(o.headline, '') ELSE COALESCE(u.headline, '') END AS role,
                    (p.author_org_id IS NOT NULL) AS "isCompanyPost",
                    (p.author_org_id IS NOT NULL) AS "isCompany",
                    p.author_org_id,
                    CASE WHEN p.post_type IS NOT NULL THEN p.post_type::text ELSE 'text' END AS type,
                    p.content AS content,
                    CASE WHEN p.post_type = 'poll' THEN COALESCE(NULLIF(p.title, ''), p.content) ELSE p.title END AS "postTitle",
                    (SELECT pm.url FROM post_media pm WHERE pm.post_id = p.post_id LIMIT 1) AS "mediaUrl",
                    (SELECT COUNT(*) FROM poll_votes pv WHERE pv.poll_id = (SELECT poll_id FROM post_polls pp WHERE pp.post_id = p.post_id LIMIT 1)) AS votes,
                    (SELECT (pp.created_at + COALESCE(pp.duration, '1 day')::interval > NOW()) FROM post_polls pp WHERE pp.post_id = p.post_id LIMIT 1) AS "isPollActive",
                    (p.post_id IS NULL) AS "isDeleted",
                    (p.post_id IS NULL) AS is_deleted
                 FROM posts p
                 LEFT JOIN post_tags pt ON pt.post_id = p.post_id AND pt.tagged_user_id = $1::uuid AND pt.is_active_tag = true
                 LEFT JOIN users u ON p.author_id = u.user_id
                 LEFT JOIN organizations o ON p.author_org_id = o.org_id
                 WHERE (
                     pt.tag_id IS NOT NULL
                     OR (
                         p.content ~ ('@\\[[^\\]]+\\]\\(' || $1::text || '\\)')
                         AND NOT EXISTS (
                             SELECT 1 FROM post_tags pt_inactive
                             WHERE pt_inactive.post_id = p.post_id
                               AND pt_inactive.tagged_user_id = $1::uuid
                               AND pt_inactive.is_active_tag = false
                         )
                     )
                 )
                   AND p.is_active = true AND (p.is_removed IS FALSE OR p.is_removed IS NULL)
                   AND (
                       (p.author_org_id IS NULL AND u.user_id IS NOT NULL AND (u.is_deactivated IS FALSE OR u.is_deactivated IS NULL) AND (u.is_deleted IS NULL OR u.is_deleted = FALSE))
                       OR
                       (p.author_org_id IS NOT NULL AND o.org_id IS NOT NULL AND o.is_deleted = FALSE AND (o.deletion_execute_at IS NULL OR o.deletion_execute_at > NOW()) AND o.is_deactivated = FALSE)
                   )
                 ORDER BY COALESCE(pt.updated_at, p.updated_at) DESC
                 LIMIT 50`
                : `SELECT 
                    COALESCE(pt.tag_id::text, p.post_id::text) AS id,
                    p.post_id AS "postId",
                    COALESCE(o.name, u.full_name) AS user,
                    CASE WHEN p.author_org_id IS NOT NULL THEN o.logo_url ELSE u.avatar_url END AS "avatarUrl",
                    CASE WHEN p.author_org_id IS NOT NULL THEN COALESCE(o.headline, '') ELSE COALESCE(u.headline, '') END AS role,
                    (p.author_org_id IS NOT NULL) AS "isCompanyPost",
                    (p.author_org_id IS NOT NULL) AS "isCompany",
                    p.author_org_id,
                    CASE WHEN p.post_type IS NOT NULL THEN p.post_type::text ELSE 'text' END AS type,
                    p.content AS content,
                    CASE WHEN p.post_type = 'poll' THEN COALESCE(NULLIF(p.title, ''), p.content) ELSE p.title END AS "postTitle",
                    (SELECT pm.url FROM post_media pm WHERE pm.post_id = p.post_id LIMIT 1) AS "mediaUrl",
                    (SELECT COUNT(*) FROM poll_votes pv WHERE pv.poll_id = (SELECT poll_id FROM post_polls pp WHERE pp.post_id = p.post_id LIMIT 1)) AS votes,
                    (SELECT (pp.created_at + COALESCE(pp.duration, '1 day')::interval > NOW()) FROM post_polls pp WHERE pp.post_id = p.post_id LIMIT 1) AS "isPollActive",
                    (p.post_id IS NULL) AS "isDeleted",
                    (p.post_id IS NULL) AS is_deleted
                 FROM posts p
                 LEFT JOIN post_tags pt ON pt.post_id = p.post_id AND pt.tagged_user_id = $1::uuid AND pt.is_active_tag = true
                 LEFT JOIN users u ON p.author_id = u.user_id
                 LEFT JOIN organizations o ON p.author_org_id = o.org_id
                 WHERE (
                     pt.tag_id IS NOT NULL
                     OR (
                         p.content ~ ('@\\[[^\\]]+\\]\\(' || $1::text || '\\)')
                         AND NOT EXISTS (
                             SELECT 1 FROM post_tags pt_inactive
                             WHERE pt_inactive.post_id = p.post_id
                               AND pt_inactive.tagged_user_id = $1::uuid
                               AND pt_inactive.is_active_tag = false
                         )
                     )
                 )
                   AND p.is_active = true AND (p.is_removed IS FALSE OR p.is_removed IS NULL)
                   AND (
                       (p.author_org_id IS NULL AND u.user_id IS NOT NULL AND (u.is_deactivated IS FALSE OR u.is_deactivated IS NULL) AND (u.is_deleted IS NULL OR u.is_deleted = FALSE))
                       OR
                       (p.author_org_id IS NOT NULL AND o.org_id IS NOT NULL AND o.is_deleted = FALSE AND (o.deletion_execute_at IS NULL OR o.deletion_execute_at > NOW()) AND o.is_deactivated = FALSE)
                   )
                 ORDER BY COALESCE(pt.updated_at, p.updated_at) DESC
                 LIMIT 50`;

            const result = await pool.query(query, [targetId]);
            return res.status(200).json(result.rows);

        } else {
            // Default: likes or fallback
            const query = isOrgActor
                ? `SELECT 
                    pl.post_id AS id,
                    COALESCE(comp.name, u.full_name) AS user,
                    CASE WHEN p.author_org_id IS NOT NULL THEN comp.logo_url ELSE u.avatar_url END AS "avatarUrl",
                    CASE WHEN p.author_org_id IS NOT NULL THEN COALESCE(comp.headline, '') ELSE COALESCE(u.headline, '') END AS role,
                    (p.author_org_id IS NOT NULL) AS "isCompanyPost",
                    (p.author_org_id IS NOT NULL) AS "isCompany",
                    p.author_org_id,
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
                     FROM active_post_likes
                     WHERE org_id = $1::uuid
                     GROUP BY post_id
                 ) pl
                 JOIN posts p ON pl.post_id = p.post_id
                 LEFT JOIN users u ON p.author_id = u.user_id
                 LEFT JOIN organizations comp ON p.author_org_id = comp.org_id
                 WHERE p.is_active = true AND (p.is_removed IS FALSE OR p.is_removed IS NULL)
                   AND (
                       (p.author_org_id IS NULL AND u.user_id IS NOT NULL AND (u.is_deactivated IS FALSE OR u.is_deactivated IS NULL) AND (u.is_deleted IS NULL OR u.is_deleted = FALSE))
                       OR
                       (p.author_org_id IS NOT NULL AND comp.org_id IS NOT NULL AND comp.is_deleted = FALSE AND (comp.deletion_execute_at IS NULL OR comp.deletion_execute_at > NOW()) AND comp.is_deactivated = FALSE)
                   )
                 ORDER BY pl.created_at DESC
                 LIMIT 50`
                : `SELECT 
                    pl.post_id AS id,
                    COALESCE(comp.name, u.full_name) AS user,
                    CASE WHEN p.author_org_id IS NOT NULL THEN comp.logo_url ELSE u.avatar_url END AS "avatarUrl",
                    CASE WHEN p.author_org_id IS NOT NULL THEN COALESCE(comp.headline, '') ELSE COALESCE(u.headline, '') END AS role,
                    (p.author_org_id IS NOT NULL) AS "isCompanyPost",
                    (p.author_org_id IS NOT NULL) AS "isCompany",
                    p.author_org_id,
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
                     FROM active_post_likes
                     WHERE user_id = $1 AND org_id IS NULL
                     GROUP BY post_id
                 ) pl
                 JOIN posts p ON pl.post_id = p.post_id
                 LEFT JOIN users u ON p.author_id = u.user_id
                 LEFT JOIN organizations comp ON p.author_org_id = comp.org_id
                 WHERE p.is_active = true AND (p.is_removed IS FALSE OR p.is_removed IS NULL)
                   AND (
                       (p.author_org_id IS NULL AND u.user_id IS NOT NULL AND (u.is_deactivated IS FALSE OR u.is_deactivated IS NULL) AND (u.is_deleted IS NULL OR u.is_deleted = FALSE))
                       OR
                       (p.author_org_id IS NOT NULL AND comp.org_id IS NOT NULL AND comp.is_deleted = FALSE AND (comp.deletion_execute_at IS NULL OR comp.deletion_execute_at > NOW()) AND comp.is_deactivated = FALSE)
                   )
                 ORDER BY pl.created_at DESC
                 LIMIT 50`;

            const result = await pool.query(query, [targetId]);
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
        const explicitActorType = req.headers["x-actor-type"];
        const explicitActorId = req.headers["x-actor-id"] || req.query.companyId || req.body?.companyId || null;
        let isOrgActor = (explicitActorType === "ORGANIZATION" || Boolean(req.query.companyId) || Boolean(req.body?.companyId)) && !!explicitActorId;
        let actorOrgId = isOrgActor ? explicitActorId : null;

        if (isOrgActor && actorOrgId) {
            const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(actorOrgId);
            if (!isUuid) {
                const orgRes = await pool.query('SELECT org_id FROM organizations WHERE slug = $1 LIMIT 1', [actorOrgId]);
                if (orgRes.rows.length > 0) {
                    actorOrgId = orgRes.rows[0].org_id;
                }
            }
        }
        const targetId = isOrgActor ? actorOrgId : req.user.sub;
        const { type, id } = req.params;

        if (type === "like") {
            if (isOrgActor) {
                await pool.query(
                    `DELETE FROM active_post_likes WHERE post_id = $1 AND org_id = $2::uuid`,
                    [id, targetId]
                );
            } else {
                await pool.query(
                    `DELETE FROM active_post_likes WHERE post_id = $1 AND user_id = $2 AND org_id IS NULL`,
                    [id, targetId]
                );
            }
        } else if (type === "tag") {
            if (isOrgActor) {
                await pool.query(
                    `UPDATE post_tags SET is_active_tag = false, updated_at = NOW()
                     WHERE (post_id::text = $1 OR tag_id::text = $1) AND tagged_user_id = $2::uuid`,
                    [id, targetId]
                );
            } else {
                await pool.query(
                    `UPDATE post_tags SET is_active_tag = false, updated_at = NOW()
                     WHERE (post_id::text = $1 OR tag_id::text = $1) AND tagged_user_id = $2`,
                    [id, targetId]
                );
            }
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
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    try {
        // Organization Context Branching
        if (req.actor && req.actor.type === "ORGANIZATION") {
            const orgId = req.actor.orgId;
            
            // 1. Fetch org blocks from primary blocks table
            const orgBlockedList = await BlockModel.getOrgBlockedUsersDetails(orgId);

            // 2. Fetch org blocks from organization_blocked_accounts fallback table
            const obaResult = await pool.query(
                `SELECT oba.blocked_id, oba.blocked_type, oba.created_at,
                        COALESCE(u.full_name, u.account_name, o.name, 'Blocked Account') AS name,
                        COALESCE(u.avatar_url, o.logo_url, '') AS avatar
                 FROM organization_blocked_accounts oba
                 LEFT JOIN users u ON oba.blocked_type = 'user' AND oba.blocked_id = u.user_id AND (u.is_deactivated IS FALSE OR u.is_deactivated IS NULL)
                 LEFT JOIN active_organizations o ON oba.blocked_type = 'company' AND oba.blocked_id = o.org_id
                 WHERE oba.org_id = $1
                   AND (u.user_id IS NOT NULL OR o.org_id IS NOT NULL)
                 ORDER BY oba.created_at DESC`,
                [orgId]
            );

            const map = new Map();
            for (const item of orgBlockedList) {
                if (!item || !item.user_id) continue;
                map.set(item.user_id, {
                    id: item.user_id,
                    type: item.entity_type === 'COMPANY' ? 'company' : 'user',
                    name: item.full_name || item.account_name || "Blocked Account",
                    created_at: item.created_at || new Date().toISOString(),
                    avatar: item.avatar_url || "",
                });
            }
            for (const row of obaResult.rows) {
                if (!map.has(row.blocked_id)) {
                    map.set(row.blocked_id, {
                        id: row.blocked_id,
                        type: row.blocked_type,
                        name: row.name,
                        date: row.created_at ? new Date(row.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "Blocked recently",
                        avatar: row.avatar,
                    });
                }
            }

            return res.status(200).json(Array.from(map.values()));
        }

        // Personal User Context Branching
        const userId = req.user.sub;

        const blockedList = await BlockModel.getBlockedUsersDetails(userId);

        const formatted = blockedList
            .filter((item) => item && item.user_id)
            .map((item) => ({
                id: item.user_id,
                type: item.entity_type === 'COMPANY' ? 'company' : 'user',
                name: item.full_name || item.account_name || "User",
                created_at: item.created_at || new Date().toISOString(),
                avatar: item.avatar_url || "",
            }));

        return res.status(200).json(formatted);
    } catch (error) {
        console.error("Get blocked users error:", error);
        return res.status(500).json({ success: false, message: "Failed to fetch blocked users" });
    }
};

/**
 * 5.2 Unblock User / Organization
 * DELETE /api/user/blocked/{id}
 */
exports.unblockUser = async (req, res) => {
    try {
        const { id } = req.params;

        // Organization Context Branching
        if (req.actor && req.actor.type === "ORGANIZATION") {
            const orgId = req.actor.orgId;
            const userId = req.user.sub;

            // Check permissions: Only Owner, Admin, or Profile Management can manage organization blocked accounts
            const isOwner = req.actor.roleName === 'Owner' || (req.actor.permissions && req.actor.permissions.includes('*'));
            const isAdmin = (req.actor.roleName || '').toUpperCase() === 'ADMIN' || isOwner;
            const hasProfileManagement = req.actor.permissions && (
                req.actor.permissions.includes('MANAGE_COMPANY_DETAILS') ||
                req.actor.permissions.includes('EDIT_COMPANY_PROFILE') ||
                req.actor.permissions.includes('REPORT_BLOCK')
            );

            if (!isOwner && !isAdmin && !hasProfileManagement) {
                return res.status(403).json({ success: false, message: "Only organization owners, administrators, or members with profile management permission can manage organization blocked accounts" });
            }

            // Look up target details before removal for audit logging and activity logs
            let targetName = null;
            let targetType = 'user';

            const blockedAccountRes = await pool.query(
                `SELECT oba.blocked_type,
                        COALESCE(u.full_name, u.account_name, o.name) AS name
                 FROM organization_blocked_accounts oba
                 LEFT JOIN active_users u ON oba.blocked_type = 'user' AND oba.blocked_id = u.user_id
                 LEFT JOIN active_organizations o ON oba.blocked_type = 'company' AND oba.blocked_id = o.org_id
                 WHERE oba.org_id = $1 AND oba.blocked_id = $2
                 LIMIT 1`,
                [orgId, id]
            );

            if (blockedAccountRes.rows.length > 0 && blockedAccountRes.rows[0].name) {
                targetName = blockedAccountRes.rows[0].name;
                targetType = blockedAccountRes.rows[0].blocked_type;
            } else {
                const userRes = await pool.query(`SELECT full_name, account_name FROM users WHERE user_id = $1`, [id]);
                if (userRes.rows.length > 0 && (userRes.rows[0].full_name || userRes.rows[0].account_name)) {
                    targetName = userRes.rows[0].full_name || userRes.rows[0].account_name;
                    targetType = 'user';
                } else {
                    const orgRes = await pool.query(`SELECT name FROM organizations WHERE org_id = $1`, [id]);
                    if (orgRes.rows.length > 0 && orgRes.rows[0].name) {
                        targetName = orgRes.rows[0].name;
                        targetType = 'company';
                    }
                }
            }

            await BlockModel.unblockUser(orgId, id, true);
            await pool.query(
                `DELETE FROM organization_blocked_accounts WHERE org_id = $1 AND blocked_id = $2`,
                [orgId, id]
            );

            await logAudit(pool, {
                entityId: orgId,
                entityType: 'ORGANIZATION',
                actorId: userId,
                action: 'ORGANIZATION_BLOCK_REMOVED',
                metadata: {
                    blockedId: id,
                    targetId: id,
                    targetName: targetName || (targetType === 'company' ? 'organization' : 'user'),
                    targetType: targetType
                }
            });

            // Dispatch real-time socket events for chat UI & conversation state
            await dispatchBlockSocketEvents({
                blockerId: orgId,
                targetId: id,
                isOrgActor: true,
                isBlocked: false,
                actorUserId: userId,
            });

            return res.status(200).json({ success: true, message: "Account unblocked for company" });
        }

        // Personal User Context Branching
        const userId = req.user.sub;

        await BlockModel.unblockUser(userId, id, false);

        // Dispatch real-time socket events for chat UI & conversation state
        await dispatchBlockSocketEvents({
            blockerId: userId,
            targetId: id,
            isOrgActor: false,
            isBlocked: false,
            actorUserId: userId,
        });

        return res.status(200).json({ success: true, message: "User unblocked successfully" });
    } catch (error) {
        console.error("Unblock user error:", error);
        return res.status(500).json({ success: false, message: "Failed to unblock account" });
    }
};

async function dispatchBlockSocketEvents({ blockerId, targetId, isOrgActor, isBlocked, actorUserId }) {
    try {
        const socketService = require("../../core/infrastructure/socket.service");

        // Find active 1-on-1 conversation between blocker & target if exists
        const convRes = await pool.query(
            `SELECT c.conversation_id
             FROM conversations c
             JOIN conversation_participants cp1 ON c.conversation_id = cp1.conversation_id AND (cp1.user_id = $1 OR cp1.org_id = $1)
             JOIN conversation_participants cp2 ON c.conversation_id = cp2.conversation_id AND (cp2.user_id = $2 OR cp2.org_id = $2)
             WHERE c.is_group = FALSE AND c.is_active = TRUE`,
            [blockerId, targetId]
        );

        const conversationId = convRes.rowCount > 0 ? convRes.rows[0].conversation_id : null;

        const payload = {
            blocker_id: blockerId,
            target_id: targetId,
            user_id: targetId,
            is_blocked: isBlocked,
            is_blocked_by_me: isBlocked,
            is_blocked_by_other: false,
            isBlocked: isBlocked,
            blocked: isBlocked,
            is_org_block: isOrgActor,
            status: isBlocked ? "blocked" : "none",
            conversation_id: conversationId,
            conversationId: conversationId,
        };

        const eventName = isBlocked ? "user_blocked" : "user_unblocked";
        const confirmEvent = isBlocked ? "block_confirmed" : "unblock_confirmed";

        // Notify Target User & Blocker User
        socketService.notifyUser(targetId, eventName, payload);
        socketService.notifyUser(targetId, "relationshipUpdated", payload);
        if (actorUserId) {
            socketService.notifyUser(actorUserId, confirmEvent, payload);
            socketService.notifyUser(actorUserId, "relationshipUpdated", payload);
            socketService.notifyUser(actorUserId, "conversation_updated", payload);
        }

        // Notify Organization Room if Org Actor
        if (isOrgActor && socketService.io) {
            const orgEvent = isBlocked ? "ORGANIZATION_USER_BLOCKED" : "ORGANIZATION_USER_UNBLOCKED";
            socketService.io.to(`org_${blockerId}`).emit(orgEvent, payload);
            socketService.io.to(`org_${blockerId}`).emit("ORGANIZATION_BLOCK_UPDATED", payload);
            socketService.io.to(`org_${blockerId}`).emit("conversation_updated", payload);
        }

        // Notify Conversation Room and all participants if conversation exists
        if (conversationId) {
            await socketService.notifyParticipants(conversationId, eventName, payload);
            await socketService.notifyParticipants(conversationId, "relationshipUpdated", payload);
            await socketService.notifyParticipants(conversationId, "conversation_updated", payload);
            await socketService.notifyParticipants(conversationId, "block_updated", payload);

            if (socketService.io) {
                const convRoom = `conversation_${conversationId}`;
                socketService.io.to(convRoom).emit(eventName, payload);
                socketService.io.to(convRoom).emit("relationshipUpdated", payload);
                socketService.io.to(convRoom).emit("block_updated", payload);
                socketService.io.to(convRoom).emit("conversation_updated", payload);
            }
        }
    } catch (err) {
        console.error("Error dispatching block socket events:", err);
    }
}

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

        const actorOrgId = req.actor?.type === "ORGANIZATION" ? (req.actor.orgId || req.headers["x-actor-id"]) : null;
        const isOrgActor = !!actorOrgId;

        let whereClause = "WHERE r.reporter_id = $1 AND r.reporter_org_id IS NULL";
        let queryParams = [userId];

        if (isOrgActor) {
            whereClause = "WHERE r.reporter_org_id = $1";
            queryParams = [actorOrgId];
        }

        const countRes = await pool.query(
            `SELECT COUNT(*) FROM reports r ${whereClause}`,
            queryParams
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
                    WHEN 'THOUGHT' THEN CONCAT('Report about a thought by @', COALESCE(cu.account_name, 'unknown'))
                    WHEN 'COMPANY' THEN CONCAT('Reported company: ', COALESCE(o.name, 'unknown'))
                    ELSE 'Reported content'
                END AS title,
                COALESCE(u.account_name, po.name, pu.account_name, cu.account_name) AS reported_username,
                CASE WHEN p.post_type = 'article' OR pc_cat.name = 'Article' OR p.is_community_article = TRUE THEN 'article' WHEN p.post_type = 'poll' THEN 'poll' ELSE p.post_type::text END AS post_type,
                (SELECT pm.url FROM post_media pm WHERE pm.post_id = p.post_id LIMIT 1) AS media_url,
                (SELECT pm.media_type FROM post_media pm WHERE pm.post_id = p.post_id LIMIT 1) AS media_type
            FROM reports r
            LEFT JOIN report_reasons rr ON r.reason_id = rr.id
            LEFT JOIN users u           ON r.target_type = 'USER'    AND r.target_id = u.user_id
            LEFT JOIN posts p           ON r.target_type = 'POST'    AND r.target_id = p.post_id
            LEFT JOIN post_categories pc_cat ON pc_cat.category_id = p.category_id
            LEFT JOIN users pu          ON p.author_id = pu.user_id
            LEFT JOIN organizations po  ON p.author_org_id = po.org_id
            LEFT JOIN post_comments pc  ON r.target_type IN ('COMMENT', 'THOUGHT') AND r.target_id = pc.comment_id
            LEFT JOIN users cu          ON pc.author_id = cu.user_id
            LEFT JOIN organizations o   ON r.target_type = 'COMPANY' AND r.target_id = o.org_id
            ${whereClause}
            ORDER BY r.created_at DESC
            LIMIT $2 OFFSET $3`,
            [...queryParams, limit, offset]
        );

        const reports = result.rows.map((row) => {
            const rawPostType = (row.post_type || '').toLowerCase();
            const normalizedPostType = (row.target_type === 'POST' && (rawPostType === 'image' || rawPostType === 'video' || rawPostType === 'text'))
                ? 'post'
                : (row.post_type || null);

            return {
                id:               row.id,
                targetType:       row.target_type,
                targetId:         row.target_id,
                reportedUsername: row.reported_username || null,
                type:             row.target_type === 'USER'
                    ? 'User profile'
                    : (row.target_type === 'COMPANY'
                        ? 'Company profile'
                        : (row.target_type
                            ? row.target_type.charAt(0).toUpperCase() + row.target_type.slice(1).toLowerCase()
                            : 'User profile')),
                date:        formatDate(row.created_at),
                reason:      row.reason_label,
                title:       row.title,
                status:      row.status || 'pending',
                statusLabel: REPORT_STATUS_LABELS[row.status] || 'Submitted',
                postType:    normalizedPostType,
                mediaType:   (row.media_type || rawPostType || '').toLowerCase() || null,
                imageUrl:    (row.media_type?.toLowerCase() === 'image' || (!row.media_type && row.media_url)) ? row.media_url : null,
                videoUrl:    row.media_type?.toLowerCase() === 'video' ? row.media_url : null,
            };
        });

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
                    WHEN 'THOUGHT' THEN CONCAT('Report about a thought by @', COALESCE(cu.account_name, 'unknown'))
                    WHEN 'COMPANY' THEN CONCAT('Reported company: ', COALESCE(o.name, 'unknown'))
                    ELSE 'Reported content'
                END AS title,
                COALESCE(u.account_name, po.name, pu.account_name, cu.account_name) AS reported_username,
                CASE WHEN p.post_type = 'article' OR pc_cat.name = 'Article' OR p.is_community_article = TRUE THEN 'article' WHEN p.post_type = 'poll' THEN 'poll' ELSE p.post_type::text END AS post_type,
                (SELECT pm.url FROM post_media pm WHERE pm.post_id = p.post_id LIMIT 1) AS media_url,
                (SELECT pm.media_type FROM post_media pm WHERE pm.post_id = p.post_id LIMIT 1) AS media_type
            FROM reports r
            LEFT JOIN report_reasons rr ON r.reason_id = rr.id
            LEFT JOIN users u           ON r.target_type = 'USER'    AND r.target_id = u.user_id
            LEFT JOIN posts p           ON r.target_type = 'POST'    AND r.target_id = p.post_id
            LEFT JOIN post_categories pc_cat ON pc_cat.category_id = p.category_id
            LEFT JOIN users pu          ON p.author_id = pu.user_id
            LEFT JOIN organizations po  ON p.author_org_id = po.org_id
            LEFT JOIN post_comments pc  ON r.target_type IN ('COMMENT', 'THOUGHT') AND r.target_id = pc.comment_id
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
        const rawPostType = (row.post_type || '').toLowerCase();
        const normalizedPostType = (row.target_type === 'POST' && (rawPostType === 'image' || rawPostType === 'video' || rawPostType === 'text'))
            ? 'post'
            : (row.post_type || null);

        return res.status(200).json({
            id:               row.id,
            targetType:       row.target_type,
            targetId:         row.target_id,
            reportedUsername: row.reported_username || null,
            type:             row.target_type === 'USER'
                ? 'User profile'
                : (row.target_type === 'COMPANY'
                    ? 'Company profile'
                    : (row.target_type
                        ? row.target_type.charAt(0).toUpperCase() + row.target_type.slice(1).toLowerCase()
                        : 'User profile')),
            date:        formatDate(row.created_at),
            reason:      row.reason_label,
            title:       row.title,
            status:      row.status || 'pending',
            statusLabel: REPORT_STATUS_LABELS[row.status] || 'Submitted',
            postType:    normalizedPostType,
            mediaType:   (row.media_type || rawPostType || '').toLowerCase() || null,
            imageUrl:    (row.media_type?.toLowerCase() === 'image' || (!row.media_type && row.media_url)) ? row.media_url : null,
            videoUrl:    row.media_type?.toLowerCase() === 'video' ? row.media_url : null,
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
