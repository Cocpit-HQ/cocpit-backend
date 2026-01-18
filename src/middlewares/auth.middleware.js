const { verifyAccessToken, verifyRefreshToken } = require("../utils/jwt");

exports.requireAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ message: "Missing token" });
  }

  const token = authHeader.split(" ")[1];

  try {
    req.user = verifyAccessToken(token);
    next();
  } catch {
    res.status(401).json({ message: "Invalid or expired token" });
  }
};

exports.requireRefreshTokenAuth = (req, res, next) => {
  const cookieToken = req.cookies.refreshToken;

  if (!cookieToken) {
    return res.status(401).json({ message: "Missing token" });
  }

  // const token = authHeader.split(" ")[1];

  try {
    req.user = verifyRefreshToken(cookieToken);
    next();
  } catch {
    res.status(401).json({ message: "Invalid or expired token" });
  }
};

exports.optionalAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return next();

  const token = authHeader.split(" ")[1];
  try {
    req.user = verifyAccessToken(token);
  } catch (err) {
    // Ignore invalid tokens for optional auth
  }
  next();
};
