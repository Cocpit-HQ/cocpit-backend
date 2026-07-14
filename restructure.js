
const fs = require('fs');
const path = require('path');

const baseDir = path.join(__dirname, 'src/admin/modules');

const filesToCreate = {
  'system/system.routes.js': `const express = require('express');
const router = express.Router();
const { requireRoles } = require('../../middlewares/role.middleware');

router.get('/controls', requireRoles(['Developer']), (req, res) => {
  res.json({ message: 'System Controls Data (Read)' });
});

router.post('/controls', requireRoles(['Developer']), (req, res) => {
  res.json({ message: 'System Controls Settings Updated (Write)' });
});

router.get('/health', requireRoles(['Developer', 'Admin', 'Moderator']), (req, res) => {
  res.json({ message: 'System Health Metrics' });
});

module.exports = router;
`,
  'dashboard/dashboard.routes.js': `const express = require('express');
const router = express.Router();
const { requireRoles } = require('../../middlewares/role.middleware');
const dashboardController = require('./dashboard.controller');

router.get('/system-metrics', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getSystemMetrics);
router.get('/deployments', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getDeployments);
router.get('/slow-queries', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getSlowQueries);
router.get('/background-tasks', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getBackgroundTasks);
router.get('/system-alerts', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getSystemAlerts);
router.get('/metrics', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getDashboardMetrics);
router.get('/organization-stats', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getOrganizationStats);
router.get('/user-velocity', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getUserVelocity);
router.get('/demographic-momentum', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getDemographicMomentum);
router.get('/live-signups', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getLiveSignups);
router.get('/regional-hotspots', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getRegionalHotspots);
router.get('/internal-spread-metric', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getInternalSpreadMetric);
router.get('/organization-demographics', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getOrganizationDemographics);
router.get('/seat-utilization', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getSeatUtilization);
router.get('/b2b-activity', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getB2BActivity);
router.get('/organization-growth', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getOrganizationGrowthBreakdown);
router.get('/jobs-metrics', requireRoles(['Developer', 'Admin', 'Moderator']), dashboardController.getJobsMetrics);

module.exports = router;
`,
  'dashboard/analytics.routes.js': `const express = require('express');
const router = express.Router();
const { requireRoles } = require('../../middlewares/role.middleware');
const dashboardController = require('./dashboard.controller');

router.get('/audit-logs/recent', requireRoles(['Developer', 'Admin', 'Moderator']), dashboardController.getRecentAuditLogs);
router.get('/audit-logs', requireRoles(['Developer', 'Admin', 'Moderator']), dashboardController.getAllAuditLogs);
router.get('/engagement-heatmap', requireRoles(['Developer', 'Admin', 'Moderator']), dashboardController.getEngagementHeatmap);
router.get('/cohort-retention', requireRoles(['Developer', 'Admin', 'Moderator']), dashboardController.getCohortRetention);
router.get('/feature-adoption', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getFeatureAdoption);
router.get('/user-demographics', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getActiveUserDemographics);

module.exports = router;
`,
  'users/user.routes.js': `const express = require('express');
const router = express.Router();
const { requireRoles } = require('../../middlewares/role.middleware');
const userController = require('./user.controller');

router.get('/roles', requireRoles(['Admin', 'Developer']), userController.getUserRoles);
router.get('/', requireRoles(['Admin', 'Developer']), userController.getUsers);
router.get('/:id', requireRoles(['Admin', 'Developer', 'Moderator']), userController.getUserDetails);
router.post('/:id/warn', requireRoles(['Admin', 'Moderator']), userController.warnUser);
router.post('/bulk-warn', requireRoles(['Admin', 'Moderator']), userController.bulkWarnUsers);
router.post('/:id/suspend', requireRoles(['Admin', 'Moderator']), userController.suspendUser);
router.post('/bulk-suspend', requireRoles(['Admin', 'Moderator']), userController.bulkSuspendUsers);
router.post('/:id/unsuspend', requireRoles(['Admin', 'Moderator']), userController.unsuspendUser);
router.patch('/:id', requireRoles(['Admin']), userController.updateUser);
router.delete('/:id', requireRoles(['Admin']), userController.deleteUser);

module.exports = router;
`,
  'organizations/organization.routes.js': `const express = require('express');
const router = express.Router();
const { requireRoles } = require('../../middlewares/role.middleware');
const organizationController = require('./organization.controller');

router.get('/', requireRoles(['Admin', 'Moderator', 'Developer']), organizationController.getOrganizations);
router.get('/industries', requireRoles(['Admin', 'Moderator', 'Developer']), organizationController.getOrganizationIndustries);
router.get('/verifications/queue', requireRoles(['Admin', 'Moderator', 'Developer']), organizationController.getVerificationQueue);
router.get('/:id', requireRoles(['Admin', 'Moderator', 'Developer']), organizationController.getOrganizationDetails);
router.post('/verifications/documents/:documentId/review', requireRoles(['Admin', 'Moderator']), organizationController.reviewDocument);
router.post('/verifications/:id/review', requireRoles(['Admin', 'Moderator']), organizationController.reviewOrganizationVerification);
router.post('/:id/warn', requireRoles(['Admin', 'Moderator']), organizationController.warnOrganization);
router.post('/:id/suspend', requireRoles(['Admin', 'Moderator']), organizationController.suspendOrganization);
router.post('/:id/unsuspend', requireRoles(['Admin', 'Moderator']), organizationController.unsuspendOrganization);

module.exports = router;
`,
  'reports/report.routes.js': `const express = require('express');
const router = express.Router();
const { requireRoles } = require('../../middlewares/role.middleware');
const reportController = require('./report.controller');

router.get('/reasons', requireRoles(['Admin', 'Moderator']), reportController.getReportReasons);
router.get('/', requireRoles(['Admin', 'Moderator']), reportController.getReports);
router.patch('/:id', requireRoles(['Admin', 'Moderator']), reportController.updateReport);

module.exports = router;
`,
  'reports/appeal.routes.js': `const express = require('express');
const router = express.Router();
const { requireRoles } = require('../../middlewares/role.middleware');
const reportController = require('./report.controller');

router.get('/', requireRoles(['Admin', 'Moderator']), reportController.getAppeals);
router.patch('/:id', requireRoles(['Admin']), reportController.updateAppeal);

module.exports = router;
`,
  'reports/moderation.routes.js': `const express = require('express');
const router = express.Router();
const { requireRoles } = require('../../middlewares/role.middleware');
const reportController = require('./report.controller');

router.delete('/posts/:id', requireRoles(['Admin', 'Moderator']), reportController.deleteReportedPost);
router.delete('/comments/:id', requireRoles(['Admin', 'Moderator']), reportController.deleteReportedComment);

module.exports = router;
`,
  'feed/feed.routes.js': `const express = require('express');
const router = express.Router();
const { requireRoles } = require('../../middlewares/role.middleware');
const feedController = require('./feed.controller');

router.get('/metrics', requireRoles(['Admin', 'Moderator', 'Developer']), feedController.getFeedMetrics);
router.get('/posts', requireRoles(['Admin', 'Moderator', 'Developer']), feedController.getFeedPosts);
router.get('/posts/:id/comments', requireRoles(['Admin', 'Moderator', 'Developer']), feedController.getPostComments);
router.delete('/posts/:id', requireRoles(['Admin', 'Moderator', 'Developer']), feedController.deleteFeedPost);
router.post('/posts/:id/restore', requireRoles(['Admin', 'Moderator', 'Developer']), feedController.restoreFeedPost);
router.post('/posts/:id/reject-appeal', requireRoles(['Admin', 'Moderator', 'Developer']), feedController.rejectFeedPostAppeal);
router.get('/hashtags', requireRoles(['Admin', 'Moderator', 'Developer']), feedController.getTrendingHashtags);
router.get('/leaderboard', requireRoles(['Admin', 'Moderator', 'Developer']), feedController.getFeedLeaderboard);

module.exports = router;
`,
  'jobs/job.routes.js': `const express = require('express');
const router = express.Router();
const { requireRoles } = require('../../middlewares/role.middleware');
const jobController = require('./job.controller');

router.get('/', requireRoles(['Admin', 'Moderator', 'Developer']), jobController.getJobs);
router.get('/:id', requireRoles(['Admin', 'Moderator', 'Developer']), jobController.getJobById);
router.patch('/:id/moderation', requireRoles(['Admin', 'Moderator', 'Developer']), jobController.moderateJob);

module.exports = router;
`
};

for (const [relPath, content] of Object.entries(filesToCreate)) {
  fs.writeFileSync(path.join(baseDir, relPath), content);
}
