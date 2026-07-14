const express = require('express');
const router = express.Router();
const controller = require('./public_appeal.controller');

router.get('/verify', controller.verifyToken);
router.post('/submit', controller.submitAppeal);

module.exports = router;
