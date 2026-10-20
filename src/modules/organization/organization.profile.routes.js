'use strict';

const express = require('express');
const router = express.Router();

const profileCtrl = require('./organization.profile.controller');
const postsCtrl = require('./organization.posts.controller');
const jobsCtrl = require('./organization.jobs.controller');
const { requireAuth, optionalAuth } = require('../../core/middlewares/auth.middleware');
const { requireOrgPermission } = require('../../core/middlewares/organization.auth.middleware');
const { uploadChatMedia } = require('../../core/middlewares/upload.middleware');
const { resolveActorContext } = require('../../core/middlewares/actor-context.middleware');
const { validateSocialLinks } = require('./organization.validation');

// ---------------------------------------------------------------------------
// READ — public / optional auth
// ---------------------------------------------------------------------------

/**
 * GET /api/organizations/:orgId/profile
 * Home tab — overview, stats, about snippet, core team, latest posts, relationship
 * Auth: optional (own/other view determined by membership check inside controller)
 */
router.get('/:orgId/profile', optionalAuth, resolveActorContext, profileCtrl.getOrgProfile);

/**
 * GET /api/organizations/:orgId/about
 * About tab — description, offices, links, specialties
 * Own view includes sensitive fields (phone, email). Other view is read-only.
 * Auth: optional
 */
router.get('/:orgId/about', optionalAuth, profileCtrl.getOrgAbout);

/**
 * GET /api/organizations/:orgId/posts
 * Posts tab — cursor-paginated list of organization posts
 * Query: ?cursorCreatedAt=&cursorPostId=&limit=10
 * Auth: optional
 */
router.get('/:orgId/posts', optionalAuth, postsCtrl.getOrganizationPosts);

/**
 * GET /api/organizations/:orgId/jobs
 * Jobs tab — list of active jobs for the organization
 * Query: ?scope=public&limit=10&cursor=&status=
 * Auth: optional
 */
router.get('/:orgId/jobs', optionalAuth, jobsCtrl.getOrganizationJobs);

/**
 * GET /api/organizations/:orgId/team
 * Core team members — publicly visible
 * Auth: optional
 */
router.get('/:orgId/team', optionalAuth, profileCtrl.getOrgTeam);

/**
 * GET /api/organizations/:orgId/people
 * People tab — public member list (is_role_visible = true only)
 * Query: ?page=1&limit=20&search=
 * Auth: optional
 */
router.get('/:orgId/people', optionalAuth, profileCtrl.getOrgPeople);

/**
 * GET /api/organizations/:orgId/alumni
 * Alumni tab — INSTITUTION orgs only
 * Query: ?page=1&limit=20&search=&graduation_year=
 * Auth: optional
 */
router.get('/:orgId/alumni', optionalAuth, profileCtrl.getOrgAlumni);

// ---------------------------------------------------------------------------
// WRITE — requires auth + org permission
// ---------------------------------------------------------------------------

/**
 * PUT /api/organizations/:orgId/profile
 * Update profile details (Step 1): name, headline, industry, size, website,
 *                                   country, city, established_year
 * Auth: requireAuth + MANAGE_COMPANY_DETAILS permission
 */
router.put(
    '/:orgId/profile',
    requireAuth,
    requireOrgPermission('MANAGE_COMPANY_DETAILS'),
    profileCtrl.updateOrgProfile
);

/**
 * PUT /api/organizations/:orgId/about
 * Update about (Step 2): description, slogan, offices[], links[], specialties[]
 * Auth: requireAuth + MANAGE_COMPANY_DETAILS permission
 */
router.put(
    '/:orgId/about',
    requireAuth,
    validateSocialLinks,
    requireOrgPermission('MANAGE_COMPANY_DETAILS'),
    profileCtrl.updateOrgAbout
);

/**
 * PUT /api/organizations/:orgId/verification
 * Update verification details (Step 3): country_of_operation, documents[]
 * Auth: requireAuth
 */
router.put(
    '/:orgId/verification',
    requireAuth,
    uploadChatMedia.array('documents', 10),
    profileCtrl.updateOrgVerification
);

module.exports = router;
