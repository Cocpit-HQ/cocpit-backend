const pool = require("../db/pool");

/**
 * Routes that are strictly forbidden before onboarding is complete.
 * This acts as a "Hard Block" layer for high-risk data.
 */
const HARD_BLOCKED_ROUTES = [
  "/api/dashboard",
  "/api/report",
  "/api/jobs",
  "/api/feed",
  "/api/messaging",
  "/api/activity",
  "/api/social"
];


/**
 * Middleware to enforce onboarding completion.
 * Replaces fragile whitelist with structured Onboarding Access Control.
 */
exports.enforceOnboarding = async (req, res, next) => {
  const { method, originalUrl: path } = req;

  // 1. JWT Optimization: Trust flag if onboarding is complete
  if (req.user?.onboarding_complete === true) {
    req.isOnboardingComplete = true;
    return next();
  }

  // 2. Explicit Hard Block Check (Safety Layer)
  const isHardBlocked = HARD_BLOCKED_ROUTES.some((blockedPath) =>
    path.startsWith(blockedPath)
  );

  // 3. If it's NOT a hard blocked route, allow free access for flexibility during onboarding
  if (!isHardBlocked) {
    return next();
  }

  // 4. Ensure user context exists for protected routes
  if (!req.user) {
    return res.status(401).json({ message: "Authentication required" });
  }

  // 5. DB Source of Truth Fallback (Handles stale tokens & Resume signal)
  try {
    const result = await pool.query(
      "SELECT is_onboarding_complete, onboarding_step FROM users WHERE user_id = $1",
      [req.user.sub]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const { is_onboarding_complete, onboarding_step } = result.rows[0];
    req.isOnboardingComplete = is_onboarding_complete;

    if (!is_onboarding_complete) {
      console.warn(`[Onboarding] Access denied for user ${req.user.sub} to ${method} ${path}`);

      return res.status(403).json({
        code: "ONBOARDING_REQUIRED",
        message: "Please complete your onboarding to access this feature.",
        onboarding_step: onboarding_step || "ROLE" // Default fallback step
      });
    }

    next();
  } catch (err) {
    console.error("Onboarding enforcement error:", err);
    res.status(500).json({ message: "Internal server error during onboarding validation" });
  }
};
