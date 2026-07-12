const express = require("express");
const router = express.Router();
const communityController = require("./community.controller");
const { requireAuth, optionalAuth } = require("../../core/middlewares/auth.middleware");
const { requireOrgPermission } = require("../../core/middlewares/organization.auth.middleware");
const { uploadCommunityBanner } = require("../../core/middlewares/upload.middleware");

// --- GROUP 1: Community Creation (Company Side) ---
router.get(
    "/organizations/:orgId/community/status",
    requireAuth,
    requireOrgPermission("MANAGE_COMPANY_DETAILS"),
    communityController.getCommunityStatus
);

router.post(
    "/organizations/:orgId/community",
    requireAuth,
    requireOrgPermission("MANAGE_COMPANY_DETAILS"),
    uploadCommunityBanner.single("banner"),
    communityController.createCommunity
);

router.put(
    "/organizations/:orgId/community",
    requireAuth,
    requireOrgPermission("MANAGE_COMPANY_DETAILS"),
    uploadCommunityBanner.single("banner"),
    communityController.updateCommunity
);

router.delete(
    "/organizations/:orgId/community",
    requireAuth,
    requireOrgPermission("MANAGE_COMPANY"),
    communityController.deactivateCommunity
);

// --- GROUP 2: Subscription & Engagement (User Side) ---
router.get(
    "/communities/subscriptions",
    requireAuth,
    communityController.getSubscribedCommunities
);

router.get(
    "/communities/:communityId/articles",
    requireAuth,
    communityController.getCommunityArticles
);

// --- GROUP 3: Invitation Flow ---
router.get(
    "/organizations/:orgId/community/invite-suggestions",
    requireAuth,
    requireOrgPermission("INVITE_MEMBERS"),
    communityController.getInviteSuggestions
);

router.post(
    "/organizations/:orgId/community/invite",
    requireAuth,
    requireOrgPermission("INVITE_MEMBERS"),
    communityController.sendInvitation
);

router.get(
    "/communities/invitations",
    requireAuth,
    communityController.getPendingInvitations
);

router.post(
    "/communities/invitations/:inviteId/accept",
    requireAuth,
    communityController.acceptInvitation
);

router.post(
    "/communities/invitations/:inviteId/ignore",
    requireAuth,
    communityController.ignoreInvitation
);

// --- GROUP 4: Search & Discovery ---
router.get(
    "/communities/recommended",
    requireAuth,
    communityController.getRecommendedCommunities
);

router.get(
    "/communities/search",
    optionalAuth,
    communityController.searchCommunities
);

module.exports = router;
