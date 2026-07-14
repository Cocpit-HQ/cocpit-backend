const express = require('express');
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
