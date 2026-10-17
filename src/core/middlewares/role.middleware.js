exports.requireRoles = (roles) => {
  return (req, res, next) => {
    const userRoles = req.user?.roles;

    if (!userRoles) {
      return res.status(403).json({ message: "Forbidden: No roles found" });
    }

    const hasRequiredRole = userRoles.some(role => roles.includes(role));

    if (!hasRequiredRole) {
      return res.status(403).json({ message: "Forbidden: Insufficient permissions" });
    }

    next();
  };
};
