// src/modules/jobs/applications/application.controller.js
'use strict';

const {
  getJobOwnership,
  getApplicantList,
  getApplicationDetail,
  getLatestAnalysis,
  upsertNote,
  getApplicationOwnership,
} = require('./application.queries');

const { checkOrgPermission } = require('../../../core/utils/rbac');
const { hasActorPermission } = require('../../../core/middlewares/actor-context.middleware');
const pool = require('../../../core/db/pool');
const { compareExperience, getLatestEducation } = require('./application.utils');

// ─── Shared auth helper ───────────────────────────────────────────────────────
// Asserts that the requesting user is either the direct recruiter or an org
// member with one of the given permissions. Throws a 403-tagged error on failure.
async function assertRecruiterAccess(req, { org_id, recruiter_id }, permissions) {
  const userId = req.user.sub;

  // 1. Direct recruiter ownership
  if (recruiter_id === userId) return;

  if (org_id) {
    // 2. Actor-context check (set by actor-context.middleware for org tokens)
    if (req.actor?.type === 'ORGANIZATION' && req.actor.orgId === org_id) {
      const hasPermission = permissions.some(p =>
        hasActorPermission(req.actor.permissions || [], p)
      );
      if (hasPermission) return;
    }

    // 3. DB-level RBAC fallback
    const ok = await checkOrgPermission(pool, org_id, userId, permissions);
    if (ok) return;
  }

  const err = new Error('Not authorized to access applicants for this job');
  err.statusCode = 403;
  throw err;
}

