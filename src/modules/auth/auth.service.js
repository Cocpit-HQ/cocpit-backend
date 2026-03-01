/**
 * Auth Service
 * Business logic for authentication — token management, session enforcement, password validation.
 * No req/res access. Calls repository for data.
 */
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const { hashPassword, comparePassword } = require("../../core/utils/password");
const { signAccessToken, signRefreshToken, verifyRefreshToken, verifyAccessToken } = require("../../core/utils/jwt");
const authRepo = require("./auth.repository");

const MAX_DEVICES = 10;

const COOKIE_OPTIONS = {
    httpOnly: true,
    secure: true,
    sameSite: "None",
    path: "/",
};

// ─── Registration ──────────────────────────────────────────────────────────────

const registerUser = async ({ email, password, fullName, accountType }) => {
    const normalizedEmail = email.toLowerCase();

    const exists = await authRepo.checkEmailExists(normalizedEmail);
    if (exists) {
        return { error: { status: 409, message: "Email already registered" } };
    }

    const passwordHash = await hashPassword(password);
    const user = await authRepo.createUser(normalizedEmail, passwordHash, fullName);

    let roleName;
    if (accountType === "Admin") roleName = "Admin";
    else if (accountType === "Employer") roleName = "Employer";
    else roleName = "Student";

    await authRepo.assignRole(user.user_id, roleName);
    await authRepo.createProfile(user.user_id, accountType);

    return { user };
};

// ─── Login ─────────────────────────────────────────────────────────────────────

const loginUser = async ({ email, password, userAgent, ipAddress }) => {
    const normalizedEmail = email.toLowerCase();
    const sessionId = crypto.randomUUID();

    // 1. Find user
    const user = await authRepo.findUserByEmail(normalizedEmail);
    if (!user) {
        return { error: { status: 401, message: "User not found" } };
    }

    // 2. Validate password
    const isValid = await comparePassword(password, user.password_hash);
    if (!isValid) {
        return { error: { status: 401, message: "Invalid credentials" } };
    }

    // 3. Fetch roles
    const roles = await authRepo.getUserRoles(user.user_id);

    // 4. Generate tokens
    const accessToken = signAccessToken({
        sub: user.user_id,
        sid: sessionId,
        roles,
        onboarding_complete: user.is_onboarding_complete,
    });

    const refreshToken = signRefreshToken({
        sub: user.user_id,
        sid: sessionId,
    });

    const hashedRefresh = await bcrypt.hash(refreshToken, 12);

    // 5. Enforce device limit (transaction)
    await authRepo.beginTransaction();
    try {
        const activeSessions = await authRepo.getActiveSessions(user.user_id);
        if (activeSessions.length >= MAX_DEVICES) {
            await authRepo.deleteSession(activeSessions[0].session_id);
        }
        await authRepo.insertSession(sessionId, user.user_id, hashedRefresh, userAgent, ipAddress);
        await authRepo.commitTransaction();
    } catch (err) {
        await authRepo.rollbackTransaction();
        throw err;
    }

    // 6. Warm block cache (async, non-blocking)
    const BlockModel = require("../../models/block.model");
    BlockModel.cacheBlocks(user.user_id).catch(e => console.error("Block cache warm-up failed", e));

    return {
        accessToken,
        refreshToken,
        user: {
            id: user.user_id,
            email: user.email,
            full_name: user.full_name,
            avatar_url: user.avatar_url,
            roles,
            onboarding_complete: user.is_onboarding_complete,
            account_name: user.account_name,
        },
    };
};

// ─── Refresh Token ─────────────────────────────────────────────────────────────

const refreshTokens = async (refreshTokenValue) => {
    // 1. Verify JWT
    let payload;
    try {
        payload = verifyRefreshToken(refreshTokenValue);
    } catch (err) {
        return { error: { status: 401, code: "SESSION_INVALID", message: "Session expired or invalid" } };
    }

    const { sub: userId, sid: sessionId } = payload;

    // 2. Find session in DB
    const session = await authRepo.findSessionByUserAndId(userId, sessionId);
    if (!session) {
        return { error: { status: 401, code: "SESSION_INVALID", message: "Session not found or terminated" } };
    }

    // 3. Validate token hash
    const isValid = await bcrypt.compare(refreshTokenValue, session.token_hash);
    if (!isValid) {
        await authRepo.deleteSession(sessionId);
        return { error: { status: 401, code: "SESSION_INVALID", message: "Security breach detected: session terminated" } };
    }

    // 4. Fetch roles + onboarding status
    const roles = await authRepo.getUserRoles(userId);
    const onboardingComplete = await authRepo.getOnboardingStatus(userId);

    // 5. Generate new tokens
    const newAccessToken = signAccessToken({
        sub: userId,
        sid: sessionId,
        roles,
        onboarding_complete: onboardingComplete,
    });

    const newRefreshToken = signRefreshToken({
        sub: userId,
        sid: sessionId,
    });

    const hashedNewRefreshToken = await bcrypt.hash(newRefreshToken, 12);
    await authRepo.updateSessionToken(sessionId, hashedNewRefreshToken);

    return { accessToken: newAccessToken, refreshToken: newRefreshToken };
};

// ─── Logout ────────────────────────────────────────────────────────────────────

const logoutUser = async (accessTokenValue) => {
    const { sub: userId, sid: sessionId } = verifyAccessToken(accessTokenValue, { ignoreExpiration: true });
    await authRepo.deleteSessionForUser(userId, sessionId);
    return { userId };
};

// ─── GetMe ─────────────────────────────────────────────────────────────────────

const getCurrentUser = async (userId, tokenRoles) => {
    const user = await authRepo.getUserById(userId);
    if (!user) {
        return { error: { status: 404, message: "User not found" } };
    }
    user.roles = tokenRoles;

    const profile = await authRepo.getUserProfile(userId);
    return { user, profile };
};

// ─── Session Management ────────────────────────────────────────────────────────

const verifyPasswordForAction = async (userId, password) => {
    const hash = await authRepo.getUserPasswordHash(userId);
    if (!hash) return false;
    return comparePassword(password, hash);
};

module.exports = {
    registerUser,
    loginUser,
    refreshTokens,
    logoutUser,
    getCurrentUser,
    verifyPasswordForAction,
    COOKIE_OPTIONS,
};
