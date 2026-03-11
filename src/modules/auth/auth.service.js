/**
 * Auth Service
 * Business logic for authentication — token management, session enforcement, password validation.
 * No req/res access. Calls repository for data.
 */
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const { hashPassword, comparePassword } = require("../../core/utils/password");
const { signAccessToken, signRefreshToken, verifyRefreshToken, verifyAccessToken } = require("../../core/utils/jwt");
const { verifyGoogleToken } = require("./googleAuth.service");
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
    // Guard: Google-only users have NULL password_hash — reject gracefully.
    if (!user.password_hash) {
        return { error: { status: 401, message: "This account uses Google Sign-In. Please log in with Google." } };
    }
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

    const hashedRefresh = crypto.createHash("sha256").update(refreshToken).digest("hex");

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

    // 3. Validate token hash (Backward compatibility for legacy bcrypt hashes)
    let isValid = false;
    
    // Check if the stored hash is a bcrypt hash (starts with $2b$ or $2a$ and is ~60 chars long)
    if (session.token_hash && session.token_hash.startsWith("$2")) {
        isValid = await bcrypt.compare(refreshTokenValue, session.token_hash);
    } else {
        // Otherwise, it's our new SHA-256 hex string
        const expectedHash = crypto.createHash("sha256").update(refreshTokenValue).digest("hex");
        // Use timingSafeEqual to prevent timing attacks, ensuring both are buffers of the exact same length
        try {
            isValid = crypto.timingSafeEqual(
                Buffer.from(expectedHash, "hex"),
                Buffer.from(session.token_hash, "hex")
            );
        } catch (e) {
            isValid = false; // Fails if lengths don't match or other buffer issues
        }
    }

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

    // Hash the rotated token with fast SHA-256
    const hashedNewRefreshToken = crypto.createHash("sha256").update(newRefreshToken).digest("hex");
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

// ─── Google Login ──────────────────────────────────────────────────────────────

/**
 * Handles Google Sign-In / Sign-Up.
 *
 * Three possible scenarios:
 *   1. User already has a google_id linked → standard login.
 *   2. User exists by email but has no google_id → link Google account, then login.
 *   3. User doesn't exist → create new account (requires accountType).
 *
 * In ALL scenarios, we issue platform JWT tokens (access + refresh) using
 * the exact same session pipeline as email/password login.
 */
const googleLogin = async ({ idToken, accountType, userAgent, ipAddress }) => {
    // ── Step 1: Verify Google ID token (audience + signature + email_verified) ──
    let googleUser;
    try {
        googleUser = await verifyGoogleToken(idToken);
    } catch (err) {
        return { error: { status: 401, message: "Invalid or expired Google token" } };
    }

    const { googleId, email, fullName, avatarUrl } = googleUser;
    const normalizedEmail = email.toLowerCase();

    // ── Step 2: Find or create the user ──
    let user;
    let isNewUser = false;

    // Case 1: Check if Google ID is already linked to an account
    user = await authRepo.findUserByGoogleId(googleId);

    if (!user) {
        // Case 2: Check if email exists (local account that hasn't linked Google yet)
        user = await authRepo.findUserByEmail(normalizedEmail);

        if (user) {
            // Prevent linking if this Google ID is somehow already used by another email
            // (the UNIQUE constraint on google_id handles this at DB level too)
            await authRepo.linkGoogleId(user.user_id, googleId);
        } else {
            // Case 3: Brand new user — accountType is REQUIRED
            if (!accountType) {
                return {
                    error: {
                        status: 400,
                        message: "accountType is required for new Google sign-ups",
                    },
                };
            }

            const validTypes = ["Fresher", "Student", "Employer", "Admin"];
            if (!validTypes.includes(accountType)) {
                return {
                    error: {
                        status: 400,
                        message: `Invalid accountType. Must be one of: ${validTypes.join(", ")}`,
                    },
                };
            }

            // Create user with Google identity (password_hash is NULL)
            user = await authRepo.createGoogleUser(normalizedEmail, fullName, googleId, avatarUrl);

            // Assign role — same logic as standard registration
            let roleName;
            if (accountType === "Admin") roleName = "Admin";
            else if (accountType === "Employer") roleName = "Employer";
            else roleName = "Student";

            await authRepo.assignRole(user.user_id, roleName);
            await authRepo.createProfile(user.user_id, accountType);

            isNewUser = true;
        }
    }

    // ── Step 3: Generate platform tokens (reuses existing JWT pipeline) ──
    const sessionId = crypto.randomUUID();
    const roles = await authRepo.getUserRoles(user.user_id);
    const onboardingComplete = isNewUser ? false : (user.is_onboarding_complete || false);

    const accessToken = signAccessToken({
        sub: user.user_id,
        sid: sessionId,
        roles,
        onboarding_complete: onboardingComplete,
    });

    const refreshToken = signRefreshToken({
        sub: user.user_id,
        sid: sessionId,
    });

    const hashedRefresh = crypto.createHash("sha256").update(refreshToken).digest("hex");

    // ── Step 4: Store session (respects existing 10-device limit) ──
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

    // Warm block cache (async, non-blocking) — same as email login
    const BlockModel = require("../../models/block.model");
    BlockModel.cacheBlocks(user.user_id).catch(e => console.error("Block cache warm-up failed", e));

    return {
        accessToken,
        refreshToken,
        user: {
            id: user.user_id,
            email: user.email || normalizedEmail,
            full_name: user.full_name || fullName,
            avatar_url: user.avatar_url || avatarUrl,
            roles,
            onboarding_complete: onboardingComplete,
            account_name: user.account_name || null,
        },
        isNewUser,
    };
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
    googleLogin,
    refreshTokens,
    logoutUser,
    getCurrentUser,
    verifyPasswordForAction,
    COOKIE_OPTIONS,
};
