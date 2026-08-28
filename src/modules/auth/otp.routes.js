const express = require("express");
const { requestOTP, verifyOTP } = require("./otp.controller");
const rateLimit = require("express-rate-limit");

const router = express.Router();

/**
 * Layered Abuse Prevention Architecture (Evaluated in order: IP -> Device -> Account)
 * 
 * 1. IP Layer (Broadest): Max 30 requests per IP per 15 minutes
 * 2. Device Layer: Max 15 requests per Device ID / User-Agent fingerprint per 15 minutes
 * 3. Account / Email Layer: Max 3 OTP requests per target email per 60 seconds
 */

// 1. IP Limiter
const ipLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 30,
    message: {
        message: "Too many requests from this location. Please try again later."
    },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.ip || req.headers["x-forwarded-for"] || "ip-unknown",
});

// 2. Device Limiter
const deviceLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 15,
    message: {
        message: "Too many requests from this device. Please try again later."
    },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        const deviceId = req.headers["x-device-id"];
        if (deviceId) return String(deviceId);
        const userAgent = req.headers["user-agent"] || "agent-unknown";
        return `${req.ip || ""}_${userAgent}`;
    },
});

// 3. Account / Email Limiter
const emailLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 3,
    message: {
        message: "Too many OTP requests for this email. Please try again after a minute."
    },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        return req.body.email ? req.body.email.toLowerCase().trim() : (req.ip || "account-unknown");
    }
});

// Routes with layered rate limiters evaluated in strict order (IP -> Device -> Account)
router.post("/request-otp", ipLimiter, deviceLimiter, emailLimiter, requestOTP);
router.post("/verify-otp", ipLimiter, deviceLimiter, verifyOTP);

module.exports = router;

