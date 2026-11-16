
const pool = require("../../core/db/pool");
const socketService = require("../../core/infrastructure/socket.service");

async function dispatchPasswordResetNotification(userId) {
    if (!userId) return;
    try {
        const notifText = "A password reset was requested for your account. If this wasn’t you, secure your account now.";
        const notifRes = await pool.query(
            `INSERT INTO notifications (user_id, sender_id, type, text, metadata)
             VALUES ($1, NULL, 'password_reset_requested', $2, $3)
             RETURNING notification_id, created_at`,
            [userId, notifText, JSON.stringify({ reason: 'password_reset_request' })]
        );

        if (socketService && typeof socketService.notifyUser === 'function') {
            socketService.notifyUser(userId, "notification", {
                notification_id: notifRes.rows[0]?.notification_id,
                type: "password_reset_requested",
                text: notifText,
                created_at: notifRes.rows[0]?.created_at || new Date().toISOString(),
                is_read: false
            });
        }
    } catch (err) {
        console.error("Failed to create password_reset_requested notification:", err);
    }
}

const passwordResetService = require("./passwordReset.service");
const otpService = require("./otp.service");

/**
 * Reset password controller (OTP-based)
 * POST /auth/reset-password
 */
exports.resetPassword = async (req, res) => {
    const { email, newPassword, otp, logoutOtherDevices, logoutOthers } = req.body;
    const shouldLogoutOthers = logoutOtherDevices ?? logoutOthers ?? true;

    try {
        const otpResult = await otpService.verifyOTP(email, otp, true, "password_reset");
        if (otpResult.error) {
            return res.status(otpResult.error.status).json({
                message: otpResult.error.message,
                success: false,
            });
        }

        const result = await passwordResetService.resetPassword(email, newPassword, shouldLogoutOthers);

        res.status(200).json({
            message: result.message,
            success: true,
        });
    } catch (err) {
        console.error("Password reset error:", err);

        if (err.message === "User not found") {
            return res.status(404).json({
                message: "We couldn't find an account with this email",
                success: false,
            });
        }

        if (err.message === "Choose a different password") {
            return res.status(400).json({
                message: "Choose a different password",
                success: false,
            });
        }

        res.status(500).json({
            message: "Failed to reset password. Please try again.",
            success: false,
        });
    }
};

/**
 * Trigger forgot password OTP email
 * POST /auth/forgot-password
 */
exports.forgotPassword = async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({ success: false, message: "Email is required" });
        }
        const normalizedEmail = email.toLowerCase().trim();
        const otpResult = await otpService.requestOTP(normalizedEmail, "password_reset");
        if (otpResult.error) {
            return res.status(otpResult.error.status).json({ success: false, message: otpResult.error.message });
        }
        return res.status(200).json({ success: true });
    } catch (err) {
        console.error("Forgot password error:", err);
        return res.status(500).json({ success: false, message: "Failed to process forgot password request" });
    }
};

/**
 * Request password reset link (Settings flow)
 * POST /auth/forgot-password-link OR /user/password-reset-link
 */
exports.requestPasswordResetLink = async (req, res) => {
    try {
        const userId = req.user?.sub;
        if (!userId) {
            return res.status(401).json({ success: false, message: "Unauthorized" });
        }

        let baseUrl = req.get('origin');
        if (!baseUrl && req.headers.referer) {
            try { baseUrl = new URL(req.headers.referer).origin; } catch (_) {}
        }
        if (!baseUrl) {
            baseUrl = process.env.CLIENT_URL || null;
        }
        const result = await passwordResetService.requestPasswordResetLink(userId, baseUrl);
        return res.status(200).json(result);
    } catch (err) {
        console.error("Request password reset link error:", err);
        return res.status(500).json({ success: false, message: err.message || "Failed to send password reset email" });
    }
};

/**
 * Verify reset token link validity
 * GET /auth/verify-reset-token
 */
exports.verifyResetToken = async (req, res) => {
    try {
        const { token } = req.query;
        const result = await passwordResetService.verifyResetToken(token);
        return res.status(200).json(result);
    } catch (err) {
        console.error("Verify reset token error:", err);
        return res.status(500).json({ valid: false, reason: "invalid" });
    }
};

/**
 * Complete link-based password reset
 * POST /auth/reset-password-token
 */
exports.resetPasswordWithToken = async (req, res) => {
    try {
        // Extract logoutOtherDevices flag to support keeping other devices signed in after link-based password reset
        const { token, newPassword, logoutOtherDevices, logoutOthers } = req.body;
        if (!token || !newPassword) {
            return res.status(400).json({ success: false, message: "Token and new password are required" });
        }
        const shouldLogoutOthers = logoutOtherDevices ?? logoutOthers ?? true;

        const result = await passwordResetService.resetPasswordWithToken(token, newPassword, shouldLogoutOthers);
        return res.status(200).json(result);
    } catch (err) {
        console.error("Reset password with token error:", err);
        return res.status(400).json({ success: false, message: err.message || "Failed to reset password" });
    }
};

/**
 * Check active reset link status (for settings page UI button hide/cooldown timer)
 * GET /auth/reset-link-status
 */
exports.getResetLinkStatus = async (req, res) => {
    try {
        const userId = req.user?.sub;
        if (!userId) {
            return res.status(401).json({ success: false, message: "Unauthorized" });
        }

        const result = await passwordResetService.getActiveResetLinkStatus(userId);
        return res.status(200).json(result);
    } catch (err) {
        console.error("Get reset link status error:", err);
        return res.status(500).json({ hasActiveLink: false, remainingSeconds: 0 });
    }
};

/**
 * Live validation for old password comparison on blur
 * POST /auth/validate-password
 */
exports.validatePassword = async (req, res) => {
    try {
        const { email, token, password } = req.body;
        const result = await passwordResetService.validatePassword({ email, token, password });
        return res.status(200).json(result);
    } catch (err) {
        console.error("Validate password error:", err);
        return res.status(200).json({ isSamePassword: false });
    }
};