// ─── Handler 1 ───────────────────────────────────────────────────────────────
// GET /api/jobs/:id/applicants?status=Applied|Shortlisted|Approved|Rejected
// Lightweight list — only what the candidate list card needs.
exports.getApplicantList = async (req, res) => {
  const jobId = req.params.id;
  const { status } = req.query;

  try {
    const ownership = await getJobOwnership(jobId);
    if (!ownership) {
      return res.status(404).json({ message: 'Job not found' });
    }

    await assertRecruiterAccess(req, ownership, [
      'VIEW_APPLICANTS', 'MANAGE_APPLICANTS', 'MANAGE_COMPANY',
    ]);

    const rows = await getApplicantList(jobId, status);

    const response = rows.map(row => ({
      applicationId: row.applicationId,
      applicantId:   row.applicantId,
      name:          row.name,
      headline:      row.headline || '',
      avatarUrl:     row.avatarUrl || null,
      location:      row.location || '',
      email:         row.email,
      status:        row.status,
      appliedAt:     row.appliedAt,
      matchScore:    row.matchScore ?? null,   // null = AI analysis pending
      screening: row.screeningRequired ? {
        required:    true,
        type:        row.screeningType,
        submittedAt: row.screeningSubmittedAt || null,
      } : null,
      initials: row.name
        ? row.name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase()
        : '??',
    }));

    res.json(response);

  } catch (err) {
    if (err.statusCode === 403) {
      return res.status(403).json({ message: err.message });
    }
    console.error('[getApplicantList]', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// ─── Handler 2 ───────────────────────────────────────────────────────────────
// GET /api/jobs/applications/:id
// Full application detail for the right-hand panel.
exports.getApplicationDetail = async (req, res) => {
  const applicationId = req.params.id;
  const userId = req.user.sub;

  try {
    const ownership = await getApplicationOwnership(applicationId);
    if (!ownership) {
      return res.status(404).json({ message: 'Application not found' });
    }

    await assertRecruiterAccess(req, ownership, [
      'VIEW_APPLICANTS', 'MANAGE_APPLICANTS', 'MANAGE_COMPANY',
    ]);

    const detail = await getApplicationDetail(applicationId, userId);
    if (!detail) {
      return res.status(404).json({ message: 'Application not found' });
    }

    const screening = detail.screeningRequired ? {
      required:    true,
      type:        detail.screeningType,
      question:    detail.screeningQuestion,
      submittedAt: detail.screeningSubmittedAt || null,
      responseUrl: detail.screeningResponseUrl || null,
    } : null;

    res.json({
      applicationId: detail.applicationId,
      applicantId:   detail.applicantId,
      name:          detail.name,
      email:         detail.email,
      phone:         detail.phone || null,
      avatarUrl:     detail.avatarUrl || null,
      headline:      detail.headline || '',
      location:      detail.location || '',
      about:         detail.about || null,
      coverNote:     detail.coverNote || null,
      resumeUrl:     detail.resumeUrl,
      resumeName:    detail.resumeUrl
        ? detail.resumeUrl.split('/').pop()
        : 'Resume.pdf',
      status:        detail.status,
      appliedAt:     detail.appliedAt,
      skills:        detail.skills   || [],
      experience:    detail.experience || [],
      education:     detail.education  || [],
      screening,
      selfNote:      detail.selfNote || null,
    });

  } catch (err) {
    if (err.statusCode === 403) {
      return res.status(403).json({ message: err.message });
    }
    console.error('[getApplicationDetail]', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// ─── Handler 3 ───────────────────────────────────────────────────────────────
// PUT /api/jobs/applications/:id/status
// Update application status + optional screening config on Shortlist.
exports.updateApplicationStatus = async (req, res) => {
  const applicationId = req.params.id;
  const { status, screening } = req.body;

  const VALID_STATUSES = [
    'Applied', 'Shortlisted', 'Approved', 'Rejected', 'Interview', 'Offer',
  ];

  if (!status || !VALID_STATUSES.includes(status)) {
    return res.status(400).json({
      message: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}`,
    });
  }

  try {
    const ownership = await getApplicationOwnership(applicationId);
    if (!ownership) {
      return res.status(404).json({ message: 'Application not found' });
    }

    await assertRecruiterAccess(req, ownership, [
      'MANAGE_APPLICANTS', 'MANAGE_COMPANY',
    ]);

    // Build SET clause — screening fields only written when Shortlisting with a task
    const setClauses = ['current_status = $1'];
    const params = [status];
    let pIdx = 2;

    if (status === 'Shortlisted' && screening?.required) {
      setClauses.push(
        `screening_required = TRUE`,
        `screening_type = $${pIdx}`,
        `screening_question = $${pIdx + 1}`
      );
      params.push(screening.type, screening.question);
      pIdx += 2;
    }

    params.push(applicationId);
    const whereParam = `$${pIdx}`;

    await pool.query(
      `UPDATE job_applications
       SET ${setClauses.join(', ')}
       WHERE application_id = ${whereParam}`,
      params
    );

    // Log to status history
    await pool.query(
      `INSERT INTO application_status_history (application_id, status)
       VALUES ($1, $2)`,
      [applicationId, status]
    );

    res.json({ message: 'Status updated', status });

  } catch (err) {
    if (err.statusCode === 403) {
      return res.status(403).json({ message: err.message });
    }
    console.error('[updateApplicationStatus]', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// ─── Handler 4 ───────────────────────────────────────────────────────────────
// PUT /api/jobs/applications/:id/note
// Upsert the requesting recruiter's self-note for this application.
exports.upsertNote = async (req, res) => {
  const applicationId = req.params.id;
  const userId = req.user.sub;
  const { body } = req.body;

  if (!body || typeof body !== 'string' || body.trim().length === 0) {
    return res.status(400).json({ message: 'Note body is required' });
  }

  if (body.trim().length > 2000) {
    return res.status(400).json({ message: 'Note cannot exceed 2000 characters' });
  }

  try {
    const ownership = await getApplicationOwnership(applicationId);
    if (!ownership) {
      return res.status(404).json({ message: 'Application not found' });
    }

    await assertRecruiterAccess(req, ownership, [
      'VIEW_APPLICANTS', 'MANAGE_APPLICANTS', 'MANAGE_COMPANY',
    ]);

    const note = await upsertNote(applicationId, userId, body.trim());

    res.json(note);

  } catch (err) {
    if (err.statusCode === 403) {
      return res.status(403).json({ message: err.message });
    }
    console.error('[upsertNote]', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// ─── Handler 5 ───────────────────────────────────────────────────────────────
// GET /api/jobs/applications/:id/analysis
// Returns the latest AI analysis row, or null if no analysis has been run.
// null is a valid and expected response — the UI shows "Pending analysis".
exports.getAnalysis = async (req, res) => {
  const applicationId = req.params.id;

  try {
    const ownership = await getApplicationOwnership(applicationId);
    if (!ownership) {
      return res.status(404).json({ message: 'Application not found' });
    }

    await assertRecruiterAccess(req, ownership, [
      'VIEW_APPLICANTS', 'MANAGE_APPLICANTS', 'MANAGE_COMPANY',
    ]);

    let analysis = await getLatestAnalysis(applicationId);

    if (!analysis) {
      analysis = {
        matchScore: null,
        summary: null,
        skills: null,
        provider: null,
        model: null,
      };
    }

    // ── Determine Experience and Qualification deterministically ──
    // Fetch application detail for candidate's actual experience and education
    const applicationDetail = await getApplicationDetail(applicationId, req.user?.sub);
    
    // Fetch job requirement limits
    const jobRes = await pool.query(`
      SELECT j.experience_min, j.experience_max, j.experience_label 
      FROM jobs j
      JOIN job_applications ja ON j.job_id = ja.job_id
      WHERE ja.application_id = $1
    `, [applicationId]);
    
    const job = jobRes.rows[0];

    if (applicationDetail && job) {
      // Query exact total experience matching the User Profile (which doesn't have LIMIT 3)
      const expRes = await pool.query(`
        SELECT COALESCE(SUM(
          EXTRACT(YEAR FROM COALESCE(e.end_date, CURRENT_DATE)) - EXTRACT(YEAR FROM e.start_date)
        ), 0) as total_years
        FROM experiences e
        JOIN profiles p ON e.profile_id = p.profile_id
        JOIN job_applications ja ON ja.applicant_id = p.user_id
        WHERE ja.application_id = $1
      `, [applicationId]);
      
      let totalYears = parseInt(expRes.rows[0]?.total_years || 0, 10);
      if (totalYears === 0) totalYears = 1; // Fallback to match LivingResume logic

      analysis.experience = compareExperience(totalYears, job.experience_min, job.experience_max, job.experience_label);
      analysis.qualification = getLatestEducation(applicationDetail.education);
    }

    res.json(analysis); // null is intentional — means "Pending analysis"

  } catch (err) {
    if (err.statusCode === 403) {
      return res.status(403).json({ message: err.message });
    }
    console.error('[getAnalysis]', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// ─── Handler 6 — AI ENGINEER STUB ────────────────────────────────────────────
// POST /api/jobs/applications/:id/analyze
// Route is registered so the frontend won't receive 404.
// Implementation is owned by the AI engineer.
//
// Contract:
//   - Load application + job data from DB.
//   - Call AI provider (Gemini / GPT / etc.).
//   - Parse response into the JSONB shapes defined in application_ai_analyses.
//   - INSERT a row into application_ai_analyses.
//   - Return the newly created analysis object (same shape as GET /analysis).
exports.triggerAnalysis = async (_req, res) => {
  res.status(501).json({
    message: 'AI analysis trigger not yet implemented.',
    note: 'This endpoint is reserved for the AI engineer. See application_ai_analyses table contract.',
  });
};
