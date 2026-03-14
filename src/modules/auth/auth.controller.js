/**
 * Auth Controller (Thin)
 * Parses request, calls service, sends response. No SQL. No business logic.
 */
const authService = require("./auth.service");
const otpService = require("./otp.service");
const actorContextService = require("./actorContext.service");

// ─── Register ──────────────────────────────────────────────────────────────────

exports.register = async (req, res) => {
    const { email, password, fullName, accountType, otp } = req.body;

    try {
        const otpResult = await otpService.verifyOTP(email, otp);
        if (otpResult.error) {
            return res.status(otpResult.error.status).json({ message: otpResult.error.message });
        }

        const result = await authService.registerUser({ email, password, fullName, accountType });

        if (result.error) {
            return res.status(result.error.status).json({ message: result.error.message });
        }

        res.status(201).json({
            message: "User registered successfully",
            user: result.user,
        });
    } catch (err) {
        console.error("Registration error:", err);
        if (err.code === "28P01") {
            return res.status(500).json({ error: "Database authentication failed. Please check your database credentials." });
        }
        res.status(500).json({ error: err.message });
    }
};

// ─── Login ─────────────────────────────────────────────────────────────────────

exports.login = async (req, res) => {
    const { email, password } = req.body;
    const userAgent = req.headers["user-agent"] || "unknown";
    const ipAddress = req.ip || "unknown";

    try {
        const result = await authService.loginUser({ email, password, userAgent, ipAddress });

        if (result.error) {
            return res.status(result.error.status).json({ message: result.error.message });
        }

        // Set refresh token cookie
        res.cookie("refreshToken", result.refreshToken, {
            ...authService.COOKIE_OPTIONS,
            maxAge: 7 * 24 * 60 * 60 * 1000,
        });

        console.log("✅ Login successful:", email);

        return res.status(200).json({
            accessToken: result.accessToken,
            refreshToken: result.refreshToken,
            user: result.user,
        });
    } catch (err) {
        console.error("❌ Login error:", err);
        return res.status(500).json({ message: "Internal server error" });
    }
};

// ─── Refresh Token ─────────────────────────────────────────────────────────────

exports.refreshToken = async (req, res) => {
    const refreshToken = req.cookies?.refreshToken || req.body?.refreshToken;

    if (!refreshToken) {
        return res.status(401).json({ message: "Refresh token missing", refreshToken });
    }

    try {
        const result = await authService.refreshTokens(refreshToken);

        if (result.error) {
            res.clearCookie("refreshToken", authService.COOKIE_OPTIONS);
            return res.status(result.error.status).json({
                error: result.error.code,
                message: result.error.message,
            });
        }

        // Set refreshed cookie
        res.cookie("refreshToken", result.refreshToken, {
            ...authService.COOKIE_OPTIONS,
            maxAge: 7 * 24 * 60 * 60 * 1000,
        });

        return res.status(200).json({
            accessToken: result.accessToken,
        });
    } catch (err) {
        console.error("Refresh token error:", err);
        res.clearCookie("refreshToken");
        return res.status(403).json({ message: "Invalid or expired refresh token" });
    }
};

// ─── Logout ────────────────────────────────────────────────────────────────────

exports.logout = async (req, res) => {
    console.log("🚪 [BE] Logout endpoint HIT");

    try {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith("Bearer ")) {
            console.warn("⚠️ [BE] Missing Authorization header");
            return res.status(401).json({ message: "Missing access token" });
        }

        const accessToken = authHeader.split(" ")[1];
        await authService.logoutUser(accessToken);

        res.clearCookie("refreshToken", authService.COOKIE_OPTIONS);
        console.log("✅ [BE] Logout completed");
        return res.status(200).json({ message: "Logged out successfully" });
    } catch (err) {
        console.error("❌ [BE] Logout error:", err);
        return res.status(401).json({ message: "Invalid or expired token" });
    }
};

// ─── Get Me ────────────────────────────────────────────────────────────────────

