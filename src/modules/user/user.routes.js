const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");
const userController = require("./user.controller");
const { requireAuth } = require("../../core/middlewares/auth.middleware");

// ─── Public Routes (no auth required) ─────────────────────────────────────────

// Restore account via email token
router.post("/account/restore", userController.restoreAccount);

// Resend recovery email — rate limited to prevent abuse
const resendRecoveryLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 1,
  message: { message: "Too many requests. Please wait before requesting another recovery email." },
  standardHeaders: true,
  legacyHeaders: false,
});
router.post("/account/resend-recovery", resendRecoveryLimiter, userController.resendRecoveryEmail);

// ─── Authenticated Routes ──────────────────────────────────────────────────────

router.use(requireAuth);

const { resolveActorContext } = require("../../core/middlewares/actor-context.middleware");

// Search users (real-time)
router.get("/search", resolveActorContext, userController.searchUsers);

// Get suggested users
router.get("/suggested", resolveActorContext, userController.getSuggestedUsers);

const { resolveActorContext } = require("../../core/middlewares/actor-context.middleware");

// Get public profile
router.get("/:id", resolveActorContext, userController.getUserProfile);

// Get public profile posts (commented) - must be BEFORE /:id to avoid shadowing
router.get("/:id/posts/commented", resolveActorContext, userController.getPublicProfileCommentedPosts);

// Get public profile posts
router.get("/:id/posts", resolveActorContext, userController.getPublicProfilePosts);

// Delete account (schedule soft deletion)
router.delete("/account", userController.deleteAccount);

module.exports = router;
