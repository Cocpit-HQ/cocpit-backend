const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middlewares/auth.middleware');
const { requireRoles } = require('../middlewares/role.middleware');
const { trackActivity } = require('../middlewares/activity.middleware');

// Apply authentication middleware to all admin routes
router.use(authenticateToken);
router.use(trackActivity);

const { getDashboardMetrics, getRecentAuditLogs, getAllAuditLogs, getEngagementHeatmap, getCohortRetention, getJobsMetrics } = require('../controllers/dashboard.controller');

const featureFlagRoutes = require('./featureFlag.routes');
router.use('/feature-flags', featureFlagRoutes);

// System Controls
router.get('/system-controls', requireRoles(['Developer']), (req, res) => {
  res.json({ message: 'System Controls Data (Read)' });
});
router.post('/system-controls', requireRoles(['Developer']), (req, res) => {
  res.json({ message: 'System Controls Settings Updated (Write)' });
});

// System Health & Audit Logs
router.get('/system-health', requireRoles(['Developer', 'Admin', 'Moderator']), (req, res) => {
  res.json({ message: 'System Health Metrics' });
});

router.get('/audit-logs/recent', requireRoles(['Developer', 'Admin', 'Moderator']), getRecentAuditLogs);
router.get('/audit-logs', requireRoles(['Developer', 'Admin', 'Moderator']), getAllAuditLogs);
router.get('/engagement-heatmap', requireRoles(['Developer', 'Admin', 'Moderator']), getEngagementHeatmap);
router.get('/cohort-retention', requireRoles(['Developer', 'Admin', 'Moderator']), getCohortRetention);
router.get('/dashboard/jobs-metrics', requireRoles(['Developer', 'Admin', 'Moderator']), getJobsMetrics);

// User & Organisation Management
const userController = require('../controllers/user.controller');
router.get('/users/roles', requireRoles(['Admin', 'Developer']), userController.getUserRoles);
router.get('/users', requireRoles(['Admin', 'Developer']), userController.getUsers);
router.get('/users/:id', requireRoles(['Admin', 'Developer', 'Moderator']), userController.getUserDetails);
router.post('/users/:id/warn', requireRoles(['Admin', 'Moderator']), userController.warnUser);
router.post('/users/bulk-warn', requireRoles(['Admin', 'Moderator']), userController.bulkWarnUsers);
router.post('/users/:id/suspend', requireRoles(['Admin', 'Moderator']), userController.suspendUser);
router.post('/users/bulk-suspend', requireRoles(['Admin', 'Moderator']), userController.bulkSuspendUsers);
router.post('/users/:id/unsuspend', requireRoles(['Admin', 'Moderator']), userController.unsuspendUser);
router.patch('/users/:id', requireRoles(['Admin']), userController.updateUser);
router.delete('/users/:id', requireRoles(['Admin']), userController.deleteUser);

const organizationController = require('../controllers/organization.controller');

router.get('/organisations', requireRoles(['Admin', 'Moderator', 'Developer']), organizationController.getOrganizations);
router.get('/organisations/industries', requireRoles(['Admin', 'Moderator', 'Developer']), organizationController.getOrganizationIndustries);
router.get('/organisations/verifications/queue', requireRoles(['Admin', 'Moderator', 'Developer']), organizationController.getVerificationQueue);
router.get('/organisations/:id', requireRoles(['Admin', 'Moderator', 'Developer']), organizationController.getOrganizationDetails);
router.post('/organisations/verifications/documents/:documentId/review', requireRoles(['Admin', 'Moderator']), organizationController.reviewDocument);
router.post('/organisations/verifications/:id/review', requireRoles(['Admin', 'Moderator']), organizationController.reviewOrganizationVerification);
router.post('/organisations/:id/warn', requireRoles(['Admin', 'Moderator']), organizationController.warnOrganization);
router.post('/organisations/:id/suspend', requireRoles(['Admin', 'Moderator']), organizationController.suspendOrganization);
router.post('/organisations/:id/unsuspend', requireRoles(['Admin', 'Moderator']), organizationController.unsuspendOrganization);

