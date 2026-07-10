const express = require('express');
const router = express.Router();
const featureFlagController = require('../controllers/featureFlag.controller');
const { authenticateToken } = require('../middlewares/auth.middleware');
const { requireRoles } = require('../middlewares/role.middleware');
const { validate } = require('../middlewares/validate.middleware');
const { updateFlagSchema } = require('../schemas/admin.schemas');

router.use(authenticateToken);

// Developers and Admins can view and modify flags
router.get('/', requireRoles(['Developer', 'Admin']), featureFlagController.getFlags);
router.put('/', requireRoles(['Developer', 'Admin']), validate(updateFlagSchema), featureFlagController.updateFlag);

module.exports = router;
