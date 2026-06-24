// src/modules/jobs/applications/application.routes.js
'use strict';

const express = require('express');
const router  = express.Router();
const ctrl    = require('./application.controller');
const { requireAuth } = require('../../../core/middlewares/auth.middleware');

// All application routes require authentication
router.use(requireAuth);

// ── Applicant list for a job ─────────────────────────────────────────────────
// GET /api/jobs/:id/applicants?status=Applied|Shortlisted|Approved|Rejected
router.get('/:id/applicants', ctrl.getApplicantList);

// ── Per-application endpoints ─────────────────────────────────────────────────
// GET    /api/jobs/applications/:id
router.get('/applications/:id', ctrl.getApplicationDetail);

// PUT    /api/jobs/applications/:id/status
router.put('/applications/:id/status', ctrl.updateApplicationStatus);

// PUT    /api/jobs/applications/:id/note
router.put('/applications/:id/note', ctrl.upsertNote);

// GET    /api/jobs/applications/:id/analysis
router.get('/applications/:id/analysis', ctrl.getAnalysis);

// POST   /api/jobs/applications/:id/analyze  — AI engineer stub
router.post('/applications/:id/analyze', ctrl.triggerAnalysis);

module.exports = router;
