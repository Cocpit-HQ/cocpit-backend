const rateLimit = require('express-rate-limit');

// Global Limiter for all Admin Routes (10000 reqs per 15 minutes for dev)
const adminGlobalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, 
  max: 10000, 
  message: {
    success: false,
    error: 'Too many requests from this IP, please try again after 15 minutes'
  },
  standardHeaders: true, 
  legacyHeaders: false, 
});

// Strict Limiter for Admin Authentication Routes (5 reqs per 15 minutes)
const adminAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, 
  max: 5, 
  message: {
    success: false,
    error: 'Too many login attempts from this IP, please try again after 15 minutes'
  },
  standardHeaders: true, 
  legacyHeaders: false, 
});

module.exports = {
  adminGlobalLimiter,
  adminAuthLimiter
};
