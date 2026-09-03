const pool = require("../../core/db/pool");
const redisClient = require("../../core/db/redis");
const { comparePassword, hashPassword } = require("../../core/utils/password");
const { requestOTP, verifyOTP } = require("../auth/otp.service");
const { sendSMSOTP, verifySMSOTP } = require("../../core/services/sms.service");
const emailService = require("../../core/services/email.service");
const { revokeOtherSessions } = require("./account.service");
const socketService = require("../../core/infrastructure/socket.service");
const { notifyDocumentVerified, notifyOrgDocumentVerified } = require("../notification/notification.service");

// ─── 1. Change Password ───────────────────────────────────────────────────────

exports.changePassword = async (req, res) => {
    try {
        const userId = req.user.sub;
        const currentSessionId = req.user.sid;
        const { currentPassword, newPassword, confirmPassword } = req.body;

        if (newPassword !== confirmPassword) {
            return res.status(400).json({ success: false, message: "New password and confirm password do not match" });
        }

        const userRes = await pool.query(
            "SELECT email, password_hash FROM users WHERE user_id = $1",
            [userId]
        );

        if (userRes.rowCount === 0) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        const user = userRes.rows[0];
        if (!user.password_hash) {
            return res.status(400).json({
                success: false,
                message: "No password is set on this account (OAuth login). Please use password reset instead.",
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
            "UPDATE users SET password_hash = $1, updated_at = NOW() WHERE user_id = $2",
            [newHash, userId]
        );

        // Security Invariant (Section 7.4): Invalidate all OTHER sessions
        const revokedCount = await revokeOtherSessions(userId, currentSessionId);

        // ─── Trigger Password Changed Notification (Row 2) ───
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

            if (socketService.io) {
                socketService.notifyUser(userId, {
                    type: 'password_changed',
                    title: 'Your password was changed',
                    text: msgText,
                    created_at: now.toISOString()
                });
            }

            if (user.email) {
                emailService.sendPasswordChangedEmail(user.email, `${dateStr}, ${timeStr}`).catch(e => console.error(e));
            }
        } catch (e) {
            console.error("Failed to trigger password changed notification:", e);
        }

        return res.status(200).json({
            success: true,
            message: "Password updated successfully. Other active sessions have been logged out for security.",
            revoked_other_sessions: revokedCount,
        });
    } catch (error) {
        console.error("Change password error:", error);
        return res.status(500).json({ success: false, message: "Failed to change password" });
    }
};

// ─── 2. Primary Email Change (4-Step Flow) ───────────────────────────────────

// Step 1: Request OTP for current email (User or Organization)
exports.verifyCurrentEmail = async (req, res) => {
    try {
        const isOrgActor = req.actor && req.actor.type === "ORGANIZATION";
        const actorId = isOrgActor ? req.actor.orgId : req.user.sub;
        let currentEmail = "";

        if (isOrgActor) {
            const orgRes = await pool.query(
                "SELECT email FROM organizations WHERE org_id = $1 AND is_deleted = FALSE",
                [actorId]
            );
            if (orgRes.rowCount === 0) {
                return res.status(404).json({ success: false, message: "Organization not found" });
            }
            currentEmail = orgRes.rows[0].email;
        } else {
            const userRes = await pool.query("SELECT email FROM users WHERE user_id = $1", [actorId]);
            if (userRes.rowCount === 0) {
                return res.status(404).json({ success: false, message: "User not found" });
            }
            currentEmail = userRes.rows[0].email;
        }

        if (!currentEmail) {
            return res.status(400).json({ success: false, message: "No email address registered for this account" });
        }

        const result = await requestOTP(currentEmail, "email_change");

        if (result.error) {
            return res.status(result.error.status).json({ success: false, message: result.error.message });
        }

        return res.status(200).json({
            success: true,
            message: "Verification OTP sent to your current email address.",
        });
    } catch (error) {
        console.error("Verify current email error:", error);
        return res.status(500).json({ success: false, message: "Failed to send verification OTP" });
    }
};

// Step 2: Confirm OTP for current email (User or Organization)
exports.confirmCurrentEmail = async (req, res) => {
    try {
        const isOrgActor = req.actor && req.actor.type === "ORGANIZATION";
        const actorId = isOrgActor ? req.actor.orgId : req.user.sub;
        const { otp } = req.body;
        let currentEmail = "";

        if (isOrgActor) {
            const orgRes = await pool.query("SELECT email FROM organizations WHERE org_id = $1 AND is_deleted = FALSE", [actorId]);
            if (orgRes.rowCount === 0) {
                return res.status(404).json({ success: false, message: "Organization not found" });
            }
            currentEmail = orgRes.rows[0].email;
        } else {
            const userRes = await pool.query("SELECT email FROM users WHERE user_id = $1", [actorId]);
            if (userRes.rowCount === 0) {
                return res.status(404).json({ success: false, message: "User not found" });
            }
            currentEmail = userRes.rows[0].email;
        }

        const result = await verifyOTP(currentEmail, otp, true, "email_change");
        if (result.error) {
            return res.status(result.error.status).json({ success: false, message: result.error.message });
        }

        const authKey = isOrgActor ? `email_change_authorized:org:${actorId}` : `email_change_authorized:${actorId}`;
        if (redisClient.isOpen) {
            await redisClient.setEx(authKey, 600, "1");
        }

        return res.status(200).json({
            success: true,
            message: "Current email verified successfully. You may now enter your new email address.",
        });
    } catch (error) {
        console.error("Confirm current email error:", error);
        return res.status(500).json({ success: false, message: "Failed to confirm current email OTP" });
    }
};

// Step 3: Submit new email & send OTP to new email (User or Organization)
exports.submitNewEmail = async (req, res) => {
    try {
        const isOrgActor = req.actor && req.actor.type === "ORGANIZATION";
        const actorId = isOrgActor ? req.actor.orgId : req.user.sub;
        const { newEmail } = req.body;
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!newEmail || typeof newEmail !== "string" || !emailRegex.test(newEmail.trim())) {
            return res.status(400).json({ success: false, message: "Please enter a valid email address." });
        }
        const normalizedNewEmail = newEmail.toLowerCase().trim();

        const authKey = isOrgActor ? `email_change_authorized:org:${actorId}` : `email_change_authorized:${actorId}`;
        const pendingKey = isOrgActor ? `pending_email_change:org:${actorId}` : `pending_email_change:${actorId}`;

        if (redisClient.isOpen) {
            const isAuthorized = await redisClient.get(authKey);
            if (!isAuthorized) {
                return res.status(403).json({
                    success: false,
                    message: "Current email verification required first.",
                });
            }
        }

        let currentEmail = "";
        if (isOrgActor) {
            const orgRes = await pool.query("SELECT email FROM organizations WHERE org_id = $1 AND is_deleted = FALSE", [actorId]);
            currentEmail = orgRes.rows[0]?.email || "";
        } else {
            const userRes = await pool.query("SELECT email FROM users WHERE user_id = $1", [actorId]);
            currentEmail = userRes.rows[0]?.email || "";
        }

        if (currentEmail && currentEmail.toLowerCase() === normalizedNewEmail) {
            return res.status(400).json({ success: false, message: "New email must be different from current email" });
        }

        const userCheck = await pool.query("SELECT 1 FROM users WHERE LOWER(email) = $1", [normalizedNewEmail]);
        const orgCheck = await pool.query(
            "SELECT 1 FROM organizations WHERE LOWER(email) = $1 AND is_deleted = FALSE AND org_id != $2",
            [normalizedNewEmail, isOrgActor ? actorId : '00000000-0000-0000-0000-000000000000']
        );
        if (userCheck.rowCount > 0 || orgCheck.rowCount > 0) {
            return res.status(409).json({ success: false, message: "An account with this email already exists" });
        }

        const otpResult = await requestOTP(normalizedNewEmail, "email_change");
        if (otpResult.error) {
            return res.status(otpResult.error.status).json({ success: false, message: otpResult.error.message });
        }

        if (redisClient.isOpen) {
            await redisClient.setEx(pendingKey, 600, normalizedNewEmail);
        }

        return res.status(200).json({
            success: true,
            message: "Verification OTP sent to your new email address.",
        });
    } catch (error) {
        console.error("Submit new email error:", error);
        return res.status(500).json({ success: false, message: "Failed to submit new email" });
    }
};

