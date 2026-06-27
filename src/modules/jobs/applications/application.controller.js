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
const { compareExperience, getLatestEducation, calculateTotalExperienceYears } = require('./application.utils');
const { generateLocalSystemFallback, analyzeCandidate } = require('../../../services/candidateAnalysis.service');

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
  const { status, minExperience, location, skills } = req.query;

  // Ensure skills is an array if passed
  let skillsArray = [];
  if (skills) {
    skillsArray = Array.isArray(skills) ? skills : [skills];
  }

  const filters = {
    status,
    minExperience,
    location,
    skills: skillsArray
  };

  try {
    const ownership = await getJobOwnership(jobId);
    if (!ownership) {
      return res.status(404).json({ message: 'Job not found' });
    }

    await assertRecruiterAccess(req, ownership, [
      'VIEW_APPLICANTS', 'MANAGE_APPLICANTS', 'MANAGE_COMPANY',
    ]);

    const rows = await getApplicantList(jobId, filters);

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
      analysisType:  row.analysisType || 'BACKEND', // BACKEND or GEMINI
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

    let analysis = await getLatestAnalysis(applicationId);
    if (!analysis || analysis.analysisType === 'BACKEND') {
      const snapRes = await pool.query(
        `SELECT candidate_snapshot, job_snapshot FROM application_snapshots WHERE application_id = $1`,
        [applicationId]
      );
      if (snapRes.rowCount > 0) {
        const { candidate_snapshot, job_snapshot } = snapRes.rows[0];

        // Resolve experience fields (with live job fallback if needed)
        let expMin   = job_snapshot.experienceMin   ?? null;
        let expMax   = job_snapshot.experienceMax   ?? null;
        let expLabel = job_snapshot.experienceLabel ?? null;

        if (expMin === null && expMax === null && !expLabel) {
          const jobIdRes = await pool.query(
            `SELECT j.experience_min, j.experience_max, j.experience_label
             FROM job_applications ja
             JOIN jobs j ON j.job_id = ja.job_id
             WHERE ja.application_id = $1`,
            [applicationId]
          );
          if (jobIdRes.rowCount > 0) {
            expMin   = jobIdRes.rows[0].experience_min   ?? null;
            expMax   = jobIdRes.rows[0].experience_max   ?? null;
            expLabel = jobIdRes.rows[0].experience_label ?? null;
          }
        }

        const totalYears = calculateTotalExperienceYears(candidate_snapshot.experience || []);
        const experienceJson = compareExperience(totalYears, expMin, expMax, expLabel);
        if (experienceJson.status === 'MATCHES') experienceJson.status = 'ALIGNED';

        const latestEdu = getLatestEducation(candidate_snapshot.education || []);
        const jobEduReq = job_snapshot.education || null;
        const qualStatus = latestEdu.degree && latestEdu.degree !== 'Not specified' ? 'ALIGNED' : 'BELOW';
        const qualificationJson = {
          status: jobEduReq ? qualStatus : 'ALIGNED',
          degree: latestEdu.degree || 'Not specified',
          class: latestEdu.class || '',
          summary: latestEdu.summary || 'Candidate education details provided.',
        };

        const fallback = generateLocalSystemFallback(candidate_snapshot, job_snapshot, experienceJson, qualificationJson);

        analysis = {
          analysisId: analysis?.analysisId || null,
          applicationId,
          matchScore: analysis?.matchScore || fallback.match_score,
          analysisType: 'BACKEND',
          summary: fallback.summary,
          skills: fallback.skills,
          experience: experienceJson,
          qualification: qualificationJson,
        };
      } else {
        // Safe fallback if snapshots table is somehow missing for this candidate
        analysis = {
          matchScore: analysis?.matchScore || null,
          summary: null,
          analysisType: 'BACKEND',
          skills: null,
          experience: null,
          qualification: null,
        };
      }
    }

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
      aiAnalysis:    analysis,
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
  const body = req.body.body || req.body.note;

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
    if (!analysis || analysis.analysisType === 'BACKEND') {
      const snapRes = await pool.query(
        `SELECT candidate_snapshot, job_snapshot FROM application_snapshots WHERE application_id = $1`,
        [applicationId]
      );
      if (snapRes.rowCount > 0) {
        const { candidate_snapshot, job_snapshot } = snapRes.rows[0];

        // Resolve experience fields (with live job fallback if needed)
        let expMin   = job_snapshot.experienceMin   ?? null;
        let expMax   = job_snapshot.experienceMax   ?? null;
        let expLabel = job_snapshot.experienceLabel ?? null;

        if (expMin === null && expMax === null && !expLabel) {
          const jobIdRes = await pool.query(
            `SELECT j.experience_min, j.experience_max, j.experience_label
             FROM job_applications ja
             JOIN jobs j ON j.job_id = ja.job_id
             WHERE ja.application_id = $1`,
            [applicationId]
          );
          if (jobIdRes.rowCount > 0) {
            expMin   = jobIdRes.rows[0].experience_min   ?? null;
            expMax   = jobIdRes.rows[0].experience_max   ?? null;
            expLabel = jobIdRes.rows[0].experience_label ?? null;
          }
        }

        const totalYears = calculateTotalExperienceYears(candidate_snapshot.experience || []);
        const experienceJson = compareExperience(totalYears, expMin, expMax, expLabel);
        if (experienceJson.status === 'MATCHES') experienceJson.status = 'ALIGNED';

        const latestEdu = getLatestEducation(candidate_snapshot.education || []);
        const jobEduReq = job_snapshot.education || null;
        const qualStatus = latestEdu.degree && latestEdu.degree !== 'Not specified' ? 'ALIGNED' : 'BELOW';
        const qualificationJson = {
          status: jobEduReq ? qualStatus : 'ALIGNED',
          degree: latestEdu.degree || 'Not specified',
          class: latestEdu.class || '',
          summary: latestEdu.summary || 'Candidate education details provided.',
        };

        const fallback = generateLocalSystemFallback(candidate_snapshot, job_snapshot, experienceJson, qualificationJson);

        analysis = {
          analysisId: analysis?.analysisId || null,
          applicationId,
          matchScore: analysis?.matchScore || fallback.match_score,
          analysisType: 'BACKEND',
          summary: fallback.summary,
          skills: fallback.skills,
          experience: experienceJson,
          qualification: qualificationJson,
        };
      } else {
        analysis = {
          analysisId: analysis?.analysisId || null,
          applicationId,
          matchScore: analysis?.matchScore || null,
          summary: null,
          analysisType: 'BACKEND',
          skills: null,
          experience: null,
          qualification: null,
        };
      }
    }

    res.json(analysis);

  } catch (err) {
    if (err.statusCode === 403) {
      return res.status(403).json({ message: err.message });
    }
    console.error('[getAnalysis]', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

exports.triggerAnalysis = async (req, res) => {
  const applicationId = req.params.id;

  try {
    const ownership = await getApplicationOwnership(applicationId);
    if (!ownership) {
      return res.status(404).json({ message: 'Application not found' });
    }

    await assertRecruiterAccess(req, ownership, [
      'VIEW_APPLICANTS', 'MANAGE_APPLICANTS', 'MANAGE_COMPANY',
    ]);

    // 1. Run the analysis synchronously
    await analyzeCandidate(applicationId);

    // 2. Mark any pending/processing/failed items in the queue as COMPLETED
    await pool.query(
      `UPDATE ai_analysis_queue 
       SET status = 'COMPLETED', error_message = NULL 
       WHERE application_id = $1`,
      [applicationId]
    );

    // 3. Get the latest analysis
    const analysis = await getLatestAnalysis(applicationId);

    res.json(analysis);

  } catch (err) {
    if (err.statusCode === 403) {
      return res.status(403).json({ message: err.message });
    }
    console.error('[triggerAnalysis]', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};
