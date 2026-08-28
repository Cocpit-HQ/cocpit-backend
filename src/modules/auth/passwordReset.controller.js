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
        const otpResult = await otpService.verifyOTP(email, otp);
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

        const result = await passwordResetService.requestPasswordResetLink(userId);
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
        const { token, newPassword } = req.body;
        if (!token || !newPassword) {
            return res.status(400).json({ success: false, message: "Token and new password are required" });
        }

        const result = await passwordResetService.resetPasswordWithToken(token, newPassword);
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