// Step 4: Confirm OTP on new email & commit change (User or Organization)
exports.confirmNewEmail = async (req, res) => {
    try {
        const isOrgActor = req.actor && req.actor.type === "ORGANIZATION";
        const actorId = isOrgActor ? req.actor.orgId : req.user.sub;
        const currentSessionId = req.user.sid;
        const { otp } = req.body;

        const authKey = isOrgActor ? `email_change_authorized:org:${actorId}` : `email_change_authorized:${actorId}`;
        const pendingKey = isOrgActor ? `pending_email_change:org:${actorId}` : `pending_email_change:${actorId}`;

        let pendingEmail = null;
        if (redisClient.isOpen) {
            pendingEmail = await redisClient.get(pendingKey);
        }

        if (!pendingEmail) {
            return res.status(400).json({
                success: false,
                message: "No pending email change request found or request expired. Please start over.",
            });
        }

        const result = await verifyOTP(pendingEmail, otp, true, "email_change");
        if (result.error) {
            return res.status(result.error.status).json({ success: false, message: result.error.message });
        }

        let oldEmail = "";
        try {
            const oldEmailRes = isOrgActor 
                ? await pool.query("SELECT email FROM organizations WHERE org_id = $1", [actorId])
                : await pool.query("SELECT email FROM users WHERE user_id = $1", [actorId]);
            oldEmail = oldEmailRes.rows[0]?.email;
        } catch(e) {}

        if (isOrgActor) {
            await pool.query(
                "UPDATE organizations SET email = $1, updated_at = NOW() WHERE org_id = $2",
                [pendingEmail, actorId]
            );
        } else {
            await pool.query(
                "UPDATE users SET email = $1, updated_at = NOW() WHERE user_id = $2",
                [pendingEmail, actorId]
            );
        }

        if (redisClient.isOpen) {
            await redisClient.del(pendingKey);
            await redisClient.del(authKey);
        }

        let revokedCount = 0;
        if (!isOrgActor) {
            // Security Invariant: Invalidate all OTHER user sessions on email change
            revokedCount = await revokeOtherSessions(actorId, currentSessionId);
            
            // ─── Trigger Email Changed Notification (Row 4) ───
            try {
                await pool.query(
                    `INSERT INTO notifications (user_id, type, text, is_read, metadata)
                     VALUES ($1, 'email_changed', $2, false, $3)`,
                    [actorId, `Your account email was changed to ${pendingEmail}.`, JSON.stringify({ title: 'Your email address was updated' })]
                );
                
                if (socketService.io) {
                    socketService.notifyUser(actorId, {
                        type: 'email_changed',
                        title: 'Your email address was updated',
                        text: `Your account email was changed to ${pendingEmail}.`,
                        created_at: new Date().toISOString()
                    });
                }
                
                emailService.sendEmailAddressChangedEmail(pendingEmail, pendingEmail).catch(e => console.error(e));
                if (oldEmail && oldEmail !== pendingEmail) {
                    emailService.sendEmailAddressChangedEmail(oldEmail, pendingEmail).catch(e => console.error(e));
                }
            } catch (e) {
                console.error("Email changed notification error:", e);
            }
        }

        return res.status(200).json({
            success: true,
            message: "Email address updated successfully.",
            new_email: pendingEmail,
            revoked_other_sessions: revokedCount,
        });
    } catch (error) {
        console.error("Confirm new email error:", error);
        return res.status(500).json({ success: false, message: "Failed to update email address" });
    }
};

