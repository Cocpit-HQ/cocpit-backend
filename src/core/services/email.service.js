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
    const restoreLink = restoreToken ? `${frontendUrl}/restore-account?token=${restoreToken}` : `${frontendUrl}/restore-account`;
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

/**
 * Sends an organization deletion scheduled email with a one-click restore link.
 * @param {string} email - The admin's email address
 * @param {string} orgName - The organization's name
 * @param {string} restoreToken - Raw restore token
 * @param {Date}   deletionDate - The scheduled permanent deletion date
 */
const sendOrganizationDeletionEmail = async (email, orgName, restoreToken, deletionDate) => {
    if (!resend) {
        throw new Error("Email service is not configured (RESEND_API_KEY missing).");
    }

    const frontendUrl = process.env.FRONTEND_URL || (process.env.NODE_ENV === "staging" ? "https://staging.cocpit.in" : "http://localhost:3000");
    const restoreLink = `${frontendUrl}/company/restore?token=${restoreToken}`;
    const deletionDateStr = new Date(deletionDate).toLocaleDateString("en-US", {
        year: "numeric", month: "long", day: "numeric",
    });

    try {
        const { data, error } = await resend.emails.send({
            from: "Cocpit <noreply@cocpit.in>",
            to: [email],
            subject: `Your company page "${orgName}" is scheduled for deletion`,
            html: `
                <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 560px; margin: 0 auto;">
                    <div style="background: #0a0f1e; padding: 24px 32px; border-radius: 8px 8px 0 0;">
                        <h2 style="color: #ffffff; margin: 0; font-size: 22px;">Cocpit</h2>
                    </div>
                    <div style="background: #f9f9f9; padding: 32px; border-radius: 0 0 8px 8px; border: 1px solid #e0e0e0;">
                        <h3 style="margin-top: 0;">Company Deletion Scheduled</h3>
                        <p>We received a request to delete your company page: <strong>${orgName}</strong>.</p>
                        <p>The company and all its associated posts and jobs will be <strong>permanently deleted on ${deletionDateStr}</strong>.</p>
                        <p>If you changed your mind, click the button below to restore the company before that date:</p>
                        <div style="text-align: center; margin: 32px 0;">
                            <a href="${restoreLink}"
                               style="background: #2563eb; color: #ffffff; padding: 14px 28px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 15px; display: inline-block;">
                                Restore Company
                            </a>
                        </div>
                        <p style="font-size: 13px; color: #888;">This link expires on ${deletionDateStr} and can only be used once.</p>
                        <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 24px 0;">
                        <p style="font-size: 12px; color: #aaa; text-align: center;">© ${new Date().getFullYear()} Cocpit. All rights reserved.</p>
                    </div>
                </div>
            `,
        });

        if (error) {
            console.error("Resend error (organization deletion email):", error);
            throw new Error(error.message || "Failed to send organization deletion email");
        }

        return data;
    } catch (err) {
        console.error("Failed to send organization deletion email to:", email, err);
        throw err;
    }
};


/**
 * Sends a password reset link email.
 * @param {string} email - The user's email address
 * @param {string} fullName - The user's display name
 * @param {string} resetToken - Raw reset token
 */
