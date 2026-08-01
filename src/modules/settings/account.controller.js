const pool = require("../../core/db/pool");
const redisClient = require("../../core/db/redis");
const { comparePassword, hashPassword } = require("../../core/utils/password");
const { requestOTP, verifyOTP } = require("../auth/otp.service");
const { sendSMSOTP, verifySMSOTP } = require("../../core/services/sms.service");
const emailService = require("../../core/services/email.service");
const { revokeOtherSessions } = require("./account.service");
const socketService = require("../../core/infrastructure/socket.service");

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
            "SELECT password_hash FROM users WHERE user_id = $1",
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
            return res.status(401).json({ success: false, message: "Current password is incorrect" });
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

// Step 1: Request OTP for current email
exports.verifyCurrentEmail = async (req, res) => {
    try {
        const userId = req.user.sub;

        const userRes = await pool.query("SELECT email FROM users WHERE user_id = $1", [userId]);
        if (userRes.rowCount === 0) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        const currentEmail = userRes.rows[0].email;
        const result = await requestOTP(currentEmail, "password_reset");

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

// Step 2: Confirm OTP for current email
exports.confirmCurrentEmail = async (req, res) => {
    try {
        const userId = req.user.sub;
        const { otp } = req.body;

        const userRes = await pool.query("SELECT email FROM users WHERE user_id = $1", [userId]);
        const currentEmail = userRes.rows[0].email;

        const result = await verifyOTP(currentEmail, otp);
        if (result.error) {
            return res.status(result.error.status).json({ success: false, message: result.error.message });
        }

        if (redisClient.isOpen) {
            await redisClient.setEx(`email_change_authorized:${userId}`, 600, "1");
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

// Step 3: Submit new email & send OTP to new email
exports.submitNewEmail = async (req, res) => {
    try {
        const userId = req.user.sub;
        const { newEmail } = req.body;
        const normalizedNewEmail = newEmail.toLowerCase().trim();

        if (redisClient.isOpen) {
            const isAuthorized = await redisClient.get(`email_change_authorized:${userId}`);
            if (!isAuthorized) {
                return res.status(403).json({
                    success: false,
                    message: "Current email verification required first.",
                });
            }
        }

        const userRes = await pool.query(
            "SELECT email, password_hash FROM users WHERE user_id = $1",
            [userId]
        );
        const user = userRes.rows[0];

        if (user.email.toLowerCase() === normalizedNewEmail) {
            return res.status(400).json({ success: false, message: "New email must be different from current email" });
        }

        const emailCheck = await pool.query("SELECT 1 FROM users WHERE email = $1", [normalizedNewEmail]);
        if (emailCheck.rowCount > 0) {
            return res.status(409).json({ success: false, message: "An account with this email already exists" });
        }


        const otpResult = await requestOTP(normalizedNewEmail, "signup");
        if (otpResult.error) {
            return res.status(otpResult.error.status).json({ success: false, message: otpResult.error.message });
        }

        if (redisClient.isOpen) {
            await redisClient.setEx(`pending_email_change:${userId}`, 600, normalizedNewEmail);
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

// Step 4: Confirm OTP on new email & commit change
exports.confirmNewEmail = async (req, res) => {
    try {
        const userId = req.user.sub;
        const currentSessionId = req.user.sid;
        const { otp } = req.body;

        let pendingEmail = null;
        if (redisClient.isOpen) {
            pendingEmail = await redisClient.get(`pending_email_change:${userId}`);
        }

        if (!pendingEmail) {
            return res.status(400).json({
                success: false,
                message: "No pending email change request found or request expired. Please start over.",
            });
        }

        const result = await verifyOTP(pendingEmail, otp);
        if (result.error) {
            return res.status(result.error.status).json({ success: false, message: result.error.message });
        }

        await pool.query(
            "UPDATE users SET email = $1, updated_at = NOW() WHERE user_id = $2",
            [pendingEmail, userId]
        );

        if (redisClient.isOpen) {
            await redisClient.del(`pending_email_change:${userId}`);
            await redisClient.del(`email_change_authorized:${userId}`);
        }

        // Security Invariant (Section 7.4): Invalidate all OTHER sessions on email change
        const revokedCount = await revokeOtherSessions(userId, currentSessionId);

        return res.status(200).json({
            success: true,
            message: "Email address updated successfully. Other active sessions have been logged out for security.",
            new_email: pendingEmail,
            revoked_other_sessions: revokedCount,
        });
    } catch (error) {
        console.error("Confirm new email error:", error);
        return res.status(500).json({ success: false, message: "Failed to update email address" });
    }
};

// ─── 3. Recovery Email ───────────────────────────────────────────────────────

exports.setRecoveryEmail = async (req, res) => {
    try {
        const userId = req.user.sub;
        const { recoveryEmail } = req.body;
        const normalized = recoveryEmail.toLowerCase().trim();

        const userRes = await pool.query("SELECT email FROM users WHERE user_id = $1", [userId]);
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
        const userId = req.user.sub;
        const { otp } = req.body;

        let pendingRecoveryEmail = null;
        if (redisClient.isOpen) {
            pendingRecoveryEmail = await redisClient.get(`pending_recovery_email:${userId}`);
        }

        if (!pendingRecoveryEmail) {
            return res.status(400).json({ success: false, message: "No pending recovery email request found or expired." });
        }

        const result = await verifyOTP(pendingRecoveryEmail, otp);
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
        });
    } catch (error) {
        console.error("Confirm recovery email error:", error);
        return res.status(500).json({ success: false, message: "Failed to confirm recovery email" });
    }
};

exports.deleteRecoveryEmail = async (req, res) => {
    try {
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
        const userId = req.user.sub;
        const { phone } = req.body;

        const generatedOtp = Math.floor(100000 + Math.random() * 900000).toString();
        await sendSMSOTP(phone, generatedOtp);

        if (redisClient.isOpen) {
            await redisClient.setEx(`pending_phone:${userId}`, 600, JSON.stringify({ phone, otp: generatedOtp }));
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
        const userId = req.user.sub;
        const { otp } = req.body;

        let pendingData = null;
        if (redisClient.isOpen) {
            const raw = await redisClient.get(`pending_phone:${userId}`);
            if (raw) pendingData = JSON.parse(raw);
        }

        if (!pendingData) {
            return res.status(400).json({ success: false, message: "No pending phone verification request found or expired." });
        }

        const isValid = await verifySMSOTP(pendingData.phone, otp, pendingData.otp);
        if (!isValid) {
            return res.status(400).json({ success: false, message: "Invalid verification code" });
        }

        await pool.query(
            "UPDATE users SET mobile_number = $1, updated_at = NOW() WHERE user_id = $2",
            [pendingData.phone, userId]
        );

        if (redisClient.isOpen) {
            await redisClient.del(`pending_phone:${userId}`);
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
        const { companyResolutions = [] } = req.body;

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

        // Send restoration email
        const userFetch = await pool.query("SELECT email FROM users WHERE user_id = $1", [userId]);
        if (userFetch.rowCount > 0) {
            emailService.sendAccountDeletionEmail(userFetch.rows[0].email, deletionDate).catch(console.error);
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