// ─── 3. Recovery Email (User or Organization) ───────────────────────────────

// ─── 3. Recovery Email (Personal User Accounts Only) ─────────────────────────

exports.setRecoveryEmail = async (req, res) => {
    try {
        if (req.actor && req.actor.type === "ORGANIZATION") {
            return res.status(400).json({
                success: false,
                message: "Recovery email is not supported for Organization accounts.",
            });
        }

        const userId = req.user.sub;
        const { recoveryEmail } = req.body;
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!recoveryEmail || typeof recoveryEmail !== "string" || !emailRegex.test(recoveryEmail.trim())) {
            return res.status(400).json({ success: false, message: "Please enter a valid email address." });
        }
        const normalized = recoveryEmail.toLowerCase().trim();

        const userRes = await pool.query("SELECT email FROM users WHERE user_id = $1", [userId]);
        if (userRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: "User not found" });
        }
        if (userRes.rows[0].email.toLowerCase() === normalized) {
            return res.status(400).json({ success: false, message: "Recovery email cannot be the same as primary email" });
        }

        const checkRecoveryInUse = await pool.query(
            `SELECT 1 FROM users WHERE LOWER(recovery_email) = $1 AND user_id != $2`,
            [normalized, userId]
        );
        if (checkRecoveryInUse.rowCount > 0) {
            return res.status(409).json({
                success: false,
                message: "This recovery email is already in use by another account."
            });
        }

        const otpResult = await requestOTP(normalized, "recovery");
        if (otpResult.error) {
            return res.status(otpResult.error.status).json({ success: false, message: otpResult.error.message });
        }

        if (redisClient.isOpen) {
            await redisClient.setEx(`pending_recovery_email:${userId}`, 600, normalized);
        }

        return res.status(200).json({
            success: true,
            message: "Verification OTP sent to recovery email address.",
        });
    } catch (error) {
        console.error("Set recovery email error:", error);
        return res.status(500).json({ success: false, message: "Failed to request recovery email verification" });
    }
};

