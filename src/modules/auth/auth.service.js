/**
 * Auth Service
 * Business logic for authentication — token management, session enforcement, password validation.
 * No req/res access. Calls repository for data.
 */
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const { hashPassword, comparePassword } = require("../../core/utils/password");
const { signAccessToken, signRefreshToken, verifyRefreshToken, verifyAccessToken } = require("../../core/utils/jwt");
const { verifySocialToken } = require("./socialAuth.service");
const authRepo = require("./auth.repository");
const redisClient = require("../../core/db/redis");
const pool = require("../../core/db/pool");
const socketService = require("../../core/infrastructure/socket.service");

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

const _createDbSession = async (client, userId, sessionId, hashedRefresh, userAgent, ipAddress) => {
    const activeSessions = await authRepo.getActiveSessions(userId);
    if (activeSessions.length >= MAX_DEVICES) {
        await authRepo.deleteSession(activeSessions[0].session_id);
    }
    await authRepo.insertSession(sessionId, userId, hashedRefresh, userAgent, ipAddress);
};

const initializeUserSession = async (user, userAgent, ipAddress) => {
    const sessionId = crypto.randomUUID();
    const userId = user.user_id;

    // 1. Fetch roles
    const roles = await authRepo.getUserRoles(userId);

    // 2. Generate tokens
    const accessToken = signAccessToken({
        sub: userId,
        sid: sessionId,
        roles,
        onboarding_complete: user.is_onboarding_complete,
    });

    const refreshToken = signRefreshToken({
        sub: userId,
        sid: sessionId,
    });

    const hashedRefresh = crypto.createHash("sha256").update(refreshToken).digest("hex");

    // 3. Enforce device limit and store session in DB
    await authRepo.beginTransaction();
    try {
        await _createDbSession(null, userId, sessionId, hashedRefresh, userAgent, ipAddress);
        await authRepo.commitTransaction();
        console.log(`[Auth] ✅ Session created successfully for user: ${userId}`);
    } catch (err) {
        await authRepo.rollbackTransaction();
        throw err;
    }

    // 4. Warm block cache (async, non-blocking)
    const BlockModel = require("../../models/block.model");
    BlockModel.cacheBlocks(userId).catch(e => console.error("Block cache warm-up failed", e));

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

const registerUser = async ({ email, password, userAgent, ipAddress }) => {
    const normalizedEmail = email.toLowerCase();
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const emailCheck = await authRepo.checkEmailExists(normalizedEmail, client);
        if (emailCheck.exists) {
            await client.query("ROLLBACK");
            if (emailCheck.pendingDeletion) {
                return {
                    error: {
                        status: 409,
                        message: "An account with this email is scheduled for deletion. Check your email to restore it, or wait until the deletion completes.",
                    },
                };
            }
            return { error: { status: 409, message: "Email already registered" } };
        }

        const passwordHash = await hashPassword(password);

        let user = await authRepo.createUser(
            normalizedEmail,
            passwordHash,
            "",
            false,
            client
        );

        // Assign default Student role — inside transaction so it's atomic
        await authRepo.assignRole(user.user_id, "Student", client);

        await authRepo.createProfile(user.user_id, "Student", client);

        await client.query("COMMIT");

        // Refetch full user after commit
        const fullUser = await authRepo.findUserByEmail(normalizedEmail);

        // Auto-login: Initialize session after successful user/profile creation
        // If session creation fails, user still exists and can log in manually.
        try {
            const session = await initializeUserSession(fullUser, userAgent, ipAddress);
            return session;
        } catch (sessionErr) {
            console.error("[Auth] Session creation failed after registration — user can log in manually:", sessionErr);
            return {
                error: {
                    status: 503,
                    message: "Account created successfully, but we couldn't log you in automatically. Please sign in.",
                    code: "SESSION_INIT_FAILED",
                },
            };
        }

    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Register transaction failed:", err);
        return { error: { status: 500, message: "Registration failed" } };
    } finally {
        client.release();
    }
};

// ─── Login ─────────────────────────────────────────────────────────────────────

