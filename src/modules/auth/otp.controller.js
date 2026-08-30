const otpService = require("./otp.service");

/**
 * Request an OTP
 * POST /api/auth/request-otp
 *
 * Body: { email: string, purpose: "signup" | "password_reset" }
 */
const requestOTP = async (req, res, next) => {
    try {
        const { email, purpose = "signup", isResend = false } = req.body;

        if (!email) {
            return res.status(400).json({
                message: "Email is required to request an OTP."
            });
        }

        const validPurposes = ["signup", "password_reset", "recovery", "email_change"];
        if (!validPurposes.includes(purpose)) {
            return res.status(400).json({
                message: "Invalid purpose. Must be 'signup', 'password_reset', 'recovery', or 'email_change'."
            });
        }

        console.log(`\n📨 [API] /api/auth/request-otp called for: ${email} | Purpose: ${purpose} | isResend: ${isResend}`);
        const result = await otpService.requestOTP(email, purpose, isResend);

        if (result && result.error) {
            console.log(`❌ [API] /api/auth/request-otp failed for: ${email} - ${result.error.message}`);
            return res.status(result.error.status).json({
                success: false,
                message: result.error.message
            });
        }

        console.log(`✅ [API] /api/auth/request-otp succeeded for: ${email}`);
        return res.status(200).json({
            success: true,
            message: result.message || "A new code has been sent.",
            sessionActive: Boolean(result.sessionActive),
            verified: Boolean(result.verified),
            sessionExpiresAt: result.sessionExpiresAt || null,
            remainingSeconds: result.remainingSeconds !== undefined ? result.remainingSeconds : null,
            otpActive: Boolean(result.otpActive),
            remainingCooldown: result.remainingCooldown !== undefined ? result.remainingCooldown : 60,
            cooldownExpiresAt: result.cooldownExpiresAt || null,
            remainingExpiry: result.remainingExpiry !== undefined ? result.remainingExpiry : null,
            serverTime: result.serverTime || new Date().toISOString(),
        });
    } catch (error) {
        console.error("Error requesting OTP:", error);
        next(error);
    }
};

/**
 * Verify an OTP
 * POST /api/auth/verify-otp
 */
const verifyOTP = async (req, res, next) => {
    try {
        const { email, otp, purpose = "signup" } = req.body;

        if (!email || !otp) {
            return res.status(400).json({
                message: "Email and OTP are required for verification."
            });
        }

        // We pass consume=false so that the frontend can safely verify the OTP 
        // to show a green checkmark, without deleting the OTP before the final registration submit.
        const result = await otpService.verifyOTP(email, otp, false, purpose);

        if (result.error) {
            return res.status(result.error.status).json({
                message: result.error.message
            });
        }

        return res.status(200).json({
            success: true,
            message: result.message,
            sessionExpiresAt: result.sessionExpiresAt || null,
        });

    } catch (error) {
        console.error("Error verifying OTP:", error);
        next(error);
    }
};

/**
 * Cancel an OTP session
 * POST /api/auth/cancel-otp
 */
const cancelOTP = async (req, res, next) => {
    try {
        const { email, purpose = "signup" } = req.body;

        if (!email) {
            return res.status(400).json({
                message: "Email is required to cancel session."
            });
        }

        const result = await otpService.cancelOTP(email, purpose);
        return res.status(200).json({
            success: true,
            message: "Verification session cancelled."
        });

    } catch (error) {
        console.error("Error cancelling OTP:", error);
        next(error);
    }
};

module.exports = {
    requestOTP,
    verifyOTP,
    cancelOTP
};
