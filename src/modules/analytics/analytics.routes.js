const express = require('express');
const router = express.Router();

const { requireAuth } = require('../../core/middlewares/auth.middleware');
const analyticsController = require('./analytics.controller');
const postAnalyticsController = require('./post.analytics.controller');

// Input validation middleware
const validateAnalyticsQuery = (req, res, next) => {
    const { filter, startDate, endDate, sort } = req.query;

    if (filter === 'custom') {
        if (!startDate || !endDate) {
            return res.status(400).json({ status: 'error', message: 'startDate and endDate are required when filter is custom' });
        }
        if (new Date(startDate) > new Date(endDate)) {
            return res.status(400).json({ status: 'error', message: 'startDate cannot be after endDate' });
        }
    }

    // Pass valid sort or default (specific endpoints might override or enforce rules)
    req.query.sort = sort || 'top_performing';

    next();
};

// Profile Analytics Routes
// NOTE: These are mounted under /users/me/analytics in the router configuration or app.js
// If app.js mounts this router at /api, then the routes should include /users/me/analytics
router.get('/users/me/analytics/overview', requireAuth, validateAnalyticsQuery, analyticsController.getOverview);
router.get('/users/me/analytics/audience', requireAuth, validateAnalyticsQuery, analyticsController.getAudience);
router.get('/users/me/analytics/opportunities', requireAuth, validateAnalyticsQuery, analyticsController.getOpportunities);
router.get('/users/me/analytics/content', requireAuth, validateAnalyticsQuery, analyticsController.getContent);

// Post Analytics Routes
router.get('/posts/:postId/analytics', requireAuth, validateAnalyticsQuery, postAnalyticsController.getPostAnalytics);

// Resume Event Tracking
router.post('/analytics/resume-events', requireAuth, analyticsController.recordResumeEvent);

module.exports = router;