const loginUser = async ({ email, password, userAgent, ipAddress }) => {
    const normalizedEmail = email.toLowerCase();

    // 1. Find user
    const user = await authRepo.findUserByEmail(normalizedEmail);
    if (!user) {
        return { error: { status: 401, message: "User not found" } };
    }

    // 2. Validate password
    if (!user.password_hash) {
        return { error: { status: 401, message: "This account uses Google Sign-In. Please log in with Google." } };
    }
    const isValid = await comparePassword(password, user.password_hash);
    if (!isValid) {
        return { error: { status: 401, message: "Invalid credentials" } };
    }

    // 3. Block login if account is pending deletion
    if (user.deletion_execute_at) {
        return {
            error: {
                status: 403,
                code: "ACCOUNT_PENDING_DELETION",
                message: "Your account is scheduled for deletion. Check your email to restore it.",
                deletionDate: user.deletion_execute_at,
                email: user.email,
            },
        };
    }

    // 3.5 Auto-reactivate if deactivated & reset unread messages
    if (user.is_deactivated) {
        const pool = require("../../core/db/pool");
        const deactivatedSince = user.deactivated_at || new Date(0);
        await pool.query(`UPDATE users SET is_deactivated = FALSE, deactivated_at = NULL WHERE user_id = $1`, [user.user_id]);
        await pool.query(`UPDATE organizations SET is_deactivated = FALSE, deactivated_at = NULL WHERE created_by = $1 AND is_deleted = FALSE`, [user.user_id]);
        await pool.query(`DELETE FROM message_reads WHERE user_id = $1 AND read_at >= $2`, [user.user_id, deactivatedSince]);
    }

    // 4. Initialize session (Shared logic)
    return initializeUserSession(user, userAgent, ipAddress);
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
    const disconnectedSockets = await socketService.disconnectUserSession(userId, sessionId);
    return { userId, sessionId, disconnectedSockets };
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

// ─── Social Login ──────────────────────────────────────────────────────────────

/**
 * Handles Social Sign-In / Sign-Up for multiple providers (Google, Apple).
 *
 * Three possible scenarios:
 *   1. User already has a provider linked → standard login.
 *   2. User exists by email but hasn't linked provider → link provider, then login.
 *   3. User doesn't exist → create new account (requires accountType).
 *
 * In ALL scenarios, we issue platform JWT tokens (access + refresh) using
 * the exact same session pipeline as email/password login.
 */
const socialLogin = async ({ provider, idToken, accountType, userAgent, ipAddress }) => {
    // ── Step 1: Verify Social ID token ──
    let socialUser;
    try {
        socialUser = await verifySocialToken(provider, idToken);
    } catch (err) {
        return { error: { status: 401, message: `Invalid or expired ${provider} token` } };
    }

    const { providerId, email, fullName, avatarUrl } = socialUser;
    const normalizedEmail = email.toLowerCase();

    // ── Step 2: Find or create the user ──
    let user;
    let isNewUser = false;

    // Case 1: Check if provider ID is already linked to an account
    user = await authRepo.findUserBySocialId(provider, providerId);

    if (!user) {
        // Case 2: Check if email exists (local account that hasn't linked this provider yet)
        user = await authRepo.findUserByEmail(normalizedEmail);

        if (user) {
            // Guard: do not link or log in if account is pending deletion
            if (user.deletion_execute_at) {
                return {
                    error: {
                        status: 403,
                        code: "ACCOUNT_PENDING_DELETION",
                        message: "Your account is scheduled for deletion. Check your email to restore it.",
                        deletionDate: user.deletion_execute_at,
                        email: user.email,
                    },
                };
            }
            // Link this provider account to the existing user
            await authRepo.linkSocialAccount(user.user_id, provider, providerId);

        } else {
            // Case 3: Brand new user — accountType defaults to Student if not provided
            const finalAccountType = accountType || "Student";

            const validTypes = ["Fresher", "Student", "Employer", "Admin"];
            if (!validTypes.includes(finalAccountType)) {
                return {
                    error: {
                        status: 400,
                        message: `Invalid accountType. Must be one of: ${validTypes.join(", ")}`,
                    },
                };
            }

            // Create user with Social identity (password_hash is NULL)
            user = await authRepo.createSocialUser(normalizedEmail, fullName, provider, providerId, avatarUrl);

            // Assign role — same logic as standard registration
            let roleName;
            if (finalAccountType === "Admin") roleName = "Admin";
            else if (finalAccountType === "Employer") roleName = "Employer";
            else roleName = "Student";

            await authRepo.assignRole(user.user_id, roleName);
            await authRepo.createProfile(user.user_id, finalAccountType);

            isNewUser = true;
        }
    }

    // ── Step 3: Block login if account is pending deletion ──
    if (user.deletion_execute_at) {
        return {
            error: {
                status: 403,
                code: "ACCOUNT_PENDING_DELETION",
                message: "Your account is scheduled for deletion. Check your email to restore it.",
                deletionDate: user.deletion_execute_at,
                email: user.email,
            },
        };
    }

    // ── Step 3.5: Auto-reactivate if deactivated & reset unread messages ──
    if (user.is_deactivated) {
        const pool = require("../../core/db/pool");
        const deactivatedSince = user.deactivated_at || new Date(0);
        await pool.query(`UPDATE users SET is_deactivated = FALSE, deactivated_at = NULL WHERE user_id = $1`, [user.user_id]);
        await pool.query(`UPDATE organizations SET is_deactivated = FALSE, deactivated_at = NULL WHERE created_by = $1 AND is_deleted = FALSE`, [user.user_id]);
        await pool.query(`DELETE FROM message_reads WHERE user_id = $1 AND read_at >= $2`, [user.user_id, deactivatedSince]);
    }

    // ── Step 4: Generate platform tokens (reuses existing JWT pipeline) ──
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
    initializeUserSession,
    socialLogin,
    refreshTokens,
    logoutUser,
    getCurrentUser,
    verifyPasswordForAction,
    COOKIE_OPTIONS,
};
