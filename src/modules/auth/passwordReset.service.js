const crypto = require("crypto");
const pool = require("../../core/db/pool");
const redisClient = require("../../core/db/redis");
const { hashPassword, comparePassword } = require("../../core/utils/password");
const emailService = require("../../core/services/email.service");
const authRepo = require("./auth.repository");
const socketService = require("../../core/infrastructure/socket.service");

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes

/**
 * Reset user password (OTP-based)
 * @param {string} email - User email
 * @param {string} newPassword - New password (plain text)
 * @param {boolean} logoutOtherDevices - Whether to invalidate sessions on other devices
 * @returns {Promise<Object>} Result object
 */
const resetPassword = async (email, newPassword, logoutOtherDevices = true) => {
    const normalizedEmail = email.toLowerCase().trim();

    // Check if user exists
    const userResult = await pool.query(
        "SELECT user_id, password_hash FROM users WHERE email = $1",
        [normalizedEmail]
    );

    if (userResult.rowCount === 0) {
        throw new Error("User not found");
    }

    const user = userResult.rows[0];
    const userId = user.user_id;

    // Check if new password is the same as old password
    if (user.password_hash) {
        const isSamePassword = await comparePassword(newPassword, user.password_hash);
        if (isSamePassword) {
            const err = new Error("Choose a different password");
            err.statusCode = 400;
            throw err;
        }
    }

    // Hash the new password
    const passwordHash = await hashPassword(newPassword);

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // 1. Update password in database
        await client.query(
            "UPDATE users SET password_hash = $1, updated_at = NOW() WHERE user_id = $2",
            [passwordHash, userId]
        );

        let deletedSessionIds = [];

        // 2. Invalidate other device sessions if requested
        if (logoutOtherDevices) {
            const deletedResult = await client.query(
                "DELETE FROM refresh_tokens WHERE user_id = $1 RETURNING session_id",
                [userId]
            );
            deletedSessionIds = deletedResult.rows.map(r => r.session_id);
        }

        await client.query("COMMIT");

        // 3. Blacklist invalidated sessions in Redis & terminate WebSockets
        if (deletedSessionIds.length > 0) {
            await Promise.allSettled(
                deletedSessionIds.map(async (sessionId) => {
                    if (redisClient.isOpen) {
                        await redisClient.setEx(
                            `revoked_session:${sessionId}`,
                            ACCESS_TOKEN_TTL_SECONDS,
                            "1"
                        );
                    }
                    await socketService.disconnectUserSession(userId, sessionId);
                })
            );
        }

        return {
            success: true,
            message: "Password reset successful",
        };
    } catch (err) {
        await client.query("ROLLBACK");
        throw err;
    } finally {
        client.release();
    }
};

/**
 * Request password reset link (Settings flow)
 * Generates secure token, stores in DB, sends email link to logged-in user.
 * @param {string} userId
 */
const requestPasswordResetLink = async (userId) => {
    const user = await authRepo.getUserById(userId);
    if (!user || !user.email) {
        throw new Error("User not found");
    }

    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    await pool.query(`
        CREATE TABLE IF NOT EXISTS password_reset_tokens (
          token_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ DEFAULT now(),
          used BOOLEAN DEFAULT FALSE
        );
        CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id ON password_reset_tokens(user_id);
        CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_hash ON password_reset_tokens(token_hash);
    `);

    await pool.query(
        `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
         VALUES ($1, $2, $3)`,
        [userId, tokenHash, expiresAt]
    );

    await emailService.sendPasswordResetLinkEmail(user.email, user.full_name, rawToken);

    return {
        success: true,
        message: "Password reset link sent to registered email",
    };
};

/**
 * Verify token status (for frontend page load pre-check)
 * @param {string} rawToken
 */
const verifyResetToken = async (rawToken) => {
    if (!rawToken || typeof rawToken !== "string") {
        return { valid: false, reason: "invalid" };
    }

    await pool.query(`
        CREATE TABLE IF NOT EXISTS password_reset_tokens (
          token_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ DEFAULT now(),
          used BOOLEAN DEFAULT FALSE
        );
    `);

    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    const result = await pool.query(
        `SELECT token_id, user_id, expires_at, used
         FROM password_reset_tokens
         WHERE token_hash = $1`,
        [tokenHash]
    );

    if (result.rowCount === 0) {
        return { valid: false, reason: "invalid" };
    }

    const record = result.rows[0];
    if (record.used) {
        return { valid: false, reason: "used" };
    }
    if (new Date() > new Date(record.expires_at)) {
        return { valid: false, reason: "expired" };
    }

    return { valid: true, userId: record.user_id };
};

