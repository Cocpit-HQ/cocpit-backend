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
const redisClient = require("../../core/db/redis");

const MAX_DEVICES = 10;
const REFRESH_REPLAY_WINDOW_SECONDS = Math.max(1, Number(process.env.REFRESH_REPLAY_WINDOW_SECONDS || 15));
const LOCAL_REFRESH_REPLAY_FALLBACK_TTL_MS = REFRESH_REPLAY_WINDOW_SECONDS * 1000;
const localRefreshReplayCache = new Map();

const COOKIE_OPTIONS = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "None" : "Lax",
    path: "/",
};

const hashTokenSha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

const buildRefreshReplayKey = (userId, sessionId, presentedTokenHash) =>
    `auth:refresh-replay:${userId}:${sessionId}:${presentedTokenHash}`;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const setLocalRefreshReplay = (key, payload) => {
    localRefreshReplayCache.set(key, {
        payload,
        expiresAt: Date.now() + LOCAL_REFRESH_REPLAY_FALLBACK_TTL_MS,
    });
};

const getLocalRefreshReplay = (key) => {
    const entry = localRefreshReplayCache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
        localRefreshReplayCache.delete(key);
        return null;
    }
    return entry.payload;
};

const cacheRefreshReplay = async (userId, sessionId, presentedTokenHash, tokens) => {
    const payload = { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
    const key = buildRefreshReplayKey(userId, sessionId, presentedTokenHash);

    setLocalRefreshReplay(key, payload);

    if (!redisClient.isOpen) return;
    try {
        await redisClient.setEx(key, REFRESH_REPLAY_WINDOW_SECONDS, JSON.stringify(payload));
    } catch (err) {
        console.warn("[Auth] Failed to write refresh replay cache to Redis:", err.message);
    }
};

const getRefreshReplay = async (userId, sessionId, presentedTokenHash) => {
    const key = buildRefreshReplayKey(userId, sessionId, presentedTokenHash);

    if (redisClient.isOpen) {
        try {
            const cached = await redisClient.get(key);
            if (cached) {
                const parsed = JSON.parse(cached);
                if (parsed?.accessToken && parsed?.refreshToken) {
                    setLocalRefreshReplay(key, parsed);
                    return parsed;
                }
            }
        } catch (err) {
            console.warn("[Auth] Failed to read refresh replay cache from Redis:", err.message);
        }
    }

    return getLocalRefreshReplay(key);
};

const waitForRefreshReplay = async (userId, sessionId, presentedTokenHash, maxAttempts = 12, delayMs = 50) => {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const replay = await getRefreshReplay(userId, sessionId, presentedTokenHash);
        if (replay) return replay;
        if (attempt < maxAttempts - 1) {
            await wait(delayMs);
        }
    }
    return null;
};

// ─── Registration ──────────────────────────────────────────────────────────────

const registerUser = async ({ email, password }) => {
    const normalizedEmail = email.toLowerCase();

    const exists = await authRepo.checkEmailExists(normalizedEmail);
    if (exists) {
        return { error: { status: 409, message: "Email already registered" } };
    }

    const passwordHash = await hashPassword(password);
    const user = await authRepo.createUser(normalizedEmail, passwordHash, "", false);

    // as per new design set it later with new data 
    // let roleName;
    // if (accountType === "Admin") roleName = "Admin";
    // else if (accountType === "Employer") roleName = "Employer";
    // else roleName = "Student";

    // await authRepo.assignRole(user.user_id, roleName);

    await authRepo.createProfile(user.user_id);

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
    const presentedRefreshHash = hashTokenSha256(refreshTokenValue);

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
        const expectedHash = presentedRefreshHash;
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
        const replay = await getRefreshReplay(userId, sessionId, presentedRefreshHash);
        if (replay) {
            console.log("[Auth] Replay-safe refresh hit. Returning cached rotated tokens.");
            return replay;
        }

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
    const hashedNewRefreshToken = hashTokenSha256(newRefreshToken);
    const rotated = await authRepo.updateSessionToken(sessionId, hashedNewRefreshToken, session.token_hash);

    // Another request rotated first. Return cached tokens for the same presented refresh token.
    if (!rotated) {
        const replay = await waitForRefreshReplay(userId, sessionId, presentedRefreshHash);
        if (replay) {
            console.log("[Auth] Concurrent refresh detected. Returning replay-cached tokens.");
            return replay;
        }
        return { error: { status: 401, code: "SESSION_INVALID", message: "Session refresh conflict. Please retry." } };
    }

    const rotatedTokens = { accessToken: newAccessToken, refreshToken: newRefreshToken };
    await cacheRefreshReplay(userId, sessionId, presentedRefreshHash, rotatedTokens);

    return rotatedTokens;
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
