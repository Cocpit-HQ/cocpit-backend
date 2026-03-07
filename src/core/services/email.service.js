const { Resend } = require("resend");

// Initialize Resend with API key
// We avoid crashing on startup if key is missing, but log a warning
let resend;
if (process.env.RESEND_API_KEY) {
    resend = new Resend(process.env.RESEND_API_KEY);
} else {
    console.warn("⚠️ RESEND_API_KEY is not defined. Email service will fail when called.");
}

/**
 * Sends an OTP email to the specified user.
 * @param {string} email - The user's email address
 * @param {string} otp - The 6-digit OTP code to send
 * @returns {Promise<Object>} The Resend API response
 */
const sendOTPEmail = async (email, otp) => {
    if (!resend) {
        throw new Error("Email service is not configured (RESEND_API_KEY missing).");
    }

    try {
        const { data, error } = await resend.emails.send({
            from: "Cocpit <noreply@cocpit.in>",
            to: [email],
            subject: "Cocpit Email Verification Code",
            html: `
                <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
                    <h2>Hello,</h2>
                    <p>Your Cocpit verification code is:</p>
                    <h1 style="font-size: 32px; letter-spacing: 4px; color: #007bff;">${otp}</h1>
                    <p>This code expires in 5 minutes.</p>
                    <p>If you did not request this code, you can ignore this email.</p>
                </div>
            `,
        });

        if (error) {
            console.error("Resend error:", error);
            throw new Error(error.message || "Failed to send OTP email");
        }

        return data;
    } catch (err) {
        console.error("Failed to send email to:", email, err);
        throw err;
    }
};

module.exports = {
    sendOTPEmail,
};
