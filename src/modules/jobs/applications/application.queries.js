// src/modules/jobs/applications/application.queries.js
'use strict';

const pool = require('../../../core/db/pool');

// ─── getJobOwnership ──────────────────────────────────────────────────────────
// Returns { org_id, recruiter_id } for a given job_id, or null if not found.
async function getJobOwnership(jobId) {
  const result = await pool.query(
    `SELECT org_id, recruiter_id FROM jobs WHERE job_id = $1`,
    [jobId]
  );
  return result.rows[0] || null;
}

// ─── getApplicationOwnership ──────────────────────────────────────────────────
// Returns the parent job's { org_id, recruiter_id } given an application_id.
async function getApplicationOwnership(applicationId) {
  const result = await pool.query(`
    SELECT j.org_id, j.recruiter_id
    FROM job_applications ja
    JOIN jobs j ON ja.job_id = j.job_id
    WHERE ja.application_id = $1
  `, [applicationId]);
  return result.rows[0] || null;
}

// ─── getApplicantList ─────────────────────────────────────────────────────────
// Lightweight list query — no skills/experience/education subqueries.
// matchScore joined from the latest AI analysis row (null = not yet analysed).
async function getApplicantList(jobId, statusFilter) {
  const params = [jobId];
  let statusClause = '';

  if (statusFilter && statusFilter !== 'All') {
    params.push(statusFilter);
    statusClause = `AND ja.current_status = $2`;
  } else {
    statusClause = `AND ja.current_status != 'Withdrawn'`;
  }

  const result = await pool.query(`
    SELECT
      ja.application_id            AS "applicationId",
      ja.applicant_id              AS "applicantId",
      ja.full_name                 AS "name",
      ja.email,
      u.avatar_url                 AS "avatarUrl",
      u.headline,
      u.location,
      ja.current_status            AS "status",
      ja.applied_at                AS "appliedAt",
      ja.screening_required        AS "screeningRequired",
      ja.screening_type            AS "screeningType",
      ja.screening_submitted_at    AS "screeningSubmittedAt",
      aaa.match_score              AS "matchScore"
    FROM job_applications ja
    LEFT JOIN active_users u ON ja.applicant_id = u.user_id
    LEFT JOIN LATERAL (
      SELECT match_score
      FROM application_ai_analyses
      WHERE application_id = ja.application_id
      ORDER BY created_at DESC
      LIMIT 1
    ) aaa ON TRUE
    WHERE ja.job_id = $1
    ${statusClause}
    ORDER BY ja.applied_at DESC
  `, params);

  return result.rows;
}

// ─── getApplicationDetail ─────────────────────────────────────────────────────
// Full profile for the right-hand detail panel.
// selfNote is scoped to the requesting recruiter (author_id = recruiterId).
async function getApplicationDetail(applicationId, recruiterId) {
  const result = await pool.query(`
    SELECT
      ja.application_id            AS "applicationId",
      ja.applicant_id              AS "applicantId",
      ja.full_name                 AS "name",
      ja.email,
      ja.phone,
      u.avatar_url                 AS "avatarUrl",
      u.headline,
      u.location,
      u.about_text                 AS "about",
      ja.cover_note                AS "coverNote",
      ja.resume_url                AS "resumeUrl",
      ja.current_status            AS "status",
      ja.applied_at                AS "appliedAt",
      ja.screening_required        AS "screeningRequired",
      ja.screening_type            AS "screeningType",
      ja.screening_question        AS "screeningQuestion",
      ja.screening_submitted_at    AS "screeningSubmittedAt",
      ja.screening_response_url    AS "screeningResponseUrl",
      COALESCE((
        SELECT json_agg(s.name ORDER BY s.name)
        FROM user_skills us
        JOIN skills s   ON us.skill_id   = s.skill_id
        JOIN profiles p ON us.profile_id = p.profile_id
        WHERE p.user_id = ja.applicant_id
      ), '[]') AS "skills",
      COALESCE((
        SELECT json_agg(json_build_object(
          'role',     e.title,
          'company',  e.company_name,
          'duration', TO_CHAR(e.start_date, 'YYYY') || ' - ' ||
                      COALESCE(TO_CHAR(e.end_date, 'YYYY'), 'Present')
        ) ORDER BY e.start_date DESC)
        FROM (
          SELECT e.title, e.company_name, e.start_date, e.end_date
          FROM experiences e
          JOIN profiles p ON e.profile_id = p.profile_id
          WHERE p.user_id = ja.applicant_id
          ORDER BY e.start_date DESC
          LIMIT 3
        ) e
      ), '[]') AS "experience",
      COALESCE((
        SELECT json_agg(json_build_object(
          'degree', ed.degree,
          'school', ed.school_name,
          'year',   TO_CHAR(ed.end_date, 'YYYY')
        ) ORDER BY ed.end_date DESC)
        FROM (
          SELECT ed.degree, ed.school_name, ed.end_date
          FROM educations ed
          JOIN profiles p ON ed.profile_id = p.profile_id
          WHERE p.user_id = ja.applicant_id
          ORDER BY ed.end_date DESC
          LIMIT 2
        ) ed
      ), '[]') AS "education",
      an.body AS "selfNote"
    FROM job_applications ja
    LEFT JOIN active_users u       ON ja.applicant_id   = u.user_id
    LEFT JOIN application_notes an ON an.application_id = ja.application_id
                                  AND an.author_id      = $2
    WHERE ja.application_id = $1
  `, [applicationId, recruiterId]);

  return result.rows[0] || null;
}

// ─── getLatestAnalysis ────────────────────────────────────────────────────────
// Returns the latest AI analysis row, or null if none exists.
async function getLatestAnalysis(applicationId) {
  const result = await pool.query(`
    SELECT
      analysis_id    AS "analysisId",
      application_id AS "applicationId",
      match_score    AS "matchScore",
      summary,
      skills,
      experience,
      qualification,
      provider,
      model,
      created_at     AS "createdAt"
    FROM application_ai_analyses
    WHERE application_id = $1
    ORDER BY created_at DESC
    LIMIT 1
  `, [applicationId]);

  return result.rows[0] || null;
}

// ─── upsertNote ───────────────────────────────────────────────────────────────
// Creates or updates the recruiter's self-note (one per recruiter per application).
async function upsertNote(applicationId, authorId, body) {
  const result = await pool.query(`
    INSERT INTO application_notes (application_id, author_id, body)
    VALUES ($1, $2, $3)
    ON CONFLICT (application_id, author_id)
    DO UPDATE SET body = EXCLUDED.body, updated_at = now()
    RETURNING
      note_id    AS "noteId",
      body,
      updated_at AS "updatedAt"
  `, [applicationId, authorId, body]);

  return result.rows[0];
}

module.exports = {
  getJobOwnership,
  getApplicationOwnership,
  getApplicantList,
  getApplicationDetail,
  getLatestAnalysis,
  upsertNote,
};
