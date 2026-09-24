/**
 * Auth Repository
 * All database queries related to authentication, sessions, and user creation.
 * No business logic — just SQL and data access.
 */
const pool = require("../../core/db/pool");

// ─── User Queries ──────────────────────────────────────────────────────────────

const findUserByEmail = async (email) => {
    const result = await pool.query(
        `SELECT user_id, email, password_hash, is_onboarding_complete, account_name, full_name, avatar_url,
                deletion_execute_at, is_deactivated, is_deleted, is_suspended
         FROM users WHERE email = $1`,
        [email]
    );
    return result.rows[0] || null;
};

const checkEmailExists = async (email, client = pool) => {
    const result = await client.query(
        "SELECT 1, deletion_execute_at FROM users WHERE email = $1",
        [email]
    );
    if (result.rowCount === 0) return { exists: false };
    return {
        exists: true,
        pendingDeletion: result.rows[0].deletion_execute_at !== null,
        deletionDate: result.rows[0].deletion_execute_at,
    };
};

const createUser = async (email, passwordHash, fullName = "", is_onboarding_complete = false, client) => {
    const result = await client.query(
        `INSERT INTO users (email, password_hash,full_name,is_onboarding_complete)
     VALUES ($1, $2, $3, $4)
     RETURNING user_id, email`,
        [email, passwordHash, fullName, is_onboarding_complete]
    );
    return result.rows[0];
};

const assignRole = async (userId, roleName, client = pool) => {
    await client.query(
        `INSERT INTO user_roles (user_id, role_id)
     SELECT $1, role_id FROM roles WHERE role_name = $2`,
        [userId, roleName]
    );
};

const createProfile = async (userId, arg1, arg2) => {
    // Robust argument detection:
    // userId is always first. 
    // client is either arg1 or arg2 (the one with .query).
    // accountType is either arg1 or arg2 (the one that is a string).
    const client = (arg1 && typeof arg1.query === 'function') ? arg1 : 
                   (arg2 && typeof arg2.query === 'function') ? arg2 : pool;
                   
    const accountType = (typeof arg1 === 'string') ? arg1 : 
                        (typeof arg2 === 'string') ? arg2 : 'Student';

    await client.query(
        `INSERT INTO profiles (user_id, account_type) VALUES ($1, $2)`,
        [userId, accountType]
    );
};

const getUserRoles = async (userId) => {
    const result = await pool.query(
        `SELECT r.role_name
     FROM user_roles ur
     JOIN roles r ON r.role_id = ur.role_id
     WHERE ur.user_id = $1`,
        [userId]
    );
    return result.rows.map(r => r.role_name);
};

const getUserById = async (userId) => {
    const result = await pool.query(
        `SELECT user_id AS id, email, full_name, is_onboarding_complete, account_name
     FROM users WHERE user_id = $1`,
        [userId]
    );
    return result.rows[0] || null;
};

const getUserProfile = async (userId) => {
    const result = await pool.query(
        `SELECT account_type AS "accountType", open_to AS "openTo", availability, work_preference AS "workPreference"
     FROM profiles WHERE user_id = $1`,
        [userId]
    );
    return result.rows[0] || {};
};

const getUserPasswordHash = async (userId) => {
    const result = await pool.query(
        "SELECT password_hash FROM users WHERE user_id = $1",
        [userId]
    );
    return result.rows[0]?.password_hash || null;
};

// ─── Social Auth Queries ────────────────────────────────────────────────────────

const findUserBySocialId = async (provider, providerId) => {
    const result = await pool.query(
        `SELECT u.user_id, u.email, u.full_name, u.avatar_url, u.is_onboarding_complete,
                u.account_name, u.deletion_execute_at, u.is_deactivated, sa.provider, sa.provider_id
         FROM users u
         JOIN user_social_accounts sa ON u.user_id = sa.user_id
         WHERE sa.provider = $1 AND sa.provider_id = $2`,
        [provider, providerId]
    );
    return result.rows[0] || null;
};

/**
 * Creates a new user via Social OAuth.
 * password_hash is NULL because the user authenticated through a social provider.
 */
const createSocialUser = async (email, fullName, provider, providerId, avatarUrl) => {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const normalizedProvider = String(provider || "").toLowerCase();
        const isGoogle = normalizedProvider === "google";

        const result = await client.query(
            `INSERT INTO users (email, full_name, password_hash, avatar_url, auth_provider, google_id)
             VALUES ($1, $2, NULL, $3, $4, $5)
             RETURNING user_id, email, full_name, avatar_url`,
            [email, fullName, avatarUrl, normalizedProvider || "google", isGoogle ? providerId : null]
        );
        const user = result.rows[0];
        
        await client.query(
            `INSERT INTO user_social_accounts (user_id, provider, provider_id)
             VALUES ($1, $2, $3)`,
            [user.user_id, provider, providerId]
        );
        await client.query("COMMIT");
        return user;
    } catch (e) {
        await client.query("ROLLBACK");
        throw e;
    } finally {
        client.release();
    }
};

/**
 * Links a Social ID to an existing local (email/password) user.
 * This enables "Sign in with X" for users who originally registered with email.
 */