exports.confirmRecoveryEmail = async (req, res) => {
    try {
        if (req.actor && req.actor.type === "ORGANIZATION") {
            return res.status(400).json({
                success: false,
                message: "Recovery email is not supported for Organization accounts.",
            });
        }

        const userId = req.user.sub;
        const { otp } = req.body;

        let pendingRecoveryEmail = null;
        if (redisClient.isOpen) {
            pendingRecoveryEmail = await redisClient.get(`pending_recovery_email:${userId}`);
        }

        if (!pendingRecoveryEmail) {
            return res.status(400).json({ success: false, message: "No pending recovery email request found or expired." });
        }

        const result = await verifyOTP(pendingRecoveryEmail, otp, true, "recovery");
        if (result.error) {
            return res.status(result.error.status).json({ success: false, message: result.error.message });
        }

        await pool.query(
            "UPDATE users SET recovery_email = $1, recovery_email_verified_at = NOW(), updated_at = NOW() WHERE user_id = $2",
            [pendingRecoveryEmail, userId]
        );

        if (redisClient.isOpen) {
            await redisClient.del(`pending_recovery_email:${userId}`);
        }

        return res.status(200).json({
            success: true,
            message: "Recovery email set and verified successfully.",
            recovery_email: pendingRecoveryEmail,
            recoveryEmail: pendingRecoveryEmail,
        });
    } catch (error) {
        console.error("Confirm recovery email error:", error);
        return res.status(500).json({ success: false, message: "Failed to confirm recovery email" });
    }
};

exports.deleteRecoveryEmail = async (req, res) => {
    try {
        if (req.actor && req.actor.type === "ORGANIZATION") {
            return res.status(400).json({
                success: false,
                message: "Recovery email is not supported for Organization accounts.",
            });
        }

        const userId = req.user.sub;

        await pool.query(
            "UPDATE users SET recovery_email = NULL, recovery_email_verified_at = NULL, updated_at = NOW() WHERE user_id = $1",
            [userId]
        );

        return res.status(200).json({ success: true, message: "Recovery email removed successfully." });
    } catch (error) {
        console.error("Delete recovery email error:", error);
        return res.status(500).json({ success: false, message: "Failed to delete recovery email" });
    }
};

// ─── 4. Manage Phone Number ───────────────────────────────────────────────────

exports.setPhone = async (req, res) => {
    try {
        const isOrgActor = req.actor && req.actor.type === "ORGANIZATION";
        const actorKey = isOrgActor ? `org:${req.actor.orgId}` : `user:${req.user.sub}`;
        const userId = req.user.sub;
        const { phone } = req.body;

        const generatedOtp = Math.floor(100000 + Math.random() * 900000).toString();
        await sendSMSOTP(phone, generatedOtp);

        if (redisClient.isOpen) {
            await redisClient.setEx(`pending_phone:${actorKey}`, 600, JSON.stringify({ phone, otp: generatedOtp }));
            if (!isOrgActor) {
                await redisClient.setEx(`pending_phone:${userId}`, 600, JSON.stringify({ phone, otp: generatedOtp }));
            }
        }

        return res.status(200).json({
            success: true,
            message: "OTP sent to phone number.",
        });
    } catch (error) {
        console.error("Set phone error:", error);
        return res.status(500).json({ success: false, message: "Failed to send phone OTP" });
    }
};

