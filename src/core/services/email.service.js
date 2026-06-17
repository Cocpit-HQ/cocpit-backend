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


/**
 * Sends an account deletion scheduled email with a one-click restore link.
 * @param {string} email - The user's email address
 * @param {string} fullName - The user's display name
 * @param {string} restoreToken - Raw restore token (embedded in link, not stored)
 * @param {Date}   deletionDate - The scheduled permanent deletion date
 */
const sendAccountDeletionEmail = async (email, fullName, restoreToken, deletionDate) => {
    if (!resend) {
        throw new Error("Email service is not configured (RESEND_API_KEY missing).");
    }

    const frontendUrl = process.env.FRONTEND_URL || (process.env.NODE_ENV === "staging" ? "https://staging.cocpit.com" : "http://localhost:3000");
    const restoreLink = `${frontendUrl}/restore-account?token=${restoreToken}`;
    const deletionDateStr = new Date(deletionDate).toLocaleDateString("en-US", {
        year: "numeric", month: "long", day: "numeric",
    });

    try {
        const { data, error } = await resend.emails.send({
            from: "Cocpit <noreply@cocpit.in>",
            to: [email],
            subject: "Your Cocpit account is scheduled for deletion",
            html: `
                <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 560px; margin: 0 auto;">
                    <div style="background: #0a0f1e; padding: 24px 32px; border-radius: 8px 8px 0 0;">
                        <h2 style="color: #ffffff; margin: 0; font-size: 22px;">Cocpit</h2>
                    </div>
                    <div style="background: #f9f9f9; padding: 32px; border-radius: 0 0 8px 8px; border: 1px solid #e0e0e0;">
                        <h3 style="margin-top: 0;">Hi ${fullName || "there"},</h3>
                        <p>We received a request to delete your Cocpit account.</p>
                        <p>Your account and all associated data will be <strong>permanently deleted on ${deletionDateStr}</strong>.</p>
                        <p>If you changed your mind, click the button below to restore your account before that date:</p>
                        <div style="text-align: center; margin: 32px 0;">
                            <a href="${restoreLink}"
                               style="background: #2563eb; color: #ffffff; padding: 14px 28px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 15px; display: inline-block;">
                                Restore My Account
                            </a>
                        </div>
                        <p style="font-size: 13px; color: #888;">This link expires on ${deletionDateStr} and can only be used once.</p>
                        <p style="font-size: 13px; color: #888;">If you did not request this, your account may be compromised. Please contact support immediately.</p>
                        <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 24px 0;">
                        <p style="font-size: 12px; color: #aaa; text-align: center;">© ${new Date().getFullYear()} Cocpit. All rights reserved.</p>
                    </div>
                </div>
            `,
        });

        if (error) {
            console.error("Resend error (account deletion email):", error);
            throw new Error(error.message || "Failed to send account deletion email");
        }

        return data;
    } catch (err) {
        console.error("Failed to send account deletion email to:", email, err);
        throw err;
    }
};

module.exports = {
    sendOTPEmail,
    sendAccountDeletionEmail,
};