const linkSocialAccount = async (userId, provider, providerId) => {
    await pool.query(
        `INSERT INTO user_social_accounts (user_id, provider, provider_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (provider, provider_id) DO NOTHING`,
        [userId, provider, providerId]
    );
};

const getOnboardingStatus = async (userId) => {
    const result = await pool.query(
        `SELECT is_onboarding_complete FROM users WHERE user_id = $1`,
        [userId]
    );
    return result.rows[0]?.is_onboarding_complete || false;
};

// ─── Session / Token Queries ────────────────────────────────────────────────────

const getActiveSessions = async (userId) => {
    const result = await pool.query(
        `SELECT session_id
     FROM refresh_tokens
     WHERE user_id = $1 AND expires_at > now()
     ORDER BY created_at ASC`,
        [userId]
    );
    return result.rows;
};

const getDetailedSessions = async (userId) => {
    const result = await pool.query(
        `SELECT session_id, user_agent, ip_address, created_at, expires_at
     FROM refresh_tokens
     WHERE user_id = $1 AND expires_at > NOW() AND revoked = FALSE
     ORDER BY created_at DESC`,
        [userId]
    );
    return result.rows;
};

const getSessionCount = async (userId) => {
    const result = await pool.query(
        `SELECT COUNT(*)
     FROM refresh_tokens
     WHERE user_id = $1 AND expires_at > NOW() AND revoked = FALSE`,
        [userId]
    );
    return Number(result.rows[0].count);
};

const deleteSession = async (sessionId) => {
    await pool.query(
        `DELETE FROM refresh_tokens WHERE session_id = $1`,
        [sessionId]
    );
};

const deleteSessionForUser = async (userId, sessionId) => {
    const result = await pool.query(
        `DELETE FROM refresh_tokens
     WHERE user_id = $1 AND session_id = $2
     RETURNING session_id`,
        [userId, sessionId]
    );
    return result;
};

const deleteAllOtherSessions = async (userId, currentSessionId) => {
    const result = await pool.query(
        `DELETE FROM refresh_tokens
     WHERE user_id = $1 AND session_id != $2
     RETURNING session_id`,
        [userId, currentSessionId]
    );
    // Return the deleted session IDs so callers can blacklist each one immediately
    return result.rows.map((r) => r.session_id);
};

const insertSession = async (sessionId, userId, tokenHash, userAgent, ipAddress) => {
    await pool.query(
        `INSERT INTO refresh_tokens
       (session_id, user_id, token_hash, expires_at, user_agent, ip_address)
     VALUES ($1, $2, $3, now() + interval '7 days', $4, $5)`,
        [sessionId, userId, tokenHash, userAgent, ipAddress]
    );
};

const findSessionByUserAndId = async (userId, sessionId) => {
    const result = await pool.query(
        `SELECT token_id, token_hash
     FROM refresh_tokens
     WHERE user_id = $1 AND session_id = $2 AND expires_at > now()`,
        [userId, sessionId]
    );
    return result.rows[0] || null;
};

const checkDeviceExists = async (userId, userAgent, ipAddress) => {
    const result = await pool.query(
        `SELECT 1 FROM refresh_tokens
         WHERE user_id = $1 AND user_agent = $2 AND ip_address = $3
         LIMIT 1`,
        [userId, userAgent, ipAddress]
    );
    return result.rowCount > 0;
};

const updateSessionToken = async (sessionId, newTokenHash, expectedCurrentHash) => {
    const hasExpectedHash = typeof expectedCurrentHash === "string" && expectedCurrentHash.length > 0;
    const query = hasExpectedHash
        ? `UPDATE refresh_tokens
           SET token_hash = $1, expires_at = now() + interval '7 days'
           WHERE session_id = $2 AND token_hash = $3
           RETURNING session_id`
        : `UPDATE refresh_tokens
           SET token_hash = $1, expires_at = now() + interval '7 days'
           WHERE session_id = $2
           RETURNING session_id`;
    const params = hasExpectedHash
        ? [newTokenHash, sessionId, expectedCurrentHash]
        : [newTokenHash, sessionId];

    const result = await pool.query(query, params);
    return result.rowCount > 0;
};

// ─── Transaction Helpers ────────────────────────────────────────────────────────

const beginTransaction = async () => pool.query("BEGIN");
const commitTransaction = async () => pool.query("COMMIT");
const rollbackTransaction = async () => pool.query("ROLLBACK");

module.exports = {
    // User
    findUserByEmail,
    checkEmailExists,
    createUser,
    assignRole,
    createProfile,
    getUserRoles,
    getUserById,
    getUserProfile,
    getUserPasswordHash,
    getOnboardingStatus,
    // Social Auth
    findUserBySocialId,
    createSocialUser,
    linkSocialAccount,
    // Sessions
    getActiveSessions,
    getDetailedSessions,
    getSessionCount,
    deleteSession,
    deleteSessionForUser,
    deleteAllOtherSessions,
    insertSession,
    findSessionByUserAndId,
    checkDeviceExists,
    updateSessionToken,
    // Transactions
    beginTransaction,
    commitTransaction,
    rollbackTransaction,
};