exports.confirmPhone = async (req, res) => {
    try {
        const isOrgActor = req.actor && req.actor.type === "ORGANIZATION";
        const actorKey = isOrgActor ? `org:${req.actor.orgId}` : `user:${req.user.sub}`;
        const userId = req.user.sub;
        const { otp } = req.body;

        let pendingData = null;
        if (redisClient.isOpen) {
            let raw = await redisClient.get(`pending_phone:${actorKey}`);
            if (!raw && !isOrgActor) {
                raw = await redisClient.get(`pending_phone:${userId}`);
            }
            if (raw) pendingData = JSON.parse(raw);
        }

        if (!pendingData) {
            return res.status(400).json({ success: false, message: "No pending phone verification request found or expired." });
        }

        const isValid = await verifySMSOTP(pendingData.phone, otp, pendingData.otp);
        if (!isValid) {
            return res.status(400).json({ success: false, message: "Invalid verification code" });
        }

        if (isOrgActor) {
            await pool.query(
                "UPDATE organizations SET phone = $1, updated_at = NOW() WHERE org_id = $2",
                [pendingData.phone, req.actor.orgId]
            );
        } else {
            await pool.query(
                "UPDATE users SET mobile_number = $1, updated_at = NOW() WHERE user_id = $2",
                [pendingData.phone, userId]
            );
        }

        if (redisClient.isOpen) {
            await redisClient.del(`pending_phone:${actorKey}`);
            if (!isOrgActor) {
                await redisClient.del(`pending_phone:${userId}`);
            }
        }

        return res.status(200).json({
            success: true,
            message: "Phone number updated successfully.",
            phone: pendingData.phone,
        });
    } catch (error) {
        console.error("Confirm phone error:", error);
        return res.status(500).json({ success: false, message: "Failed to confirm phone number" });
    }
};

// ─── 5. Log Out Current Session ──────────────────────────────────────────────

exports.logoutCurrentSession = async (req, res) => {
    try {
        const userId = req.user.sub;
        const sessionId = req.user.sid;

        await pool.query("DELETE FROM refresh_tokens WHERE session_id = $1", [sessionId]);

        if (redisClient.isOpen) {
            await redisClient.setEx(`revoked_session:${sessionId}`, 15 * 60, "1");
        }

        socketService.disconnectUserSession(userId, sessionId).catch(console.error);
        res.clearCookie("refreshToken");

        return res.status(200).json({ success: true, message: "Logged out successfully" });
    } catch (error) {
        console.error("Logout current session error:", error);
        return res.status(500).json({ success: false, message: "Failed to log out" });
    }
};

// ─── 6. Account Deletion Context & Initiation ───────────────────────────────

exports.getDeletionContext = async (req, res) => {
    try {
        const userId = req.user.sub;

        // Fetch all owned companies
        const orgRes = await pool.query(
            "SELECT org_id, name, logo_url FROM organizations WHERE created_by = $1 AND is_deleted = FALSE",
            [userId]
        );

        const ownedCompanies = [];

        for (const company of orgRes.rows) {
            // Fetch eligible followers for ownership transfer
            const followersRes = await pool.query(
                `SELECT u.user_id AS id, u.full_name, u.account_name, u.avatar_url
                 FROM followers f
                 JOIN active_users u ON u.user_id = f.follower_id
                 WHERE f.following_id = $1`,
                [userId]
            );

            ownedCompanies.push({
                org_id: company.org_id,
                name: company.name,
                logo_url: company.logo_url,
                eligible_followers: followersRes.rows,
                can_transfer: followersRes.rows.length > 0,
            });
        }

        return res.status(200).json({
            success: true,
            owned_companies: ownedCompanies,
            owns_companies: ownedCompanies.length > 0,
            company_count: ownedCompanies.length,
        });
    } catch (error) {
        console.error("Get deletion context error:", error);
        return res.status(500).json({ success: false, message: "Failed to fetch deletion context" });
    }
};

