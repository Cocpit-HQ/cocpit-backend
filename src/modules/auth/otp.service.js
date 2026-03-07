const crypto = require("crypto");
const bcrypt = require("bcrypt");
// Use the exact path to pool, adjusting based on codebase architecture
const pool = require("../../db/pool");
const emailService = require("../../core/services/email.service");

// Expiry in minutes (default 5)
const OTP_EXPIRY_MINUTES = parseInt(process.env.OTP_EXPIRY_MINUTES) || 5;
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
 */
const requestOTP = async (email) => {
    const normalizedEmail = email.toLowerCase().trim();

    // 1. Rate Limit Check (3 per email per 60 seconds)
    const existing = await pool.query(
        `SELECT created_at, request_count FROM email_otps WHERE email = $1`,
        [normalizedEmail]
    );

    let requestCount = 1;
    let shouldUpdateCreatedAt = true;

    if (existing.rows.length > 0) {
        const record = existing.rows[0];
        const now = new Date();
        const created = new Date(record.created_at);
        const diffSeconds = (now - created) / 1000;

        if (diffSeconds < 60) {
            if (record.request_count >= 3) {
                // Return a structured error that the controller can handle
                return { error: { status: 429, message: "Too many OTP requests. Please wait a minute before trying again." } };
            }
            requestCount = record.request_count + 1;
            shouldUpdateCreatedAt = false; // Keep the same window start
        }
    }

    const otp = generateSecureOTP();

    // Hash password strongly but quickly enough for OTP
    const otpHash = await bcrypt.hash(otp, 10);

    // Calculate expiration
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60000);

    const query = `
        INSERT INTO email_otps (email, otp_hash, expires_at, attempts, created_at, request_count)
        VALUES ($1, $2, $3, 0, NOW(), 1)
        ON CONFLICT (email) 
        DO UPDATE SET 
            otp_hash = EXCLUDED.otp_hash,
            expires_at = EXCLUDED.expires_at,
            attempts = 0,
            created_at = CASE WHEN $4 THEN NOW() ELSE email_otps.created_at END,
            request_count = $5
    `;

    // Store in database
    await pool.query(query, [normalizedEmail, otpHash, expiresAt, shouldUpdateCreatedAt, requestCount]);

    // Send email using Resend
    await emailService.sendOTPEmail(normalizedEmail, otp);
    return { success: true };
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

    // 1. Fetch OTP record
    const result = await pool.query(
        `SELECT * FROM email_otps WHERE email = $1`,
        [normalizedEmail]
    );

    if (result.rows.length === 0) {
        return { error: { status: 400, message: "No active OTP found for this email." } };
    }

    const record = result.rows[0];

    // 2. Check expiry
    if (new Date() > record.expires_at) {
        await pool.query(`DELETE FROM email_otps WHERE email = $1`, [normalizedEmail]);
        return { error: { status: 400, message: "OTP has expired. Please request a new one." } };
    }

    // 3. Check attempt count
    if (record.attempts >= MAX_ATTEMPTS) {
        await pool.query(`DELETE FROM email_otps WHERE email = $1`, [normalizedEmail]);
        return { error: { status: 429, message: "Maximum verification attempts exceeded. Please request a new OTP." } };
    }

    // Increment attempts immediately to prevent brute-force timing attacks
    await pool.query(
        `UPDATE email_otps SET attempts = attempts + 1 WHERE email = $1`,
        [normalizedEmail]
    );

    // 4. Compare bcrypt hash
    const isValid = await bcrypt.compare(otp.toString(), record.otp_hash);
    if (!isValid) {
        return { error: { status: 400, message: "Invalid verification code." } };
    }

    // 5. Delete OTP record after successful validation
    if (consume) {
        await pool.query(`DELETE FROM email_otps WHERE email = $1`, [normalizedEmail]);
    }

    // Return success. Marking an email verified in the actual user collection 
    // happens ideally in the controller after validation, but we can return success here.
    return { success: true, message: "Email successfully verified." };
};

module.exports = {
    generateSecureOTP,
    requestOTP,
    verifyOTP
};
