/**
 * Auth Controller (Thin)
 * Parses request, calls service, sends response. No SQL. No business logic.
 */
const authService = require("./auth.service");

// ─── Register ──────────────────────────────────────────────────────────────────

exports.register = async (req, res) => {
    const { email, password, fullName, accountType } = req.body;

    try {
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
