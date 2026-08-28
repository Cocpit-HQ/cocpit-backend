const crypto = require("crypto");
const bcrypt = require("bcrypt");
// Use the exact path to pool, adjusting based on codebase architecture
const pool = require('../../core/db/pool');
const emailService = require("../../core/services/email.service");

// Default OTP code expiry: 10 minutes
const OTP_EXPIRY_MINUTES = parseInt(process.env.OTP_EXPIRY_MINUTES) || 10;
// Post-verification session expiry: 10 minutes
const SESSION_EXPIRY_MINUTES = parseInt(process.env.SESSION_EXPIRY_MINUTES) || 10;
const MAX_ATTEMPTS = 5;

/**
 * Generates a secure random 6-digit numeric OTP.
 * @returns {string} 6-digit OTP
 */
const generateSecureOTP = () => {
    const min = 100000;
    const max = 999999;
    return crypto.randomInt(min, max + 1).toString();
};

/**
 * Generates, stores, and emails an OTP.
 * @param {string} email
 * @param {"signup"|"password_reset"} purpose
 */
const requestOTP = async (email, purpose = "signup", isResend = false) => {
    const normalizedEmail = email.toLowerCase().trim();

    const userResult = await pool.query(
        "SELECT 1 FROM users WHERE email = $1",
        [normalizedEmail]
    );
    const userExists = userResult.rowCount > 0;

    if (purpose === "signup") {
        if (userExists) {
            return {
                error: {
                    status: 409,
                    message: "An account with this email already exists",
                },
            };
        }
    } else if (purpose === "password_reset") {
        if (!userExists) {
            return {
                error: {
                    status: 404,
                    message: "We couldn't find an account with this email",
                },
            };
        }
    }

    // Check existing OTP record with database-calculated timezone-safe epoch seconds
    const existing = await pool.query(
        `SELECT created_at, request_count, verified_at, session_expires_at, expires_at,
                EXTRACT(EPOCH FROM (NOW() - created_at)) AS elapsed_seconds,
                EXTRACT(EPOCH FROM (expires_at - NOW())) AS remaining_otp_seconds,
                EXTRACT(EPOCH FROM (session_expires_at - NOW())) AS remaining_session_seconds
         FROM email_otps WHERE email = $1`,
        [normalizedEmail]
    );

    if (existing.rows.length > 0) {
        const record = existing.rows[0];
        const elapsedSeconds = Math.max(0, parseFloat(record.elapsed_seconds || 0));
        const remainingOtpSeconds = parseFloat(record.remaining_otp_seconds || 0);
        const remainingSessionSeconds = parseFloat(record.remaining_session_seconds || 0);

        // 1. Edge Case 1: Verified 10-minute session is still active!
        if (!isResend && record.verified_at && remainingSessionSeconds > 0) {
            const remainingSeconds = Math.min(SESSION_EXPIRY_MINUTES * 60, Math.max(0, Math.floor(remainingSessionSeconds)));
            console.log(`[OTP SERVICE] Active verified session found for ${normalizedEmail}. Valid for ${remainingSeconds}s.`);
            return {
                success: true,
                sessionActive: true,
                verified: true,
                sessionExpiresAt: record.session_expires_at,
                remainingSeconds,
                serverTime: new Date().toISOString(),
                message: "Active verification session found.",
            };
        }

        // 2. Clean up expired session or expired OTP
        const isSessionExpired = record.verified_at && remainingSessionSeconds <= 0;
        const isOtpExpired = !record.verified_at && remainingOtpSeconds <= 0;

        if (isSessionExpired || isOtpExpired) {
            await pool.query(`DELETE FROM email_otps WHERE email = $1`, [normalizedEmail]);
        } else if (!isResend && !record.verified_at && remainingOtpSeconds > 0) {
            // 3. Edge Case 3: Unverified OTP already sent and not expired
            const remainingExpiry = Math.min(OTP_EXPIRY_MINUTES * 60, Math.max(0, Math.floor(remainingOtpSeconds)));

            if (elapsedSeconds < 120) {
                // 3a. Cooldown still active (Clamped strictly between 1 and 120s)
                const remainingCooldown = Math.min(120, Math.max(1, Math.ceil(120 - elapsedSeconds)));
                const cooldownExpiresAt = new Date(Date.now() + remainingCooldown * 1000).toISOString();
                console.log(`[OTP SERVICE] Active OTP with running cooldown found for ${normalizedEmail}. Cooldown: ${remainingCooldown}s.`);
                return {
                    success: true,
                    otpActive: true,
                    remainingCooldown,
                    cooldownExpiresAt,
                    remainingExpiry,
                    serverTime: new Date().toISOString(),
                    message: "A verification code was already sent to your email.",
                };
            } else {
                // 3b. Cooldown ended, OTP still valid
                console.log(`[OTP SERVICE] Active OTP with ended cooldown found for ${normalizedEmail}. Valid for ${remainingExpiry}s.`);
                return {
                    success: true,
                    otpActive: true,
                    remainingCooldown: 0,
                    cooldownExpiresAt: new Date().toISOString(),
                    remainingExpiry,
                    serverTime: new Date().toISOString(),
                    message: "A verification code was already sent to your email.",
                };
            }
        }
    }

    // 4. Rate Limit Check on Fresh / Resend OTP requests (Max 3 per email per 60 seconds)
    let requestCount = 1;
    let shouldUpdateCreatedAt = true;

    if (existing.rows.length > 0) {
        const record = existing.rows[0];
        const elapsedSeconds = Math.max(0, parseFloat(record.elapsed_seconds || 0));

        if (elapsedSeconds < 60) {
            if (elapsedSeconds < 5) {
                return { error: { status: 429, message: "A verification code was just requested. Please wait a few seconds before trying again." } };
            }
            if (record.request_count >= 3) {
                return { error: { status: 429, message: "Too many OTP requests. Please wait a minute before trying again." } };
            }
            requestCount = (record.request_count || 1) + 1;
            shouldUpdateCreatedAt = false;
        }
    }

    const otp = generateSecureOTP();

    console.log("\n╔══════════════════════════════════════════════════╗");
    console.log(`║ 🔑 OTP CODE: ${otp}                            ║`);
    console.log(`║ 📧 Recipient: ${normalizedEmail.padEnd(34)} ║`);
    console.log(`║ 🎯 Purpose:   ${purpose.padEnd(34)} ║`);
    console.log(`║ ⏳ Valid For: ${`${OTP_EXPIRY_MINUTES} minutes`.padEnd(34)} ║`);
    console.log("╚══════════════════════════════════════════════════╝\n");

    // Hash password strongly but quickly enough for OTP
    const otpHash = await bcrypt.hash(otp, 10);

    // Calculate expiration (10 minutes)
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60000);

    const query = `
        INSERT INTO email_otps (email, otp_hash, expires_at, attempts, created_at, request_count, verified_at, session_expires_at)
        VALUES ($1, $2, $3, 0, NOW(), $4, NULL, NULL)
        ON CONFLICT (email) 
        DO UPDATE SET 
            otp_hash = EXCLUDED.otp_hash,
            expires_at = EXCLUDED.expires_at,
            attempts = 0,
            created_at = CASE WHEN $5 THEN NOW() ELSE email_otps.created_at END,
            request_count = EXCLUDED.request_count,
            verified_at = NULL,
            session_expires_at = NULL
    `;

    // Store in database
    await pool.query(query, [normalizedEmail, otpHash, expiresAt, requestCount, shouldUpdateCreatedAt]);

    // Send email using Resend with purpose
    try {
        await emailService.sendOTPEmail(normalizedEmail, otp, purpose);
        const cooldownExpiresAt = new Date(Date.now() + 120000).toISOString();
        return {
            success: true,
            otpActive: false,
            remainingCooldown: 120,
            cooldownExpiresAt,
            remainingExpiry: OTP_EXPIRY_MINUTES * 60,
            serverTime: new Date().toISOString(),
            message: "A new code has been sent.",
        };
    } catch (emailErr) {
        console.error("Failed to send OTP email via provider:", emailErr);
        return {
            error: {
                status: 500,
                message: "Failed to send verification email: " + (emailErr.message || "Email provider error"),
            },
        };
    }
};

