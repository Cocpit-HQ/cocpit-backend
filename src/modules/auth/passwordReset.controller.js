const { resetPassword } = require("./passwordReset.service");

/**
 * Reset password controller
 * POST /auth/reset-password
 */
exports.resetPassword = async (req, res) => {
    const { email, newPassword } = req.body;

    try {
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