const sendPasswordResetLinkEmail = async (email, fullName, resetToken) => {
    if (!resend) {
        throw new Error("Email service is not configured (RESEND_API_KEY missing).");
    }

    const frontendUrl = process.env.FRONTEND_URL || (process.env.NODE_ENV === "staging" ? "https://staging.cocpit.in" : "http://localhost:3000");
    const resetLink = `${frontendUrl}/reset-password?token=${resetToken}`;

    try {
        const { data, error } = await resend.emails.send({
            from: "Cocpit <noreply@cocpit.in>",
            to: [email],
            subject: "Reset your Cocpit account password",
            html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reset Your Password</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f4f6f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #f4f6f9; padding: 40px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 540px; background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 20px rgba(0, 0, 0, 0.05); border: 1px solid #e5e7eb;">
          
          <!-- Header Bar -->
          <tr>
            <td style="background-color: #0F172A; padding: 28px 36px; text-align: left;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                <tr>
                  <td>
                    <span style="font-size: 24px; font-weight: 800; color: #6366F1; letter-spacing: -0.5px;">Cocpit</span>
                  </td>
                  <td align="right" style="font-size: 12px; color: #94A3B8; font-weight: 500;">
                    Security Notification
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Main Body -->
          <tr>
            <td style="padding: 40px 36px;">
              <h1 style="margin: 0 0 16px 0; font-size: 20px; font-weight: 700; color: #0F172A; line-height: 28px;">
                Password Reset Request
              </h1>
              
              <p style="margin: 0 0 16px 0; font-size: 15px; color: #475569; line-height: 24px;">
                Hi ${fullName || "there"},
              </p>
              
              <p style="margin: 0 0 24px 0; font-size: 15px; color: #475569; line-height: 24px;">
                We received a request to reset the password for your Cocpit account. Click the button below to choose a new password:
              </p>

              <!-- CTA Button -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin: 28px 0;">
                <tr>
                  <td align="center">
                    <a href="${resetLink}" 
                       target="_blank"
                       style="display: inline-block; background-color: #4F46E5; color: #ffffff; font-size: 15px; font-weight: 600; padding: 14px 36px; text-decoration: none; border-radius: 12px;">
                      Reset Password
                    </a>
                  </td>
                </tr>
              </table>

              <!-- Expiry & Notice -->
              <div style="background-color: #F8FAFC; border-left: 4px solid #6366F1; border-radius: 0 8px 8px 0; padding: 16px 20px; margin: 24px 0 28px 0;">
                <p style="margin: 0 0 6px 0; font-size: 13px; font-weight: 600; color: #1E293B;">
                  ⏱️ This link expires in 15 minutes
                </p>
                <p style="margin: 0; font-size: 13px; color: #64748B; line-height: 20px;">
                  For security reasons, this link can only be used once. Resetting your password will log out all active sessions across all your devices.
                </p>
              </div>

              <!-- Fallback Link -->
              <p style="margin: 0 0 8px 0; font-size: 12px; color: #94A3B8; line-height: 18px;">
                If the button above doesn't work, copy and paste the following URL into your browser:
              </p>
              <p style="margin: 0 0 24px 0; font-size: 12px; color: #4F46E5; word-break: break-all; line-height: 18px;">
                <a href="${resetLink}" style="color: #4F46E5; text-decoration: underline;">${resetLink}</a>
              </p>

              <!-- Security Advice -->
              <hr style="border: none; border-top: 1px solid #F1F5F9; margin: 28px 0;">
              
              <p style="margin: 0; font-size: 13px; color: #64748B; line-height: 20px;">
                <strong>Didn't request this change?</strong><br>
                If you did not request a password reset, you can safely ignore this email. Your current password will remain active and secure.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #F8FAFC; padding: 24px 36px; border-top: 1px solid #E2E8F0; text-align: center;">
              <p style="margin: 0 0 6px 0; font-size: 12px; font-weight: 500; color: #64748B;">
                Cocpit Inc. &bull; Professional Career Platform
              </p>
              <p style="margin: 0; font-size: 11px; color: #94A3B8;">
                &copy; ${new Date().getFullYear()} Cocpit. All rights reserved.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
            `,
        });

        if (error) {
            console.error("Resend error (password reset link email):", error);
            throw new Error(error.message || "Failed to send password reset email");
        }

        return data;
    } catch (err) {
        console.error("Failed to send password reset email to:", email, err);
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

/**
 * Sends an organization deletion verification OTP to one or more recipient emails.
 * @param {string[]} recipients - Array of recipient email addresses
 * @param {string} otp - 6-digit OTP code
 * @param {string} orgName - Name of the organization
 */
const sendOrgDeleteOTPEmail = async (recipients, otp, orgName) => {
    if (!resend) {
        throw new Error("Email service is not configured (RESEND_API_KEY missing).");
    }

    const recipientList = Array.isArray(recipients) ? recipients : [recipients];
    const subject = `Action Required: Organization Deletion Code for "${orgName || 'Organization'}"`;

    try {
        const { data, error } = await resend.emails.send({
            from: "Cocpit <noreply@cocpit.in>",
            to: recipientList,
            subject,
            html: `
                <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 560px; margin: 0 auto;">
                    <div style="background: #0a0f1e; padding: 24px 32px; border-radius: 8px 8px 0 0;">
                        <h2 style="color: #ffffff; margin: 0; font-size: 22px;">Cocpit</h2>
                    </div>
                    <div style="background: #ffffff; padding: 32px; border-radius: 0 0 8px 8px; border: 1px solid #e0e0e0;">
                        <h3 style="margin-top: 0; color: #111;">Organization Deletion Request</h3>
                        <p>We received a request to delete the organization <strong>${orgName || "your organization"}</strong>.</p>
                        <p>To confirm this action, please enter the following 6-digit verification code:</p>
                        <div style="text-align: center; margin: 24px 0;">
                            <span style="font-size: 32px; font-weight: bold; letter-spacing: 6px; color: #ef4444; background: #fef2f2; padding: 12px 24px; border-radius: 8px; border: 1px solid #fca5a5; display: inline-block;">${otp}</span>
                        </div>
                        <p style="font-size: 13px; color: #666;">This code will expire in 5 minutes.</p>
                        <p style="font-size: 13px; color: #dc2626; font-weight: bold;">⚠️ Warning: Deleting an organization removes its profile, associated posts, and settings. If you did not request this deletion, please secure your account immediately.</p>
                    </div>
                </div>
            `,
        });

        if (error) {
            console.error("Resend error (org delete OTP):", error);
            throw new Error(error.message || "Failed to send organization delete OTP email");
        }

        return data;
    } catch (err) {
        console.error("Failed to send org delete OTP email to:", recipientList, err);
        throw err;
    }
};

module.exports = {
    sendOTPEmail,
    sendAccountDeletionEmail,
    sendOrganizationDeletionEmail,
    sendPasswordResetLinkEmail,
    sendEmailChangeOTP,
    sendRecoveryEmailOTP,
    sendOrgDeleteOTPEmail,
};
