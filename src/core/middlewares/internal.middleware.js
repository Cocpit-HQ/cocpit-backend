const requireInternalSecret = (req, res, next) => {
  const secret = req.headers['x-internal-secret'];
  const expectedSecret = process.env.INTERNAL_API_SECRET;

  if (!expectedSecret) {
    console.error('INTERNAL_API_SECRET is not configured.');
    return res.status(500).json({ success: false, message: 'Internal configuration error' });
  }

  if (!secret || secret !== expectedSecret) {
    return res.status(401).json({ success: false, message: 'Unauthorized internal access' });
  }

  next();
};

module.exports = { requireInternalSecret };
