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
 * Controlled access rules for users in the onboarding phase.
 * Each rule defines a path, allowed method, and matching strategy.
 */
const ONBOARDING_ALLOWED_ROUTES = [
  // Auth & Identity
  { path: "/api/auth/me", method: "GET", exact: true },
  { path: "/api/auth/logout", method: "POST", exact: true },
  { path: "/api/auth/actor-context", method: "GET", exact: true },
  
  // Onboarding Core
  { path: "/api/onboarding", method: "GET", prefix: true },
  { path: "/api/onboarding", method: "POST", prefix: true },
  { path: "/api/onboarding", method: "PATCH", prefix: true },
  
  // Profile Self-Service (Limited)
  { path: "/api/profile/me", method: "GET", exact: true },
  { path: "/api/profile/identity", method: "GET", exact: true },
  { path: "/api/profile/avatar", method: "GET", exact: true },
  
  // Metadata & Config
  { path: "/api/location", method: "GET", prefix: true },
  { path: "/api/config", method: "GET", exact: true },
  { path: "/uploads", method: "GET", prefix: true }
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

  // 2. Structured Route Matching
  const isAllowed = ONBOARDING_ALLOWED_ROUTES.some((route) => {
    const pathMatch = route.exact
      ? path === route.path
      : route.prefix
      ? path.startsWith(route.path + "/") || path === route.path
      : false;

    const methodMatch = route.method === "ANY" || route.method === method;

    return pathMatch && methodMatch;
  });

  // 3. Explicit Hard Block Check (Safety Layer)
  const isHardBlocked = HARD_BLOCKED_ROUTES.some((blockedPath) =>
    path.startsWith(blockedPath)
  );

  if (isAllowed && !isHardBlocked) {
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
