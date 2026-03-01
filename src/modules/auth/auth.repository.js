/**
 * Auth Repository
 * All database queries related to authentication, sessions, and user creation.
 * No business logic — just SQL and data access.
 */
const pool = require("../../core/db/pool");

// ─── User Queries ──────────────────────────────────────────────────────────────

const findUserByEmail = async (email) => {
    const result = await pool.query(
        `SELECT user_id, email, password_hash, is_onboarding_complete, account_name, full_name, avatar_url
     FROM users WHERE email = $1`,
        [email]
    );
    return result.rows[0] || null;
};

const checkEmailExists = async (email) => {
    const result = await pool.query(
        "SELECT 1 FROM users WHERE email = $1",
        [email]
    );
    return result.rowCount > 0;
};

const createUser = async (email, passwordHash, fullName) => {
    const result = await pool.query(
        `INSERT INTO users (email, password_hash, full_name)
     VALUES ($1, $2, $3)
     RETURNING user_id, email, full_name`,
        [email, passwordHash, fullName]
    );
    return result.rows[0];
};

const assignRole = async (userId, roleName) => {
    await pool.query(
        `INSERT INTO user_roles (user_id, role_id)
     SELECT $1, role_id FROM roles WHERE role_name = $2`,
        [userId, roleName]
    );
};

const createProfile = async (userId, accountType) => {
    await pool.query(
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
    return result.rowCount;
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

const updateSessionToken = async (sessionId, newTokenHash) => {
    await pool.query(
        `UPDATE refresh_tokens
     SET token_hash = $1, expires_at = now() + interval '7 days'
     WHERE session_id = $2`,
        [newTokenHash, sessionId]
    );
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
    // Sessions
    getActiveSessions,
    getDetailedSessions,
    getSessionCount,
    deleteSession,
    deleteSessionForUser,
    deleteAllOtherSessions,
    insertSession,
    findSessionByUserAndId,
    updateSessionToken,
    // Transactions
    beginTransaction,
    commitTransaction,
    rollbackTransaction,
};
