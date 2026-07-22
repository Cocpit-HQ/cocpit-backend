const requireRoles = (allowedRoles) => {
  return (req, res, next) => {
    if (!req.user || !req.user.roles) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const userRoles = Array.isArray(req.user.roles) ? req.user.roles : [req.user.roles];
    const allowedLower = allowedRoles.map(r => r.toLowerCase());
    const hasRole = userRoles.some(role => allowedLower.includes(String(role).toLowerCase()));

    if (!hasRole) {
      return res.status(403).json({ error: 'Forbidden: Insufficient permissions' });
    }

    next();
  };
};

module.exports = { requireRoles };
