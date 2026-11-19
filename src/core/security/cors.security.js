/**
 * CORS and Network Security Utilities
 * Centralizes origin validation across HTTP (Express) and WebSockets (Socket.IO).
 */

/**
 * Validates CORS origins and disallows public development tunnels in production (VULN-08).
 * @param {string|null} origin - Incoming HTTP Origin header
 * @param {object} [options={}] - Options, e.g. { nodeEnv, allowedOrigins }
 * @returns {boolean} Whether the origin is allowed
 */
function isOriginAllowed(origin, options = {}) {
    if (!origin) return true; // allow same-origin, curl, server-to-server

    const nodeEnv = options.nodeEnv || process.env.NODE_ENV || "development";
    const isProduction = nodeEnv === "production";
    const allowedOrigins = options.allowedOrigins || (process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(",").map(o => o.trim()).filter(Boolean) : []);

    // 1. Production Whitelisted Domains
    if (
        origin === "https://frontend.cocpit.in" ||
        origin === "https://staging.cocpit.in" ||
        origin === "https://uat.cocpit.in" ||
        allowedOrigins.includes(origin)
    ) {
        return true;
    }

    // 2. Localhost & Private Network
    if (
        origin.match(/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/) ||
        origin.match(/^http:\/\/192\.168\.\d+\.\d+(:\d+)?$/)
    ) {
        return true;
    }

    // 3. Development Tunnels (ngrok, localtunnel) strictly blocked in production
    const isTunnel =
        origin.match(/^https:\/\/.*\.ngrok-free\.(app|dev)$/) ||
        origin.match(/^https:\/\/.*\.loca\.lt$/);

    if (isTunnel) {
        return !isProduction;
    }

    return false;
}

module.exports = {
    isOriginAllowed,
};