exports.initiateAccountDeletion = async (req, res) => {
    const client = await pool.connect();
    try {
        const userId = req.user.sub;
        const { password, idToken, companyResolutions = [] } = req.body;

        const { comparePassword } = require("../../core/utils/password");
        const { verifyGoogleToken } = require("../auth/googleAuth.service");

        // 1. Fetch user record for identity verification
        const userRes = await client.query(
            "SELECT user_id, email, password_hash, google_id FROM users WHERE user_id = $1",
            [userId]
        );

        if (userRes.rowCount === 0) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        const userObj = userRes.rows[0];

        // 2. Identity verification — Password user OR Google user
        let isAuthenticated = false;

        if (userObj.password_hash) {
            if (!password) {
                return res.status(400).json({ success: false, message: "Password is required to delete your account" });
            }
            const isValid = await comparePassword(password, userObj.password_hash);
            if (isValid) {
                isAuthenticated = true;
            } else {
                return res.status(400).json({ success: false, message: "Invalid password" });
            }
        } else if (userObj.google_id) {
            if (!idToken) {
                return res.status(400).json({ success: false, message: "Google re-authentication is required to delete your account." });
            }
            try {
                const googlePayload = await verifyGoogleToken(idToken);
                if (googlePayload.googleId === userObj.google_id) {
                    isAuthenticated = true;
                } else {
                    return res.status(400).json({ success: false, message: "Google account does not match this account." });
                }
            } catch {
                return res.status(400).json({ success: false, message: "Invalid Google token. Please re-authenticate and try again." });
            }
        } else {
            isAuthenticated = true;
        }

        if (!isAuthenticated) {
            return res.status(400).json({ success: false, message: "Password or authentication is required to delete your account" });
        }

        // Fetch owned active companies
        const orgRes = await client.query(
            "SELECT org_id FROM organizations WHERE created_by = $1 AND is_deleted = FALSE",
            [userId]
        );
        const ownedOrgIds = new Set(orgRes.rows.map((r) => r.org_id));

        // Validate that every owned company has a resolution
        for (const orgId of ownedOrgIds) {
            const resItem = companyResolutions.find((r) => r.orgId === orgId);
            if (!resItem) {
                return res.status(400).json({
                    success: false,
                    message: `Must select an action (delete or transfer) for owned company ID: ${orgId}`,
                });
            }
        }

        await client.query("BEGIN");

        // Execute resolutions
        for (const resolution of companyResolutions) {
            if (!ownedOrgIds.has(resolution.orgId)) continue;

            if (resolution.action === "transfer") {
                if (!resolution.newOwnerId) {
                    await client.query("ROLLBACK");
                    return res.status(400).json({
                        success: false,
                        message: `New owner ID is required for transferring ownership of company ${resolution.orgId}`,
                    });
                }
                await client.query(
                    "UPDATE organizations SET created_by = $1, updated_at = NOW() WHERE org_id = $2",
                    [resolution.newOwnerId, resolution.orgId]
                );
            } else if (resolution.action === "delete") {
                await client.query(
                    "UPDATE organizations SET is_deleted = TRUE, deleted_at = NOW(), updated_at = NOW() WHERE org_id = $1",
                    [resolution.orgId]
                );
            }
        }

        // Soft-delete user (40-day recovery window)
        const deletionDate = new Date();
        deletionDate.setDate(deletionDate.getDate() + 40);

        await client.query(
            "UPDATE users SET deletion_execute_at = $1, updated_at = NOW() WHERE user_id = $2",
            [deletionDate, userId]
        );

        // Delete all active refresh tokens for user
        const tokenRes = await client.query(
            "DELETE FROM refresh_tokens WHERE user_id = $1 RETURNING session_id",
            [userId]
        );

        await client.query("COMMIT");

        // Cleanup Redis and socket sessions
        const sessionIds = tokenRes.rows.map((r) => r.session_id);
        if (redisClient.isOpen) {
            for (const sid of sessionIds) {
                await redisClient.setEx(`revoked_session:${sid}`, 15 * 60, "1");
            }
        }
        for (const sid of sessionIds) {
            socketService.disconnectUserSession(userId, sid).catch(console.error);
        }

        // Broadcast user deletion socket events to invalidate real-time chat and post caches for other clients
        if (socketService?.io) {
            socketService.io.emit('user_deleted', { userId });
            socketService.io.emit('USER_DELETED', { userId });
            socketService.io.emit('user_deactivated', { userId });
            socketService.io.emit('USER_DEACTIVATED', { userId });
            socketService.io.emit('account_state_changed', { userId, type: 'user', action: 'deleted' });
        }

        // Send deletion emails to primary email only
        const userFetch = await pool.query("SELECT email, full_name FROM users WHERE user_id = $1", [userId]);
        if (userFetch.rowCount > 0 && userFetch.rows[0].email) {
            const userObj = userFetch.rows[0];
            emailService.sendAccountDeletionEmail(userObj.email, userObj.full_name, null, deletionDate)
                .catch((err) => console.error(`[initiateAccountDeletion] Failed to send deletion email to ${userObj.email}:`, err));
            emailService.sendAccountDeletionCompletedEmail(userObj.email).catch(e => console.error(e));
        }

        return res.status(200).json({
            success: true,
            message: "Account scheduled for deletion in 40 days. Check your email for recovery instructions.",
            deletion_execute_at: deletionDate,
        });
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("Initiate account deletion error:", error);
        return res.status(500).json({ success: false, message: "Failed to initiate account deletion" });
    } finally {
        client.release();
    }
};