/**
 * Complete link-based password reset and revoke ALL active sessions
 * @param {string} rawToken
 * @param {string} newPassword
 */
const resetPasswordWithToken = async (rawToken, newPassword) => {
    const verification = await verifyResetToken(rawToken);
    if (!verification.valid) {
        if (verification.reason === "used") {
            throw new Error("This password reset link has already been used.");
        }
        if (verification.reason === "expired") {
            throw new Error("This password reset link has expired.");
        }
        throw new Error("Invalid password reset token.");
    }

    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    const userId = verification.userId;

    // Check if new password is the same as existing password
    const userResult = await pool.query(
        "SELECT password_hash FROM users WHERE user_id = $1",
        [userId]
    );
    if (userResult.rowCount > 0 && userResult.rows[0].password_hash) {
        const isSamePassword = await comparePassword(newPassword, userResult.rows[0].password_hash);
        if (isSamePassword) {
            const err = new Error("Choose a different password");
            err.statusCode = 400;
            throw err;
        }
    }

    const passwordHash = await hashPassword(newPassword);

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // 1. Update password
        await client.query(
            "UPDATE users SET password_hash = $1, updated_at = NOW() WHERE user_id = $2",
            [passwordHash, userId]
        );

        // 2. Mark token as used
        await client.query(
            "UPDATE password_reset_tokens SET used = TRUE WHERE token_hash = $1",
            [tokenHash]
        );

        // 3. Delete ALL sessions for this user
        const deletedResult = await client.query(
            "DELETE FROM refresh_tokens WHERE user_id = $1 RETURNING session_id",
            [userId]
        );

        await client.query("COMMIT");

        // 4. Invalidate all session access tokens in Redis & disconnect sockets
        const deletedSessionIds = deletedResult.rows.map(r => r.session_id);
        if (deletedSessionIds.length > 0) {
            await Promise.allSettled(
                deletedSessionIds.map(async (sessionId) => {
                    if (redisClient.isOpen) {
                        await redisClient.setEx(
                            `revoked_session:${sessionId}`,
                            ACCESS_TOKEN_TTL_SECONDS,
                            "1"
                        );
                    }
                    await socketService.disconnectUserSession(userId, sessionId);
                })
            );
        }

        return {
            success: true,
            message: "Password reset successfully. All sessions have been logged out.",
        };
    } catch (err) {
        await client.query("ROLLBACK");
        throw err;
    } finally {
        client.release();
    }
};

/**
 * Check if user has an active, unexpired, unused reset link
 * @param {string} userId
 */
const getActiveResetLinkStatus = async (userId) => {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS password_reset_tokens (
          token_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ DEFAULT now(),
          used BOOLEAN DEFAULT FALSE
        );
    `);

    const result = await pool.query(
        `SELECT expires_at
         FROM password_reset_tokens
         WHERE user_id = $1 AND used = FALSE AND expires_at > NOW()
         ORDER BY created_at DESC
         LIMIT 1`,
        [userId]
    );

    if (result.rowCount === 0) {
        return { hasActiveLink: false, remainingSeconds: 0 };
    }

    const expiresAt = new Date(result.rows[0].expires_at);
    const now = new Date();
    const remainingSeconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));

    return {
        hasActiveLink: remainingSeconds > 0,
        remainingSeconds,
    };
};

/**
 * Validate whether a prospective password matches the user's current password
 * @param {Object} params
 * @param {string} [params.email]
 * @param {string} [params.token]
 * @param {string} params.password
 */
const validatePassword = async ({ email, token, password }) => {
    if (!password) return { isSamePassword: false };

    let passwordHash = null;

    if (token) {
        const verification = await verifyResetToken(token);
        if (verification.valid) {
            const userRes = await pool.query(
                "SELECT password_hash FROM users WHERE user_id = $1",
                [verification.userId]
            );
            if (userRes.rowCount > 0) {
                passwordHash = userRes.rows[0].password_hash;
            }
        }
    } else if (email) {
        const normalizedEmail = email.toLowerCase().trim();
        const userRes = await pool.query(
            "SELECT password_hash FROM users WHERE email = $1",
            [normalizedEmail]
        );
        if (userRes.rowCount > 0) {
            passwordHash = userRes.rows[0].password_hash;
        }
    }

    if (passwordHash) {
        const isSame = await comparePassword(password, passwordHash);
        if (isSame) {
            return { isSamePassword: true, message: "Choose a different password" };
        }
    }

    return { isSamePassword: false };
};

module.exports = {
    resetPassword,
    requestPasswordResetLink,
    verifyResetToken,
    resetPasswordWithToken,
    getActiveResetLinkStatus,
    validatePassword,
};
