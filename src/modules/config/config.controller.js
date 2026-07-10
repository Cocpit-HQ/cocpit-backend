/**
 * Config Controller
 *
 * Returns a safe, public config payload for mobile (Flutter) clients.
 * Called at app startup — must be fast, stateless, and contain NO secrets.
 *
 * All values are sourced from process.env with safe fallbacks.
 * Boolean values MUST use toBool() since process.env always returns strings.
 */

/**
 * Safely parse an env string to a boolean.
 * @param {string|undefined} val
 * @returns {boolean}
 */
const toBool = (val) => val === "true";

/**
 * GET /api/config
 * Public endpoint — no authentication required.
 */
const getConfig = (req, res) => {
  // Cache for 5 minutes — safe for a public, near-static endpoint.
  // Browsers and CDNs will respect this; Flutter http clients typically won't
  // unless explicitly configured to, but it helps at the infrastructure level.
  res.set("Cache-Control", "public, max-age=300");

  return res.status(200).json({
    // Schema version — increment (e.g., "1.1") when the structure changes
    // so old mobile clients can detect incompatibility before parsing.
    version: "1.0",

    // High-level health indicator for this environment.
    // Values: "ok" | "maintenance" | "degraded"
    status: toBool(process.env.APP_MAINTENANCE_MODE ?? "false")
      ? "maintenance"
      : "ok",

    // ISO timestamp of when this response was generated.
    // Helps Flutter clients detect stale cached configs.
    fetched_at: new Date().toISOString(),

    // Feature flags — controls what the mobile app should show/hide.
    // Fetched synchronously from in-memory cache (backed by Redis)
    features: require('./featureFlags.service').getFlags(),

    // App versioning and maintenance controls.
    app: {
      // Hard update threshold — if client is below this, force update.
      min_version_android: process.env.APP_MIN_VERSION_ANDROID ?? "1.0.0",
      min_version_ios: process.env.APP_MIN_VERSION_IOS ?? "1.0.0",

      // Soft update threshold — if client is below this, show a banner.
      latest_version: process.env.APP_LATEST_VERSION ?? "1.0.0",

      // If true, Flutter should block app entry and show a maintenance screen.
      maintenance_mode: toBool(process.env.APP_MAINTENANCE_MODE ?? "false"),

      // Flag to force an immediate update for all clients, regardless of version checks.
      force_update: false,
    },

    // Current deployment environment for client-side diagnostics/logging.
    env: process.env.NODE_ENV ?? "development",
  });
};

module.exports = { getConfig };
