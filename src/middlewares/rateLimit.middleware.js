const rateLimit = (options) => {
  const windowMs = options.windowMs || 15 * 60 * 1000; // Default 15 minutes
  const max = options.max || 100; // Default 100 requests
  const message = options.message || "Too many requests, please try again later.";

  const hits = new Map();

  // Cleanup mechanism to prevent memory leak
  setInterval(() => {
    const now = Date.now();
    for (const [ip, data] of hits.entries()) {
      if (now > data.resetTime) {
        hits.delete(ip);
      }
    }
  }, windowMs);

  return (req, res, next) => {
    const ip = req.ip;
    const now = Date.now();

    if (!hits.has(ip)) {
      hits.set(ip, { count: 1, resetTime: now + windowMs });
      return next();
    }

    const data = hits.get(ip);

    if (now > data.resetTime) {
      // Window expired, reset
      hits.set(ip, { count: 1, resetTime: now + windowMs });
      return next();
    }

    if (data.count >= max) {
      return res.status(429).json({ message });
    }

    data.count++;
    next();
  };
};

module.exports = rateLimit;
