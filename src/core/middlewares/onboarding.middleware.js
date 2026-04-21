const pool = require("../db/pool");

/**
 * Middleware to enforce onboarding completion.
 * Prevents access to main application features until the user has finished the onboarding process.
 * 
 * Optimized to skip DB hits for users who already have the 'onboarding_complete' flag in their JWT.
 */
exports.enforceOnboarding = async (req, res, next) => {
  // 1. Whitelist routes that must be accessible during onboarding
  const whitelistedPaths = [
    "/api/auth",
    "/api/onboarding",
    "/api/device",
    "/api/config",
    "/uploads", // Allow access to static files (e.g., for seeing the avatar being uploaded)
  ];

  const isWhitelisted = whitelistedPaths.some((path) => 
    req.originalUrl.startsWith(path)
  );

  if (isWhitelisted) {
    return next();
  }

  // 2. Ensure user context exists (should be called after requireAuth)
  if (!req.user) {
    return res.status(401).json({ message: "Authentication required" });
  }

  // 3. Optimization: Trust JWT if it says onboarding is complete
  if (req.user.onboarding_complete === true) {
    req.isOnboardingComplete = true;
    return next();
  }

  // 4. DB Fallback: Check source of truth (handles stale tokens)
  try {
    const result = await pool.query(
      "SELECT is_onboarding_complete FROM users WHERE user_id = $1",
      [req.user.sub]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const isComplete = result.rows[0].is_onboarding_complete;
    req.isOnboardingComplete = isComplete;

    if (!isComplete) {
      console.warn(`[Onboarding] Blocking access for user ${req.user.sub} - Onboarding incomplete`);
      return res.status(403).json({
        code: "ONBOARDING_REQUIRED",
        message: "Please complete your onboarding to access this feature.",
      });
    }

    next();
  } catch (err) {
    console.error("Onboarding enforcement error:", err);
    res.status(500).json({ message: "Internal server error during onboarding validation" });
  }
};
