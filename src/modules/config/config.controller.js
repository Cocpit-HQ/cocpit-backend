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
  // Prevent browser & CDN caching so feature flag toggles update instantly
  res.set("Cache-Control", "no-cache, no-store, must-revalidate");

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

    // =========================================================================
    // COCPIT OFFICIAL LEGAL DOCUMENTS
    // =========================================================================
    // Dynamic URL generation for localhost and hosted staging/production servers.
    // Supports process.env.LEGAL_*_URL overrides if custom URLs are specified in .env.
    // =========================================================================
    legal: {
      privacy_policy_url: process.env.LEGAL_PRIVACY_POLICY_URL || `${req?.protocol || 'http'}://${req?.get?.('host') || req?.headers?.host || 'localhost:5000'}/uploads/legal/privacy_policy.html`,
      terms_of_service_url: process.env.LEGAL_TERMS_OF_SERVICE_URL || `${req?.protocol || 'http'}://${req?.get?.('host') || req?.headers?.host || 'localhost:5000'}/uploads/legal/terms_of_service.html`,
      community_guidelines_url: process.env.LEGAL_COMMUNITY_GUIDELINES_URL || `${req?.protocol || 'http'}://${req?.get?.('host') || req?.headers?.host || 'localhost:5000'}/uploads/legal/community_guidelines.html`,
      cookie_policy_url: process.env.LEGAL_COOKIE_POLICY_URL || `${req?.protocol || 'http'}://${req?.get?.('host') || req?.headers?.host || 'localhost:5000'}/uploads/legal/cookie_policy.html`,
    },
  });
};

const toggleAIGeneration = async (req, res) => {
  const { enabled } = req.body;
  
  if (typeof enabled !== "boolean") {
    return res.status(400).json({ message: "'enabled' must be a boolean" });
  }

  try {
    const redis = require("../../core/db/redis");
    if (redis.isOpen || redis.isReady) {
      await redis.set("config:ai_generation_enabled", enabled ? "true" : "false");
      return res.status(200).json({ 
        message: `AI Generation has been ${enabled ? 'enabled' : 'disabled'}.`
      });
    } else {
      return res.status(503).json({ message: "Redis is not connected" });
    }
  } catch (err) {
    console.error("Toggle AI Generation error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

const toggleFeedAlgorithm = async (req, res) => {
  const { enabled } = req.body;
  
  if (typeof enabled !== "boolean") {
    return res.status(400).json({ message: "'enabled' must be a boolean" });
  }

  try {
    const redis = require("../../core/cache/redis"); // use cache/redis
    if (redis.isOpen || redis.isReady || redis.status === 'ready') {
      await redis.set("config:feed_algorithm_enabled", enabled ? "true" : "false");
      return res.status(200).json({ 
        message: `Feed Algorithm has been ${enabled ? 'enabled' : 'disabled'} globally.`
      });
    } else {
      return res.status(503).json({ message: "Redis is not connected" });
    }
  } catch (err) {
    console.error("Toggle Feed Algorithm error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

module.exports = { getConfig, toggleAIGeneration, toggleFeedAlgorithm };