// ─── 6. Verify Identity (Mock) ────────────────────────────────────────────────

exports.verifyIdentity = async (req, res) => {
    try {
        const isOrgActor = req.actor && req.actor.type === 'ORGANIZATION';
        const actorId = isOrgActor ? req.actor.orgId : req.user.sub;

        const documentType = req.body.documentType || 'ID';

        const frontImage = req.files && req.files.frontImage ? req.files.frontImage[0] : null;
        const backImage = req.files && req.files.backImage ? req.files.backImage[0] : null;

        if (!frontImage) {
            return res.status(400).json({ success: false, message: 'Front image is required' });
        }

        const frontImageUrl = frontImage.path || frontImage.url || frontImage.secure_url;
        const backImageUrl = backImage ? (backImage.path || backImage.url || backImage.secure_url) : null;

        const pool = require('../../core/db/pool');

        if (isOrgActor) {
            const { legalName, incorporationDay, incorporationMonth, incorporationYear } = req.body;
            let incorporationDate = null;
            if (incorporationDay && incorporationMonth && incorporationYear) {
                const monthMap = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
                const mm = monthMap[incorporationMonth] || '01';
                const dd = String(incorporationDay).padStart(2, '0');
                incorporationDate = `${incorporationYear}-${mm}-${dd}`;
            }

            await pool.query(
                'INSERT INTO organization_verifications (org_id, verification_type, document_type, document_urls, is_verified, legal_name, incorporation_date) VALUES ($1, $2, $3, $4, $5, $6, $7)',
                [actorId, 'IDENTITY', documentType, JSON.stringify([frontImageUrl, backImageUrl].filter(Boolean)), true, legalName || null, incorporationDate]
            );
            await pool.query('UPDATE organizations SET verification_status = $1, legal_name = $2, incorporation_date = $3 WHERE org_id = $4', ['VERIFIED', legalName || null, incorporationDate, actorId]);
            await notifyOrgDocumentVerified(actorId);
        } else {
            await pool.query(
                'INSERT INTO user_verifications (user_id, verification_type, document_type, front_image_url, back_image_url, is_verified, status) VALUES ($1, $2, $3, $4, $5, $6, $7)',
                [actorId, 'IDENTITY', documentType, frontImageUrl, backImageUrl, true, 'VERIFIED']
            );
            await pool.query('UPDATE users SET is_identity_verified = true WHERE user_id = $1', [actorId]);
            await notifyDocumentVerified(actorId);
        }

        return res.status(200).json({ success: true, message: 'Identity verified successfully' });
    } catch (error) {
        console.error('Verify identity error:', error);
        return res.status(500).json({ success: false, message: 'Failed to verify identity' });
    }
};
