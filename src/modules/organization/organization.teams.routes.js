'use strict';

const express = require('express');
const router = express.Router({ mergeParams: true });

const teamsCtrl = require('./organization.teams.controller');
const { requireAuth } = require('../../core/middlewares/auth.middleware');
const { requireOrgAccess } = require('../../core/middlewares/org-rbac.middleware');
const featureFlagsService = require('../config/featureFlags.service');

const checkTeamsModule = (req, res, next) => {
    const flags = featureFlagsService.getFlags();
    if (
        flags['enableTeamsModule'] === false ||
        flags['enableTeams'] === false ||
        flags['enable_teams'] === false ||
        flags['enable_teams_module'] === false ||
        flags['teams'] === false
    ) {
        return res.status(403).json({
            success: false,
            message: 'Teams module is currently disabled by administrator.'
        });
    }
    next();
};

router.use(checkTeamsModule);

// Roles
router.get('/roles',                 requireAuth, requireOrgAccess('TEAMS'),          teamsCtrl.getRoles);
router.get('/roles/:roleId',         requireAuth, requireOrgAccess('TEAMS'),          teamsCtrl.getRoleById);
router.post('/roles',                requireAuth, requireOrgAccess('MANAGE_ROLES'),   teamsCtrl.createRole);
router.put('/roles/:roleId',         requireAuth, requireOrgAccess('MANAGE_ROLES'),   teamsCtrl.updateRole);
router.delete('/roles/:roleId',      requireAuth, requireOrgAccess('MANAGE_ROLES'),   teamsCtrl.deleteRole);
router.get('/roles/:roleId/members', requireAuth, requireOrgAccess('TEAMS'),          teamsCtrl.getRoleMembers);
router.get('/permission-keys',       requireAuth, requireOrgAccess('MANAGE_ROLES'),   teamsCtrl.getPermissionKeys);

// Members
router.get('/members',               requireAuth, requireOrgAccess('TEAMS'),          teamsCtrl.getMembers);
router.get('/members/:userId',       requireAuth, requireOrgAccess('TEAMS'),          teamsCtrl.getMemberDetail);
router.put('/members/:userId/role',  requireAuth, requireOrgAccess('MANAGE_MEMBERS'), teamsCtrl.updateMemberRole);
router.delete('/members/:userId',    requireAuth, requireOrgAccess('REMOVE_MEMBERS'), teamsCtrl.removeMember);
router.post('/transfer-ownership',   requireAuth, requireOrgAccess('OWNER_ONLY'),    teamsCtrl.transferOwnership);

// Invites
router.get('/invite-candidates',     requireAuth, requireOrgAccess('INVITE_MEMBERS'), teamsCtrl.getInviteCandidates);
router.post('/invite',               requireAuth, requireOrgAccess('INVITE_MEMBERS'), teamsCtrl.sendInvite);
router.delete('/invites/:inviteId',  requireAuth, requireOrgAccess('INVITE_MEMBERS'), teamsCtrl.withdrawInvite);
router.get('/invites/pending',       requireAuth, requireOrgAccess('INVITE_MEMBERS'), teamsCtrl.getPendingInvites);

// Activity Logs
router.get('/activity',              requireAuth, requireOrgAccess('ACTIVITY_LOGS'),  teamsCtrl.getActivityLogs);

module.exports = router;