exports.getMe = async (req, res) => {
    const userId = req.user.sub;

    try {
        const result = await authService.getCurrentUser(userId, req.user.roles);

        if (result.error) {
            return res.status(result.error.status).json({ message: result.error.message });
        }

        res.json({ user: result.user, profile: result.profile });
    } catch (err) {
        console.error("GetMe error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.getActorContext = async (req, res) => {
    try {
        const result = await actorContextService.getActorContext(
            req.user.sub,
            req.cookies?.[actorContextService.ACTOR_CONTEXT_COOKIE_NAME]
        );

        if (result.clearCookie) {
            res.clearCookie(
                actorContextService.ACTOR_CONTEXT_COOKIE_NAME,
                actorContextService.ACTOR_CONTEXT_COOKIE_OPTIONS
            );
        }

        return res.json({
            actor: result.actor,
            organizations: result.organizations,
            source: result.source,
        });
    } catch (err) {
        console.error("Get actor context error:", err);
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }
};

exports.setActorContext = async (req, res) => {
    try {
        const result = await actorContextService.setActorContext(req.user.sub, req.body);

        if (result.cookieValue) {
            res.cookie(
                actorContextService.ACTOR_CONTEXT_COOKIE_NAME,
                result.cookieValue,
                actorContextService.ACTOR_CONTEXT_COOKIE_OPTIONS
            );
        } else {
            res.clearCookie(
                actorContextService.ACTOR_CONTEXT_COOKIE_NAME,
                actorContextService.ACTOR_CONTEXT_COOKIE_OPTIONS
            );
        }

        return res.json({
            actor: result.actor,
            organizations: result.organizations,
            source: result.source,
        });
    } catch (err) {
        console.error("Set actor context error:", err);
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }
};

// ─── Google Login ──────────────────────────────────────────────────────────────

/**
 * POST /auth/google
 *
 * Accepts a Google ID token (from the frontend Google Identity Services SDK)
 * and either signs in or creates a new user.
 *
 * Request body:
 *   { idToken: string, accountType?: "Student" | "Fresher" | "Employer" | "Admin" }
 *   accountType is required only for new user sign-ups.
 *
 * Response (same shape as /auth/login):
 *   { accessToken: string, user: { id, email, full_name, avatar_url, roles, onboarding_complete, account_name } }
 *   Refresh token is set as an httpOnly cookie.
 *
 * Example request:
 *   POST /auth/google
 *   Content-Type: application/json
 *   { "idToken": "eyJhbGci...", "accountType": "Student" }
 *
 * Example response:
 *   201 (new user) or 200 (existing user)
 *   {
 *     "accessToken": "eyJhbGci...",
 *     "user": {
 *       "id": "uuid",
 *       "email": "user@gmail.com",
 *       "full_name": "John Doe",
 *       "avatar_url": "https://lh3.googleusercontent.com/...",
 *       "roles": ["Student"],
 *       "onboarding_complete": false,
 *       "account_name": null
 *     }
 *   }
 */
exports.googleLogin = async (req, res) => {
    const { idToken, accountType } = req.body;
    const userAgent = req.headers["user-agent"] || "unknown";
    const ipAddress = req.ip || "unknown";

    if (!idToken) {
        return res.status(400).json({ message: "idToken is required" });
    }

    try {
        const result = await authService.googleLogin({ idToken, accountType, userAgent, ipAddress });

        if (result.error) {
            return res.status(result.error.status).json({ message: result.error.message });
        }

        // Set refresh token cookie — identical to email/password login
        res.cookie("refreshToken", result.refreshToken, {
            ...authService.COOKIE_OPTIONS,
            maxAge: 7 * 24 * 60 * 60 * 1000,
        });

        const statusCode = result.isNewUser ? 201 : 200;

        console.log(`✅ Google login successful: ${result.user.email} (${result.isNewUser ? "new" : "existing"})`);

        return res.status(statusCode).json({
            accessToken: result.accessToken,
            user: result.user,
        });
    } catch (err) {
        console.error("❌ Google login error:", err);

        // Handle duplicate google_id constraint violation
        if (err.code === "23505" && err.constraint?.includes("google_id")) {
            return res.status(409).json({ message: "This Google account is already linked to another user" });
        }

        return res.status(500).json({ message: "Internal server error" });
    }
};
