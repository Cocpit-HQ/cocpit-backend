const express = require("express");
const { requestOTP, verifyOTP } = require("./otp.controller");
const rateLimit = require("express-rate-limit");

const router = express.Router();

/**
 * Rate Limiting — two independent layers:
 *
 * 1. Per-email: max 3 OTP requests per email per 60 seconds
 *    Prevents a single email from being spammed with OTPs.
 *
 * 2. Per-IP: max 30 OTP requests per IP per 15 minutes
 *    Prevents a single attacker IP from probing many different emails.
 */
const requestOTPEmailLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 3,
    message: {
        message: "Too many OTP requests for this email. Please try again after a minute."
    },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        // Rate limit based on the email requested, fallback to IP
        return req.body.email ? req.body.email.toLowerCase().trim() : req.ip;
    }
});

const requestOTPIpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 30,
    message: {
        message: "Too many OTP requests from this location. Please try again later."
    },
    standardHeaders: true,
    legacyHeaders: false,
    // keyGenerator defaults to req.ip — which is what we want
});

// Routes
router.post("/request-otp", requestOTPIpLimiter, requestOTPEmailLimiter, requestOTP);
router.post("/verify-otp", verifyOTP); // DB handles the 5 attempts limit, no need for express-rate-limit here

module.exports = router;
