const otpService = require("./otp.service");

/**
 * Request an OTP
 * POST /api/auth/request-otp
 *
 * Body: { email: string, purpose: "signup" | "password_reset" }
 *
 * Security notes:
 *   - "signup" returns 409 if email is already registered (intentional UX: redirect to sign in)
 *   - "password_reset" always returns 200 regardless of whether the account exists,
 *     preventing account enumeration attacks. OTP is only sent internally if the account exists.
 */
const requestOTP = async (req, res, next) => {
    try {
        const { email, purpose = "signup" } = req.body;

        if (!email) {
            return res.status(400).json({
                message: "Email is required to request an OTP."
            });
        }

        const validPurposes = ["signup", "password_reset"];
        if (!validPurposes.includes(purpose)) {
            return res.status(400).json({
                message: "Invalid purpose. Must be 'signup' or 'password_reset'."
            });
        }

        const result = await otpService.requestOTP(email, purpose);

        if (result && result.error) {
            // For password_reset, NEVER expose whether the email exists — always return 200
            // For signup, surface errors (e.g. 409 duplicate) so the user knows to sign in
            if (purpose === "password_reset") {
                // Swallow the error — respond generically regardless
                return res.status(200).json({
                    success: true,
                    message: "If an account exists with that email, an OTP has been sent."
                });
            }
            return res.status(result.error.status).json({
                message: result.error.message
            });
        }

        return res.status(200).json({
            success: true,
            message: purpose === "password_reset"
                ? "If an account exists with that email, an OTP has been sent."
                : "If that email is valid, an OTP has been sent."
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
        const { email, otp } = req.body;

        if (!email || !otp) {
            return res.status(400).json({
                message: "Email and OTP are required for verification."
            });
        }

        // We pass consume=false so that the frontend can safely verify the OTP 
        // to show a green checkmark, without deleting the OTP before the final registration submit.
        const result = await otpService.verifyOTP(email, otp, false);

        if (result.error) {
            return res.status(result.error.status).json({
                message: result.error.message
            });
        }

        // 5. Mark email verified if valid - This logic is generally custom to the User table.
        // Since we are decoupling the OTP system, we return a success response here.
        // The calling client or a webhook can then update the user's verified status.
        return res.status(200).json({
            success: true,
            message: result.message
        });

    } catch (error) {
        console.error("Error verifying OTP:", error);
        next(error);
    }
};

module.exports = {
    requestOTP,
    verifyOTP
};
