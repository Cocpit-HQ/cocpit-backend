const express = require("express");
const { requestOTP, verifyOTP } = require("./otp.controller");
const rateLimit = require("express-rate-limit");

const router = express.Router();

/**
 * Rate Limiting
 * Rules: max 3 OTP requests per email per minute
 */
const requestOTPLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 3,
    message: {
        message: "Too many OTP requests from this email. Please try again after a minute."
    },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        // Rate limit based on the email requested, fallback to IP
        return req.body.email ? req.body.email.toLowerCase().trim() : req.ip;
    }
});

// Routes
router.post("/request-otp", requestOTPLimiter, requestOTP);
router.post("/verify-otp", verifyOTP); // DB handles the 5 attempts limit, no need for express-rate-limit here

module.exports = router;
