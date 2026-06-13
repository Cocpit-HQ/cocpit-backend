const { verifyAccessToken, verifyRefreshToken } = require("../utils/jwt");
const { resolveActorContextForRequest } = require("./actor-context.middleware");
const redisClient = require("../db/redis");
const pool = require("../db/pool");

exports.requireAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ message: "Missing token" });
  }

  const token = authHeader.split(" ")[1];

  try {
    req.user = verifyAccessToken(token);

    if (redisClient.isOpen) {
      const isDeleted = await redisClient.get(`deleted_user:${req.user.sub}`);
      if (isDeleted) {
        return res.status(401).json({ message: "User account no longer exists. Please log in again." });
      }
    } else {
      // Fallback to database check if Redis is unavailable
      const userCheck = await pool.query("SELECT 1 FROM users WHERE user_id = $1", [req.user.sub]);
      if (userCheck.rowCount === 0) {
        return res.status(401).json({ message: "User account no longer exists. Please log in again." });
      }
    }

    req.actor = await resolveActorContextForRequest(req);
    next();
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ message: err.message });
    }
    res.status(401).json({ message: "Invalid or expired token" });
  }
};

exports.requireRefreshTokenAuth = (req, res, next) => {
  const cookieToken = req.cookies.refreshToken;

  if (!cookieToken) {
    return res.status(401).json({ message: "Missing token" });
  }

  try {
    req.user = verifyRefreshToken(cookieToken);
    next();
  } catch {
    res.status(401).json({ message: "Invalid or expired token" });
  }
};

exports.optionalAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return next();

  const token = authHeader.split(" ")[1];
  try {
    req.user = verifyAccessToken(token);

    if (redisClient.isOpen) {
      const isDeleted = await redisClient.get(`deleted_user:${req.user.sub}`);
      if (isDeleted) {
        req.user = null;
        return next();
      }
    } else {
      // Fallback to database check if Redis is unavailable
      const userCheck = await pool.query("SELECT 1 FROM users WHERE user_id = $1", [req.user.sub]);
      if (userCheck.rowCount === 0) {
        req.user = null;
        return next();
      }
    }

    req.actor = await resolveActorContextForRequest(req);
  } catch (err) {
    // Ignore all errors for optional auth (including 403s from actor resolution)
  }
  next();
};

exports.requireActiveSession = async (req, res, next) => {
  const pool = require("../db/pool");
  const userId = req.user?.sub;
  const sessionId = req.user?.sid;

  if (!userId || !sessionId) {
    return res.status(401).json({ message: "Invalid session context" });
  }

  try {
    const result = await pool.query(
      `SELECT 1 FROM refresh_tokens 
       WHERE user_id = $1 AND session_id = $2 
       AND revoked = FALSE AND expires_at > NOW()`,
      [userId, sessionId]
    );

    if (result.rowCount === 0) {
      return res.status(401).json({
        message: "Session expired or terminated. Please log in again.",
        forceLogout: true,
      });
    }

    next();
  } catch (err) {
    console.error("Session validity check error:", err);
    res.status(500).json({ message: "Internal server error during session validation" });
  }
};
