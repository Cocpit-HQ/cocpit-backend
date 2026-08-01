const { resetPassword } = require("./passwordReset.service");
const otpService = require("./otp.service");

/**
 * Reset password controller
 * POST /auth/reset-password
 */
exports.resetPassword = async (req, res) => {
    const { email, newPassword, otp } = req.body;

    try {
        const otpResult = await otpService.verifyOTP(email, otp);
        if (otpResult.error) {
            return res.status(otpResult.error.status).json({
                message: otpResult.error.message,
                success: false,
            });
        }

        const result = await resetPassword(email, newPassword);

        res.status(200).json({
            message: result.message,
            success: true,
        });
    } catch (err) {
        console.error("Password reset error:", err);

        if (err.message === "User not found") {
            return res.status(404).json({
                message: "No account found with this email address",
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

