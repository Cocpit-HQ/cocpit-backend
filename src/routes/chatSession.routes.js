/**
 * Company Chat Session Routes
 * All routes require authentication via requireAuth
 */

const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middlewares/auth.middleware");
const { sessionRateLimiter } = require("../utils/sessionRateLimiter");
const chatSessionCtrl = require("../controllers/chatSession.controller");

// Claim a conversation
router.post(
    "/company-chat-sessions/claim",
    requireAuth,
    sessionRateLimiter('session:claim'),
    chatSessionCtrl.claimSession
);

// Release (end) a session
router.post(
    "/company-chat-sessions/release",
    requireAuth,
    chatSessionCtrl.releaseSession
);

// Force takeover an active session
router.post(
    "/company-chat-sessions/takeover",
    requireAuth,
    sessionRateLimiter('session:takeover'),
    chatSessionCtrl.takeoverSession
);

// Get active session for a conversation
router.get(
    "/company-chat-sessions/active",
    requireAuth,
    chatSessionCtrl.getActiveSession
);

// Get session history for a company (admin audit)
router.get(
    "/company-chat-sessions/history",
    requireAuth,
    chatSessionCtrl.getSessionHistory
);

// Get messages for a specific session (audit)
router.get(
    "/company-chat-sessions/:sessionId/messages",
    requireAuth,
    chatSessionCtrl.getSessionMessages
);

module.exports = router;
