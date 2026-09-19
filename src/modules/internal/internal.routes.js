const express = require('express');
const router = express.Router();
const { requireInternalSecret } = require('../../core/middlewares/internal.middleware');
const internalController = require('./internal.controller');

// Apply internal secret middleware to all internal routes
router.use(requireInternalSecret);

// Health check / ping endpoint
router.get('/health', (req, res) => {
  res.json({ success: true, data: { status: 'healthy', service: 'cocpit-backend' } });
});

router.post('/appeals/notify', internalController.notifyAppealResolved);

module.exports = router;
