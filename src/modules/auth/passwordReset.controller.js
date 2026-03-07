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
