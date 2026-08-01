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
const sendOTPEmail = async (email, otp, purpose = "signup") => {
    if (!resend) {
        throw new Error("Email service is not configured (RESEND_API_KEY missing).");
    }

    let subject = "Cocpit Verification Code";
    let title = "Hello,";
    let bodyText = "Your verification code is:";

    if (purpose === "recovery") {
        subject = "Cocpit Recovery Email Verification Code";
        title = "Verify Your Recovery Email";
        bodyText = "Your verification code for setting your account recovery email is:";
    } else if (purpose === "password_reset") {
        subject = "Cocpit Password Reset Code";
        title = "Reset Your Password";
        bodyText = "Your verification code for resetting your account password is:";
    } else if (purpose === "email_change") {
        subject = "Cocpit Primary Email Change Code";
        title = "Confirm Email Change";
        bodyText = "Your verification code for changing your primary email address is:";
    } else if (purpose === "signup") {
        subject = "Cocpit Account Registration Code";
        title = "Welcome to Cocpit!";
        bodyText = "Your verification code for creating your account is:";
    }

    try {
        const { data, error } = await resend.emails.send({
            from: "Cocpit <noreply@cocpit.in>",
            to: [email],
            subject,
            html: `
                <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 560px; margin: 0 auto;">
                    <div style="background: #0a0f1e; padding: 24px 32px; border-radius: 8px 8px 0 0;">
                        <h2 style="color: #ffffff; margin: 0; font-size: 22px;">Cocpit</h2>
                    </div>
                    <div style="background: #ffffff; padding: 32px; border-radius: 0 0 8px 8px; border: 1px solid #e0e0e0;">
                        <h3 style="margin-top: 0; color: #111;">${title}</h3>
                        <p>${bodyText}</p>
                        <div style="text-align: center; margin: 24px 0;">
                            <span style="font-size: 32px; font-weight: bold; letter-spacing: 6px; color: #2563eb; background: #f0f4ff; padding: 12px 24px; border-radius: 8px; display: inline-block;">${otp}</span>
                        </div>
                        <p style="font-size: 13px; color: #666;">This code will expire in 5 minutes.</p>
                        <p style="font-size: 13px; color: #888;">If you did not request this code, please ignore this email.</p>
                    </div>
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

    const frontendUrl = process.env.FRONTEND_URL || (process.env.NODE_ENV === "staging" ? "https://staging.cocpit.in" : "http://localhost:3000");
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

const sendEmailChangeOTP = async (email, otp, isNewEmail = false) => {
    if (!resend) {
        throw new Error("Email service is not configured (RESEND_API_KEY missing).");
    }

    const subject = isNewEmail
        ? "Verify your new Cocpit email address"
        : "Confirm your Cocpit email change";

    try {
        const { data, error } = await resend.emails.send({
            from: "Cocpit <noreply@cocpit.in>",
            to: [email],
            subject,
            html: `
                <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
                    <h2>${subject}</h2>
                    <p>Use the following code to confirm your email change:</p>
                    <h1 style="font-size: 32px; letter-spacing: 4px; color: #007bff;">${otp}</h1>
                    <p>This code expires in 5 minutes.</p>
                </div>
            `,
        });

        if (error) {
            console.error("Resend error:", error);
            throw new Error(error.message || "Failed to send email change OTP");
        }
        return data;
    } catch (err) {
        console.error("Failed to send email change OTP to:", email, err);
        throw err;
    }
};

const sendRecoveryEmailOTP = async (email, otp) => {
    if (!resend) {
        throw new Error("Email service is not configured (RESEND_API_KEY missing).");
    }

    try {
        const { data, error } = await resend.emails.send({
            from: "Cocpit <noreply@cocpit.in>",
            to: [email],
            subject: "Verify your Cocpit recovery email address",
            html: `
                <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
                    <h2>Verify Recovery Email</h2>
                    <p>Use the following code to set this address as your account recovery email:</p>
                    <h1 style="font-size: 32px; letter-spacing: 4px; color: #007bff;">${otp}</h1>
                    <p>This code expires in 5 minutes.</p>
                </div>
            `,
        });

        if (error) {
            console.error("Resend error:", error);
            throw new Error(error.message || "Failed to send recovery email OTP");
        }
        return data;
    } catch (err) {
        console.error("Failed to send recovery email OTP to:", email, err);
        throw err;
    }
};

module.exports = {
    sendOTPEmail,
    sendAccountDeletionEmail,
    sendEmailChangeOTP,
    sendRecoveryEmailOTP,
};