/**
 * Verifies the user's OTP.
 * @param {string} email
 * @param {string} otp
 * @param {boolean} consume - Whether to delete the OTP record upon success
 * @returns {Promise<Object>} Result object with success or error
 */
const verifyOTP = async (email, otp, consume = true) => {
    const normalizedEmail = email.toLowerCase().trim();

    console.log(`[OTP SERVICE] Verifying OTP for: ${normalizedEmail} | Input code: ${otp}`);

    // 1. Fetch OTP record
    const result = await pool.query(
        `SELECT * FROM email_otps WHERE email = $1`,
        [normalizedEmail]
    );

    if (result.rows.length === 0) {
        return { error: { status: 400, message: "No active OTP found for this email." } };
    }

    const record = result.rows[0];

    // 2. Check expiry (10-minute code expiry or 10-minute session expiry)
    if (new Date() > new Date(record.expires_at) || (record.session_expires_at && new Date() > new Date(record.session_expires_at))) {
        await pool.query(`DELETE FROM email_otps WHERE email = $1`, [normalizedEmail]);
        return { error: { status: 400, message: "This code has expired" } };
    }

    // 3. Check attempt count
    if (record.attempts >= MAX_ATTEMPTS) {
        await pool.query(`DELETE FROM email_otps WHERE email = $1`, [normalizedEmail]);
        return { error: { status: 429, message: "Too many attempts" } };
    }

    // 4. Compare bcrypt hash
    const isValid = await bcrypt.compare(otp.toString(), record.otp_hash);
    if (!isValid) {
        const nextAttempts = (record.attempts || 0) + 1;
        if (nextAttempts >= MAX_ATTEMPTS) {
            // Invalidate current code immediately on 5th incorrect attempt
            await pool.query(`DELETE FROM email_otps WHERE email = $1`, [normalizedEmail]);
            return { error: { status: 429, message: "Too many attempts" } };
        }

        await pool.query(
            `UPDATE email_otps SET attempts = $1 WHERE email = $2`,
            [nextAttempts, normalizedEmail]
        );
        return { error: { status: 400, message: "Incorrect code" } };
    }

    // 5. Success handling
    let sessionExpiresAt = null;
    if (consume) {
        await pool.query(`DELETE FROM email_otps WHERE email = $1`, [normalizedEmail]);
    } else {
        // Start 10-minute verified session upon successful verification
        sessionExpiresAt = new Date(Date.now() + SESSION_EXPIRY_MINUTES * 60000);
        await pool.query(
            `UPDATE email_otps SET verified_at = NOW(), session_expires_at = $1 WHERE email = $2`,
            [sessionExpiresAt, normalizedEmail]
        );
    }

    return { success: true, message: "Account verified", sessionExpiresAt };
};

/**
 * Checks if a verified OTP session is currently active and within 10-minute window
 * @param {string} email
 */
const verifyOtpSession = async (email) => {
    const normalizedEmail = email.toLowerCase().trim();
    const result = await pool.query(
        `SELECT * FROM email_otps WHERE email = $1`,
        [normalizedEmail]
    );

    if (result.rows.length === 0) {
        return { valid: false, message: "No active verification session. Please request a new code." };
    }

    const record = result.rows[0];
    if (!record.verified_at) {
        return { valid: false, message: "Email has not been verified." };
    }

    if (record.session_expires_at && new Date() > new Date(record.session_expires_at)) {
        await pool.query(`DELETE FROM email_otps WHERE email = $1`, [normalizedEmail]);
        return { valid: false, message: "This code has expired" };
    }

    return { valid: true, record };
};

module.exports = {
    generateSecureOTP,
    requestOTP,
    verifyOTP,
    verifyOtpSession,
    OTP_EXPIRY_MINUTES,
    SESSION_EXPIRY_MINUTES,
};