// Moderation Queue
const reportController = require('../controllers/report.controller');

router.get('/reports/reasons', requireRoles(['Admin', 'Moderator']), reportController.getReportReasons);
router.get('/reports', requireRoles(['Admin', 'Moderator']), reportController.getReports);
router.patch('/reports/:id', requireRoles(['Admin', 'Moderator']), reportController.updateReport);
router.delete('/posts/:id', requireRoles(['Admin', 'Moderator']), reportController.deleteReportedPost);
router.delete('/comments/:id', requireRoles(['Admin', 'Moderator']), reportController.deleteReportedComment);

router.get('/appeals', requireRoles(['Admin', 'Moderator']), reportController.getAppeals);
router.patch('/appeals/:id', requireRoles(['Admin']), reportController.updateAppeal);

const dashboardController = require('../controllers/dashboard.controller');

// Dashboard Metrics
router.get('/dashboard/system-metrics', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getSystemMetrics);
router.get('/dashboard/deployments', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getDeployments);
router.get('/dashboard/slow-queries', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getSlowQueries);
router.get('/dashboard/background-tasks', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getBackgroundTasks);
router.get('/dashboard/system-alerts', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getSystemAlerts);
router.get('/dashboard/metrics', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getDashboardMetrics);
router.get('/dashboard/organization-stats', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getOrganizationStats);
router.get('/dashboard/user-velocity', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getUserVelocity);
router.get('/dashboard/demographic-momentum', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getDemographicMomentum);
router.get('/dashboard/live-signups', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getLiveSignups);
router.get('/dashboard/regional-hotspots', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getRegionalHotspots);
router.get('/dashboard/internal-spread-metric', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getInternalSpreadMetric);
router.get('/dashboard/organization-demographics', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getOrganizationDemographics);
router.get('/dashboard/seat-utilization', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getSeatUtilization);
router.get('/dashboard/b2b-activity', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getB2BActivity);
router.get('/dashboard/organization-growth', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getOrganizationGrowthBreakdown);
router.get('/feature-adoption', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getFeatureAdoption);
router.get('/user-demographics', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getActiveUserDemographics);

// Feed Moderation & Engagement Routes
const feedController = require('../controllers/feed.controller');
router.get('/feed/metrics', requireRoles(['Admin', 'Moderator', 'Developer']), feedController.getFeedMetrics);
router.get('/feed/posts', requireRoles(['Admin', 'Moderator', 'Developer']), feedController.getFeedPosts);
router.get('/feed/posts/:id/comments', requireRoles(['Admin', 'Moderator', 'Developer']), feedController.getPostComments);
router.delete('/feed/posts/:id', requireRoles(['Admin', 'Moderator', 'Developer']), feedController.deleteFeedPost);
router.post('/feed/posts/:id/restore', requireRoles(['Admin', 'Moderator', 'Developer']), feedController.restoreFeedPost);
router.post('/feed/posts/:id/reject-appeal', requireRoles(['Admin', 'Moderator', 'Developer']), feedController.rejectFeedPostAppeal);
router.get('/feed/hashtags', requireRoles(['Admin', 'Moderator', 'Developer']), feedController.getTrendingHashtags);
router.get('/feed/leaderboard', requireRoles(['Admin', 'Moderator', 'Developer']), feedController.getFeedLeaderboard);

// Jobs Moderation Queue Routes
const jobController = require('../controllers/job.controller');
router.get('/jobs', requireRoles(['Admin', 'Moderator', 'Developer']), jobController.getJobs);
router.get('/jobs/:id', requireRoles(['Admin', 'Moderator', 'Developer']), jobController.getJobById);
router.patch('/jobs/:id/moderation', requireRoles(['Admin', 'Moderator', 'Developer']), jobController.moderateJob);

module.exports = router;
