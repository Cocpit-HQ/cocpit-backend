const otpService = require("./otp.service");

/**
 * Request an OTP
 * POST /api/auth/request-otp
 */
const requestOTP = async (req, res, next) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({
                message: "Email is required to request an OTP."
            });
        }

        // Always return success to prevent email enumeration,
        // or depending on requirements, validate if user exists first.
        const result = await otpService.requestOTP(email);

        if (result && result.error) {
            return res.status(result.error.status).json({
                message: result.error.message
            });
        }

        return res.status(200).json({
            success: true,
            message: "If that email is valid, an OTP has been sent."
        });
    } catch (error) {
        // If it's a known error, we could catch it, else pass to error handler
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
