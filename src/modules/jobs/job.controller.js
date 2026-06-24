const { sanitizeContent } = require("../../utils/contentSanitizer");
const pool = require("../../core/db/pool");
const { buildJobFilters } = require("../../core/utils/jobQueryBuilder");
const { logAudit } = require("../../core/infrastructure/audit.service");
const { checkOrgPermission } = require("../../core/utils/rbac");
const { notifyOrgFollowers } = require("../../services/notification.service");
const { hasActorPermission } = require("../../core/middlewares/actor-context.middleware");
const { logActivity } = require("../../core/services/activityLogger");
const { logActivity: logIntentActivity } = require("../../utils/activityLogger");
const crypto = require("crypto");
const redis = require("../../core/cache/redis");
const aiService = require("../../services/ai.service");
const { validateSchema, validateBusiness, validateContentSafety } = require("../../core/utils/aiValidation");


const getRequestedOrganizationActorId = (req, fallbackOrgId = null) => {
  const actorOrgId = req.actor?.type === "ORGANIZATION" ? req.actor.orgId : null;

  if (actorOrgId && fallbackOrgId && actorOrgId !== fallbackOrgId) {
    const err = new Error("Active organization actor does not match requested organization");
    err.statusCode = 403;
    throw err;
  }

  return actorOrgId;
};

const hasAnyActorPermission = (actorPermissions, permissions) => {
  if (!permissions) return true;
  const list = Array.isArray(permissions) ? permissions : [permissions];
  return list.some((permission) => hasActorPermission(actorPermissions || [], permission));
};

const assertOrgPermission = async (req, orgId, permissions, queryable = pool) => {
  if (!orgId) return;

  if (req.actor?.type === "ORGANIZATION") {
    if (req.actor.orgId !== orgId) {
      const err = new Error("Active organization actor does not match requested organization");
      err.statusCode = 403;
      throw err;
    }
    if (!hasAnyActorPermission(req.actor.permissions, permissions)) {
      const err = new Error("Not authorized for this organization");
      err.statusCode = 403;
      throw err;
    }
    return;
  }

  const ok = await checkOrgPermission(queryable, orgId, req.user.sub, permissions);
  if (!ok) {
    const err = new Error("Not authorized for this organization");
    err.statusCode = 403;
    throw err;
  }
};

exports.getAllJobs = async (req, res) => {
  const { limit = 10, cursor } = req.query;
  const userId = req.user?.sub;

  try {
    const { conditions, values, nextIndex } = buildJobFilters(req.query, userId ? 2 : 1);

    // Base params
    const params = userId ? [userId] : [];

    // Merge filter values
    params.push(...values);

    let paramCount = nextIndex;

    // Pagination (Cursor-based on created_at)
    if (cursor) {
      conditions.push(`j.created_at < $${paramCount}`);
      params.push(new Date(cursor));
      paramCount++;
    }

    const limitClause = `LIMIT $${paramCount}`;
    params.push(Number(limit));

    const whereClause = conditions.length > 0 ? `WHERE j.is_active = TRUE AND j.status = 'ACTIVE' AND ${conditions.join(" AND ")}` : `WHERE j.is_active = TRUE AND j.status = 'ACTIVE'`;

    const query = `
      SELECT 
        j.*,
        u.full_name AS recruiter_name,
        c.logo_url AS company_logo,
        c.slug AS company_slug,
        ${userId ? '(js.user_id IS NOT NULL) AS "isSaved",' : 'FALSE AS "isSaved",'}
        ${userId ? '(ja.application_id IS NOT NULL) AS "hasApplied",' : 'FALSE AS "hasApplied",'}
        ${userId ? 'ja.current_status AS "applicationStatus",' : 'NULL AS "applicationStatus",'}
        (SELECT COUNT(*)::int FROM job_applications ja_count WHERE ja_count.job_id = j.job_id) as applicants
      FROM jobs j
      LEFT JOIN active_users u ON j.recruiter_id = u.user_id
      LEFT JOIN organizations c ON j.org_id = c.org_id
      ${userId ? "LEFT JOIN job_saves js ON js.job_id = j.job_id AND js.user_id = $1" : ""}
      ${userId ? "LEFT JOIN job_applications ja ON ja.job_id = j.job_id AND ja.applicant_id = $1" : ""}
      ${whereClause}
      ORDER BY j.created_at DESC
      ${limitClause}
    `;

    const result = await pool.query(query, params);
    res.json(result.rows);

    // 📝 Log Activity: Search Jobs
    const searchText = req.query.q || req.query.title || req.query.search || req.query.keyword || "";

    if (userId && searchText) {
      logActivity(userId, 'search_job', 'job', null, { query: searchText });
    }



  } catch (err) {

    if (err.code === '23514' && err.constraint === 'salary_valid') {
      return res.status(400).json({
        field: "salary",
        message: "Minimum salary cannot be greater than maximum salary"
      });
    }
    console.error("Get jobs error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

exports.getJobById = async (req, res) => {
  const { id } = req.params;
  const userId = req.user?.sub; // optional

  try {
    const result = await pool.query(
      `
      SELECT 
        j.*,
        u.full_name AS recruiter_name,
        c.logo_url AS company_logo,
        c.slug AS company_slug,
        ${userId ? '(js.user_id IS NOT NULL) AS "isSaved",' : 'FALSE AS "isSaved",'}
        ${userId ? '(ja.application_id IS NOT NULL) AS "hasApplied",' : 'FALSE AS "hasApplied",'}
        ${userId ? '(jo.offer_id IS NOT NULL AND jo.status = \'pending\') AS "is_offer",' : 'FALSE AS "is_offer",'}
        ${userId ? 'jo.status AS "offerStatus",' : 'NULL AS "offerStatus",'}
        ${userId ? 'jo.offer_id AS "offer_id",' : 'NULL AS "offer_id",'}
        ${userId ? 'ja.application_id AS "applicationId",' : 'NULL AS "applicationId",'}
        ${userId ? 'ja.screening_required AS "screeningRequired",' : 'NULL AS "screeningRequired",'}
        ${userId ? 'ja.screening_type AS "screeningType",' : 'NULL AS "screeningType",'}
        ${userId ? 'ja.screening_question AS "screeningQuestion",' : 'NULL AS "screeningQuestion",'}
        ${userId ? 'ja.screening_submitted_at AS "screeningSubmittedAt",' : 'NULL AS "screeningSubmittedAt",'}
        (SELECT COUNT(*)::int FROM job_applications ja_count WHERE ja_count.job_id = j.job_id) as applicants
      FROM jobs j
      LEFT JOIN active_users u ON j.recruiter_id = u.user_id
      LEFT JOIN organizations c ON j.org_id = c.org_id
      ${userId ? 'LEFT JOIN job_saves js ON js.job_id = j.job_id AND js.user_id = $2' : ''}
      ${userId ? 'LEFT JOIN job_applications ja ON ja.job_id = j.job_id AND ja.applicant_id = $2' : ''}
      ${userId ? 'LEFT JOIN job_offers jo ON jo.job_id = j.job_id AND jo.user_id = $2 AND jo.status = \'pending\'' : ''}
      WHERE j.job_id = $1
      `,
      userId ? [id, userId] : [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Job not found" });
    }

    res.json(result.rows[0]);

    // 📝 Log Activity: View Job
    if (userId) {
      logActivity(userId, 'view_job', 'job', id);
      logIntentActivity({ userId, action: "view_job", metadata: { jobId: id } });
    }
  } catch (err) {

    console.error("Get job error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

exports.createJob = async (req, res) => {
  const userId = req.user.sub;
  let { title, org_id } = req.body;

  title = sanitizeContent(title);

  let requestedOrgId = null;
  let resolvedCompanyName = "";
  try {
    requestedOrgId = getRequestedOrganizationActorId(req, org_id || null);
    await assertOrgPermission(req, requestedOrgId, ["POST_JOBS", "MANAGE_COMPANY"]);

    if (requestedOrgId) {
      const orgRes = await pool.query('SELECT name FROM organizations WHERE org_id = $1', [requestedOrgId]);
      if (orgRes.rows.length) resolvedCompanyName = orgRes.rows[0].name;
    } else {
      const userRes = await pool.query('SELECT full_name FROM users WHERE user_id = $1', [userId]);
      if (userRes.rows.length) resolvedCompanyName = userRes.rows[0].full_name;
    }
  } catch (err) {
    return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
  }

  const postedAsCompany = !!requestedOrgId;

  // AI Generation Phase
  let aiDescription = "";
  try {
    const aiService = require("../../services/ai.service");
    const companyReplacement = postedAsCompany ? resolvedCompanyName : "our team";
    const jdJson = await aiService.generateJobDescription({ 
      role: title, 
      companyName: companyReplacement 
    });
    
    // Format JSON into markdown for the description field
    aiDescription = `
${jdJson.summary}

### Description
${jdJson.description}

### Responsibilities
${jdJson.responsibilities ? jdJson.responsibilities.map(r => "- " + r).join("\n") : ""}

### Requirements
${jdJson.requirements ? jdJson.requirements.map(r => "- " + r).join("\n") : ""}

### Preferred Skills
${jdJson.preferred_skills ? jdJson.preferred_skills.map(s => "- " + s).join("\n") : ""}

### Benefits
${jdJson.benefits ? jdJson.benefits.map(b => "- " + b).join("\n") : ""}
`.trim();
  } catch (e) {
    console.error("Auto AI Generation failed during createJob:", e.message);
    // If it fails, we just leave aiDescription blank and let the draft be created normally.
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const jobRes = await client.query(
      `
      INSERT INTO jobs
      (recruiter_id, title, company_name, org_id, posted_as_company, status, industry, description)
      VALUES ($1, $2, $3, $4, $5, 'DRAFT', '', $6)
      RETURNING *
      `,
      [userId, title, resolvedCompanyName, requestedOrgId || null, postedAsCompany, aiDescription]
    );

    const job = jobRes.rows[0];

    // Automatically add this new role to the master table for future autocomplete
    // We use ON CONFLICT DO NOTHING to silently ignore it if it already exists
    if (title) {
      await client.query(
        `INSERT INTO job_roles_master (role_name, category) 
         VALUES ($1, 'Custom') 
         ON CONFLICT (role_name) DO NOTHING`,
        [title]
      );
    }

    await client.query(
      `INSERT INTO job_activity (job_id, actor_id, action) VALUES ($1, $2, 'DRAFT_CREATED')`,
      [job.job_id, userId]
    );

    await client.query("COMMIT");

    res.status(201).json({
      message: "Draft created successfully",
      job
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ message: "Internal server error", error: err.message });

  } finally {
    client.release();
  }
};

exports.updateDraft = async (req, res) => {
  const { id } = req.params;
  const userId = req.user.sub;
  const updates = req.body;

  if (updates.title) updates.title = sanitizeContent(updates.title);
  if (updates.description) updates.description = sanitizeContent(updates.description);
  if (updates.industry) updates.industry = sanitizeContent(updates.industry);

  try {
    const jobRes = await pool.query(`SELECT org_id, recruiter_id, status FROM jobs WHERE job_id = $1`, [id]);
    if (jobRes.rowCount === 0) return res.status(404).json({ message: "Job not found" });
    const job = jobRes.rows[0];

    let requestedOrgId = null;
    if (job.org_id) {
       requestedOrgId = getRequestedOrganizationActorId(req, job.org_id);
       await assertOrgPermission(req, requestedOrgId, ["POST_JOBS", "MANAGE_COMPANY"]);
    } else {
       if (job.recruiter_id !== userId) return res.status(403).json({ message: "Unauthorized" });
    }

    if (job.status !== 'DRAFT' && job.status !== 'ACTIVE') {
      return res.status(400).json({ message: "Can only update jobs in DRAFT or ACTIVE state" });
    }

    const setClauses = [];
    const values = [];
    let paramCount = 1;

    for (const [key, value] of Object.entries(updates)) {
      setClauses.push(`${key} = $${paramCount}`);
      values.push(value);
      paramCount++;
    }

    if (setClauses.length === 0) return res.status(200).json({ message: "No updates provided", job });

    values.push(id);
    const query = `UPDATE jobs SET ${setClauses.join(", ")} WHERE job_id = $${paramCount} RETURNING *`;
    const updatedJobRes = await pool.query(query, values);

    if (updates.title) {
      await pool.query(
        `INSERT INTO job_roles_master (role_name, category) 
         VALUES ($1, 'Custom') 
         ON CONFLICT (role_name) DO NOTHING`,
        [updates.title]
      );
    }

    res.status(200).json({ message: "Job updated", job: updatedJobRes.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
  }
};

exports.submitJob = async (req, res) => {
  const { id } = req.params;
  const userId = req.user.sub;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    
    const jobRes = await client.query(`SELECT * FROM jobs WHERE job_id = $1`, [id]);
    if (jobRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Job not found" });
    }
    const job = jobRes.rows[0];

    if (job.org_id) {
       await assertOrgPermission(req, getRequestedOrganizationActorId(req, job.org_id), ["POST_JOBS", "MANAGE_COMPANY"]);
    } else {
       if (job.recruiter_id !== userId) {
          await client.query("ROLLBACK");
          return res.status(403).json({ message: "Unauthorized" });
       }
    }

    if (job.status !== 'DRAFT') {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Only DRAFT jobs can be submitted" });
    }

    const updated = await client.query(
      `UPDATE jobs SET status = 'ACTIVE' WHERE job_id = $1 RETURNING *`,
      [id]
    );

    await client.query(
      `INSERT INTO job_versions (job_id, changed_by, trigger_event, previous_data) VALUES ($1, $2, 'SUBMIT', $3)`,
      [id, userId, job]
    );

    await client.query(
      `INSERT INTO job_activity (job_id, actor_id, action) VALUES ($1, $2, 'SUBMITTED')`,
      [id, userId]
    );

    await client.query("COMMIT");
    res.status(200).json({ message: "Job submitted for review", job: updated.rows[0] });
  } catch(err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
  } finally {
    client.release();
  }
};

exports.cloneJob = async (req, res) => {
  const { id } = req.params;
  const userId = req.user.sub;
  
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    
    const jobRes = await client.query(`SELECT * FROM jobs WHERE job_id = $1`, [id]);
    if (jobRes.rowCount === 0) throw new Error("Job not found");
    const job = jobRes.rows[0];
    
    if (job.org_id) {
       await assertOrgPermission(req, getRequestedOrganizationActorId(req, job.org_id), ["POST_JOBS", "MANAGE_COMPANY"]);
    } else {
       if (job.recruiter_id !== userId) throw new Error("Unauthorized");
    }
    
    const insertRes = await client.query(
      `INSERT INTO jobs 
       (recruiter_id, title, company_name, org_id, location, description, salary_min, salary_max, 
        job_type, work_mode, company_type, experience_min, experience_max, experience_label, experience_level,
        about_company, industry, easy_apply, actively_hiring, posted_as_company, status)
       VALUES
       ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, 'DRAFT')
       RETURNING *`,
      [userId, `Copy of ${job.title}`, job.company_name, job.org_id, job.location, job.description, job.salary_min, job.salary_max,
       job.job_type, job.work_mode, job.company_type, job.experience_min, job.experience_max, job.experience_label, job.experience_level,
       job.about_company, job.industry, job.easy_apply, job.actively_hiring, job.posted_as_company]
    );
    
    const newJob = insertRes.rows[0];
    
    await client.query(
      `INSERT INTO job_activity (job_id, actor_id, action) VALUES ($1, $2, 'DRAFT_CREATED')`,
      [newJob.job_id, userId]
    );

    await client.query("COMMIT");
    res.status(201).json({ message: "Job cloned successfully", job: newJob });
  } catch(err) {
    await client.query("ROLLBACK");
    res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
  } finally {
    client.release();
  }
};

const performLifecycleAction = async (req, res, actionName, targetStatus, allowedFromStatuses) => {
  const { id } = req.params;
  const userId = req.user.sub;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    
    const jobRes = await client.query(`SELECT * FROM jobs WHERE job_id = $1`, [id]);
    if (jobRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Job not found" });
    }
    const job = jobRes.rows[0];

    // Ownership check (Skip for admin actions approve/reject, handled by open access or separate check if needed. 
    // Here we just allow if they own it, but anyone can post jobs, so we check if they are the recruiter or manage the company)
    if (actionName !== 'APPROVE' && actionName !== 'REJECT') {
      if (job.org_id) {
         await assertOrgPermission(req, getRequestedOrganizationActorId(req, job.org_id), ["POST_JOBS", "MANAGE_COMPANY"]);
      } else {
         if (job.recruiter_id !== userId) {
            await client.query("ROLLBACK");
            return res.status(403).json({ message: "Unauthorized" });
         }
      }
    }

    if (allowedFromStatuses && !allowedFromStatuses.includes(job.status)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: `Cannot ${actionName} job from status: ${job.status}` });
    }

    const updated = await client.query(
      `UPDATE jobs SET status = $1 WHERE job_id = $2 RETURNING *`,
      [targetStatus, id]
    );

    await client.query(
      `INSERT INTO job_activity (job_id, actor_id, action) VALUES ($1, $2, $3)`,
      [id, userId, actionName]
    );

    await client.query("COMMIT");
    res.status(200).json({ message: `Job ${actionName.toLowerCase()} successfully`, job: updated.rows[0] });
  } catch(err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
  } finally {
    client.release();
  }
};

exports.pauseJob = (req, res) => performLifecycleAction(req, res, 'PAUSE', 'PAUSED', ['ACTIVE']);
exports.closeJob = (req, res) => performLifecycleAction(req, res, 'CLOSE', 'CLOSED', ['ACTIVE', 'PAUSED']);
exports.archiveJob = (req, res) => performLifecycleAction(req, res, 'ARCHIVE', 'ARCHIVED', null);
exports.approveJob = (req, res) => performLifecycleAction(req, res, 'APPROVE', 'ACTIVE', ['UNDER_REVIEW']);
exports.rejectJob = (req, res) => performLifecycleAction(req, res, 'REJECT', 'REJECTED', ['UNDER_REVIEW']);

exports.aiAction = async (req, res) => {
  const { id } = req.params;
  const userId = req.user.sub;
  const { action, updates } = req.body;

  if (!action || !updates) {
    return res.status(400).json({ message: "action and updates are required" });
  }

  if (updates.title) updates.title = sanitizeContent(updates.title);
  if (updates.description) updates.description = sanitizeContent(updates.description);
  if (updates.industry) updates.industry = sanitizeContent(updates.industry);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const jobRes = await client.query(`SELECT * FROM jobs WHERE job_id = $1`, [id]);
    if (jobRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Job not found" });
    }
    const job = jobRes.rows[0];

    if (job.org_id) {
       await assertOrgPermission(req, getRequestedOrganizationActorId(req, job.org_id), ["POST_JOBS", "MANAGE_COMPANY"]);
    } else {
       if (job.recruiter_id !== userId) {
          await client.query("ROLLBACK");
          return res.status(403).json({ message: "Unauthorized" });
       }
    }

    if (job.status !== 'DRAFT' && job.status !== 'ACTIVE') {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "AI actions can only be performed on DRAFT or ACTIVE jobs" });
    }

    const setClauses = [];
    const values = [];
    let paramCount = 1;

    for (const [key, value] of Object.entries(updates)) {
      setClauses.push(`${key} = $${paramCount}`);
      values.push(value);
      paramCount++;
    }

    if (setClauses.length === 0) {
      await client.query("ROLLBACK");
      return res.status(200).json({ message: "No updates provided" });
    }

    values.push(id);
    const query = `UPDATE jobs SET ${setClauses.join(", ")} WHERE job_id = $${paramCount} RETURNING *`;
    const updatedJobRes = await client.query(query, values);

    await client.query(
      `INSERT INTO job_versions (job_id, changed_by, trigger_event, provenance, previous_data) VALUES ($1, $2, $3, 'AI', $4)`,
      [id, userId, action, job]
    );

    await client.query(
      `INSERT INTO job_activity (job_id, actor_id, action) VALUES ($1, $2, $3)`,
      [id, userId, 'AI_ACTION_' + action.toUpperCase()]
    );

    await client.query("COMMIT");
    res.status(200).json({ message: "AI action applied successfully", job: updatedJobRes.rows[0] });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
  } finally {
    client.release();
  }
};

exports.applyJob = async (req, res) => {
  const { id } = req.params; // job_id
  const userId = req.user.sub;
  if (req.actor?.type === "ORGANIZATION") {
    return res.status(403).json({ message: "You cannot apply as an organization" });
  }

  // Take other fields from request body
  let { full_name, email, phone, mobile_number, cover_note } = req.body;
  
  // Sanitize user-generated content
  cover_note = sanitizeContent(cover_note);
  const contactPhone = phone || mobile_number;

  try {
    // If name or email missing, fetch from user profile for robustness
    if (!full_name || !email) {
      const userResult = await pool.query(
        `SELECT full_name, email FROM users WHERE user_id = $1`,
        [userId]
      );
      if (userResult.rowCount > 0) {
        full_name = full_name || userResult.rows[0].full_name;
        email = email || userResult.rows[0].email;
      }
    }

    if (!full_name || !email) {
      return res.status(400).json({ message: "Name and Email are required for application" });
    }
    // Check if job exists
    const jobCheck = await pool.query(`SELECT org_id, recruiter_id FROM jobs WHERE job_id = $1`, [id]);
    if (jobCheck.rowCount === 0) {
      return res.status(404).json({ message: "Job not found" });
    }

    const { org_id, recruiter_id } = jobCheck.rows[0];

    // Check if user is the recruiter
    if (recruiter_id === userId) {
      return res.status(403).json({ message: "You cannot apply to your own job" });
    }

    // Check if user has permission to post jobs for this organization
    if (org_id) {
      const canPostJobs = await checkOrgPermission(pool, org_id, userId, ['POST_JOBS', 'MANAGE_COMPANY']);
      if (canPostJobs) {
        return res.status(403).json({ message: "You cannot apply to a job posted by your organization" });
      }
    }

    // Check if already applied
    const existing = await pool.query(
      `SELECT 1 FROM job_applications WHERE job_id = $1 AND applicant_id = $2`,
      [id, userId]
    );
    if (existing.rowCount > 0) {
      return res.status(409).json({ message: "Already applied to this job" });
    }
    // Resume file URL from Cloudinary or existing profile resume
    let resume_url = null;

    // Handle Multer .fields() output
    if (req.files) {
      if (req.files['resume'] && req.files['resume'][0]) {
        resume_url = req.files['resume'][0].path;
      }
    }
    // Fallback for single file upload if still supported (legacy)
    else if (req.file) {
      resume_url = req.file.path;
    }

    // Fallback to body URL if not uploaded
    if (!resume_url && req.body.resume_url) {
      resume_url = req.body.resume_url;
    }

    if (!resume_url) {
      return res.status(400).json({ message: "Resume is required" });
    }

    // Create application
    const appResult = await pool.query(
      `INSERT INTO job_applications 
       (job_id, applicant_id, full_name, email, phone, resume_url, cover_note)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING application_id`,
      [id, userId, full_name, email, contactPhone, resume_url, cover_note]
    );

    const appId = appResult.rows[0].application_id;

    // Log status history
    await pool.query(
      `INSERT INTO application_status_history (application_id, status) VALUES ($1, 'Applied')`,
      [appId]
    );

    res.status(201).json({ message: "Application submitted successfully", applicationId: appId });

    // 🎯 Intent Layer: Log Apply Job
    logIntentActivity({ userId, action: "apply_job", metadata: { jobId: id, applicationId: appId } });
  } catch (err) {
    console.error("Apply job error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

exports.getJobOffers = async (req, res) => {
  const { limit = 10, cursor } = req.query;
  const userId = req.user?.sub; // optional, if user is logged in

  try {
    // Use the builder
    const { conditions, values, nextIndex } = buildJobFilters(req.query, userId ? 2 : 1);

    // Offers specific condition
    conditions.push('j.is_offer = TRUE');

    const params = userId ? [userId] : [];
    params.push(...values);
    let paramCount = nextIndex;

    // Pagination (Cursor-based on created_at)
    if (cursor) {
      conditions.push(`j.created_at < $${paramCount}`);
      params.push(new Date(cursor));
      paramCount++;
    }

    const limitClause = `LIMIT $${paramCount}`;
    params.push(Number(limit));

    const whereClause = conditions.length > 0 ? `WHERE j.is_active = TRUE AND j.status = 'ACTIVE' AND ${conditions.join(" AND ")}` : `WHERE j.is_active = TRUE AND j.status = 'ACTIVE'`;

    const query = `
      SELECT 
        j.*,
        u.full_name AS recruiter_name,
        ${userId ? '(js.user_id IS NOT NULL) AS "isSaved",' : 'FALSE AS "isSaved",'}
        ${userId ? '(ja.application_id IS NOT NULL) AS "hasApplied",' : 'FALSE AS "hasApplied",'}
        ${userId ? 'ja.current_status AS "applicationStatus",' : 'NULL AS "applicationStatus",'}
        (SELECT COUNT(*)::int FROM job_applications ja_count WHERE ja_count.job_id = j.job_id) as applicants
      FROM jobs j
      LEFT JOIN active_users u ON j.recruiter_id = u.user_id
      ${userId ? "LEFT JOIN job_saves js ON js.job_id = j.job_id AND js.user_id = $1" : ""}
      ${userId ? "LEFT JOIN job_applications ja ON ja.job_id = j.job_id AND ja.applicant_id = $1" : ""}
      ${whereClause}
      ORDER BY j.created_at DESC
      ${limitClause}
    `;

    const result = await pool.query(query, params);
    res.status(200).json(result.rows);
  } catch (err) {
    if (err.code === '23514' && err.constraint === 'salary_valid') {
      return res.status(400).json({
        field: "salary",
        message: "Minimum salary cannot be greater than maximum salary"
      });
    }
    console.error("Get job offers error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

exports.saveJob = async (req, res) => {
  const userId = req.user.sub;
  const jobId = req.params.id;

  try {
    const result = await pool.query(
      `
      INSERT INTO job_saves (user_id, job_id)
      SELECT $1, $2
      WHERE EXISTS (
        SELECT 1 FROM jobs 
        WHERE job_id = $2 AND is_active = TRUE
      )
      ON CONFLICT DO NOTHING
      `,
      [userId, jobId]
    );

    if (result.rowCount === 0) {
      return res.status(200).json({ message: "Job already saved or inactive" });
    }

    res.status(201).json({ message: "Job saved successfully" });

    // 🎯 Intent Layer: Log Save Job
    logIntentActivity({ userId, action: "save_job", metadata: { jobId } });
  } catch (err) {
    console.error("Save job error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

exports.unsaveJob = async (req, res) => {
  const userId = req.user.sub;
  const jobId = req.params.id;

  try {
    const result = await pool.query(
      `
      DELETE FROM job_saves
      WHERE user_id = $1 AND job_id = $2
      `,
      [userId, jobId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Job not found in saved list" });
    }

    res.json({ message: "Job removed from saved list" });
  } catch (err) {
    console.error("Unsave job error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

exports.getMySavedJobs = async (req, res) => {
  const userId = req.user.sub;
  const { limit = 10, cursor } = req.query;

  try {
    const { conditions, values, nextIndex } = buildJobFilters(req.query, 2);

    let query = `
      SELECT 
        j.*, 
        u.full_name AS recruiter_name, 
        TRUE AS "isSaved",
        (ja.application_id IS NOT NULL) AS "hasApplied",
        ja.current_status AS "applicationStatus",
        (SELECT COUNT(*)::int FROM job_applications ja_count WHERE ja_count.job_id = j.job_id) as applicants,
        js.saved_at
      FROM job_saves js
      JOIN jobs j ON js.job_id = j.job_id
      LEFT JOIN active_users u ON j.recruiter_id = u.user_id
      LEFT JOIN job_applications ja ON ja.job_id = j.job_id AND ja.applicant_id = $1
      WHERE js.user_id = $1 AND j.is_active = TRUE
      `;

    if (conditions.length > 0) {
      query += ` AND ${conditions.join(" AND ")}`;
    }

    const params = [userId, ...values];
    let paramCount = nextIndex;

    // Pagination (Cursor-based on saved_at)
    if (cursor) {
      query += ` AND js.saved_at < $${paramCount}`;
      params.push(new Date(cursor));
      paramCount++;
    }

    const limitClause = `LIMIT $${paramCount}`;
    params.push(Number(limit));

    query += ` ORDER BY js.saved_at DESC ${limitClause}`;

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    if (err.code === '23514' && err.constraint === 'salary_valid') {
      return res.status(400).json({
        field: "salary",
        message: "Minimum salary cannot be greater than maximum salary"
      });
    }
    console.error("Get saved jobs error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

exports.getMyApplications = async (req, res) => {
  const userId = req.user.sub;
  const { limit = 10, cursor, status } = req.query;

  const allowedStatus = ['applied', 'in progress', 'in past', 'saved', 'in-progress', 'in-past'];

  if (status && !allowedStatus.includes(status.toLowerCase())) {
    return res.status(400).json({ message: "Invalid status" });
  }

  if (status?.toLowerCase() === 'saved') {
    return exports.getMySavedJobs(req, res);
  }

  try {
    const { status: applicationStatus, ...filterParams } = req.query;
    const { conditions, values, nextIndex } = buildJobFilters(filterParams, 2);

    // Base params: userId is $1
    const params = [userId, ...values];
    let paramCount = nextIndex;

    let baseQuery = `
        FROM job_applications ja
        JOIN jobs j ON ja.job_id = j.job_id
        LEFT JOIN active_users u ON j.recruiter_id = u.user_id
        LEFT JOIN job_saves js ON j.job_id = js.job_id AND js.user_id = $1
        WHERE ja.applicant_id = $1
    `;

    // Add built filters
    if (conditions.length > 0) {
      baseQuery += ` AND ${conditions.join(" AND ")}`;
    }

    // Status Filters
    if (status) {
      const s = status.toLowerCase();
      if (s === 'applied' || s === 'in past' || s === 'in-past') {
        // Now 'Applied' shows everything that was previously split between Applied and In Past.
        // We only exclude 'Offer' related statuses if they are handled in the 'Offers' tab.
        baseQuery += ` AND (ja.current_status NOT ILIKE 'Offer%' OR ja.current_status IS NULL)`;
      }
    }

    // Pagination (Cursor-based on applied_at)
    let paginationClause = "";
    if (cursor) {
      paginationClause = `AND ja.applied_at < $${paramCount}`;
      params.push(new Date(cursor));
      paramCount++;
    }

    const limitClause = `LIMIT $${paramCount}`;
    params.push(Number(limit));

    const query = `
        SELECT 
          j.*, 
          u.full_name AS recruiter_name,
          (js.user_id IS NOT NULL) AS "isSaved",
          TRUE AS "hasApplied",
          ja.current_status AS "applicationStatus",
          ja.application_id AS "applicationId",
          ja.screening_required AS "screeningRequired",
          ja.screening_type AS "screeningType",
          ja.screening_question AS "screeningQuestion",
          ja.screening_submitted_at AS "screeningSubmittedAt",
          (SELECT COUNT(*)::int FROM job_applications ja_count WHERE ja_count.job_id = j.job_id) as applicants,
          ja.applied_at
        ${baseQuery}
        ${paginationClause}
        ORDER BY ja.applied_at DESC
        ${limitClause}
    `;

    const result = await pool.query(query, params);

    res.json(result.rows);
  } catch (err) {
    if (err.code === '23514' && err.constraint === 'salary_valid') {
      return res.status(400).json({
        field: "salary",
        message: "Minimum salary cannot be greater than maximum salary"
      });
    }
    console.error("Get my applications error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

exports.getMyJobs = async (req, res) => {
  const recruiterId = req.user.sub; // logged-in recruiter
  const actorOrgId = req.actor?.type === "ORGANIZATION" ? req.actor.orgId : null;
  const {
    title,
    location,
    work_mode,
    company_type,
    easyApply,
    activelyHiring,
    experienceLevel,
    minSalary,
    maxSalary,
    datePosted,
    jobType,
    industry,
  } = req.query;

  try {
    let query = `
      SELECT 
        j.*, 
        u.full_name AS recruiter_name,
        (SELECT COUNT(*)::int FROM job_applications ja_count WHERE ja_count.job_id = j.job_id) as applicants_count
      FROM jobs j
      LEFT JOIN active_users u ON j.recruiter_id = u.user_id
      WHERE j.recruiter_id = $1 
        AND (j.posted_as_company IS FALSE OR j.posted_as_company IS NULL OR j.org_id IS NULL)
        AND j.is_active = TRUE 
    `;
    const params = [recruiterId];
    let paramCount = 2;

    // Optional filters
    if (title) {
      query += ` AND j.title ILIKE $${paramCount}`;
      params.push(`%${title}%`);
      paramCount++;
    }
    if (location) {
      query += ` AND j.location ILIKE $${paramCount}`;
      params.push(`%${location}%`);
      paramCount++;
    }
    if (work_mode) {
      query += ` AND j.work_mode = $${paramCount}`;
      params.push(work_mode);
      paramCount++;
    }
    if (company_type) {
      query += ` AND j.company_type = $${paramCount}`;
      params.push(company_type);
      paramCount++;
    }
    if (easyApply === "true") {
      query += ` AND j.easy_apply = TRUE`;
    }
    if (activelyHiring === "true") {
      query += ` AND j.actively_hiring = TRUE`;
    }
    if (experienceLevel) {
      query += ` AND j.experience_level = $${paramCount}`;
      params.push(experienceLevel);
      paramCount++;
    }
    const min = Number(minSalary);
    const max = Number(maxSalary);

    if (!isNaN(min) && !isNaN(max)) {
      if (min > max) {
        return res.status(400).json({
          field: "salary",
          message: "Minimum salary cannot be greater than maximum salary"
        });
      }

      query += `
    AND j.salary_max >= $${paramCount}
    AND j.salary_min <= $${paramCount + 1}
  `;
      params.push(min, max);
      paramCount += 2;

    } else if (!isNaN(min)) {
      query += ` AND j.salary_max >= $${paramCount}`;
      params.push(min);
      paramCount++;

    } else if (!isNaN(max)) {
      query += ` AND j.salary_min <= $${paramCount}`;
      params.push(max);
      paramCount++;
    }


    if (datePosted) {
      let fromDate;
      if (datePosted === "Past 24 hours") {
        fromDate = new Date(new Date().setDate(new Date().getDate() - 1));
      } else if (datePosted === "Past week") {
        fromDate = new Date(new Date().setDate(new Date().getDate() - 7));
      } else if (datePosted === "Past month") {
        fromDate = new Date(new Date().setMonth(new Date().getMonth() - 1));
      }
      if (fromDate) {
        query += ` AND j.created_at >= $${paramCount}`;
        params.push(fromDate);
        paramCount++;
      }
    }
    if (jobType) {
      query += ` AND j.job_type = $${paramCount}`;
      params.push(jobType);
      paramCount++;
    }
    if (industry) {
      query += ` AND j.industry = $${paramCount}`;
      params.push(industry);
      paramCount++;
    }

    query += ` ORDER BY j.created_at DESC`;

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    if (err.code === '23514' && err.constraint === 'salary_valid') {
      return res.status(400).json({
        field: "salary",
        message: "Minimum salary cannot be greater than maximum salary"
      });
    }
    console.error("Get my jobs error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

exports.getDashboardStats = async (req, res) => {
  const userId = req.user.sub;
  const actorOrgId = req.actor?.type === "ORGANIZATION" ? req.actor.orgId : null;

  try {
    const stats = await pool.query(`
      SELECT
        COUNT(j.job_id) FILTER (WHERE j.is_active = TRUE ${actorOrgId ? "AND j.posted_as_company IS TRUE" : "AND (j.posted_as_company IS FALSE OR j.posted_as_company IS NULL)"}) as "activeJobs",
        COUNT(j.job_id) FILTER (WHERE ${actorOrgId ? "j.posted_as_company IS TRUE" : "(j.posted_as_company IS FALSE OR j.posted_as_company IS NULL)"}) as "totalJobs",
        (
           SELECT COUNT(*) 
           FROM job_applications ja 
           JOIN jobs j2 ON ja.job_id = j2.job_id 
           WHERE ${actorOrgId ? "j2.org_id = $1" : "j2.recruiter_id = $1"}
        ) as "totalApplicants"
      FROM jobs j
      WHERE ${actorOrgId ? "j.org_id = $1" : "j.recruiter_id = $1"}
        AND ${actorOrgId ? "j.posted_as_company IS TRUE" : "(j.posted_as_company IS FALSE OR j.posted_as_company IS NULL)"}
    `, [actorOrgId || userId]);

    const data = stats.rows[0];

    res.json({
      totalJobs: parseInt(data.totalJobs || 0),
      activeJobs: parseInt(data.activeJobs || 0),
      totalApplicants: parseInt(data.totalApplicants || 0)
    });

  } catch (err) {
    console.error("Dashboard stats error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

exports.getJobApplicants = async (req, res) => {
  const { id } = req.params; // job_id
  const userId = req.user.sub;

  try {
    // 1. Verify ownership
    const jobCheck = await pool.query(
      `SELECT org_id, recruiter_id FROM jobs WHERE job_id = $1`,
      [id]
    );

    if (jobCheck.rowCount === 0) {
      return res.status(404).json({ message: "Job not found" });
    }

    const { org_id, recruiter_id } = jobCheck.rows[0];
    let isAuthorized = recruiter_id === userId;
    if (!isAuthorized && org_id) {
      try {
        await assertOrgPermission(req, org_id, ['VIEW_APPLICANTS', 'MANAGE_APPLICANTS', 'MANAGE_COMPANY']);
        isAuthorized = true;
      } catch (err) {
        return res.status(err.statusCode || 403).json({ message: err.message || "Not authorized to view applicants for this job" });
      }
    }
    if (!isAuthorized) {
      return res.status(403).json({ message: "Not authorized to view applicants for this job" });
    }

    // 2. Fetch applicants with profile details
    const result = await pool.query(`
      SELECT 
        ja.application_id,
        ja.applicant_id,
        ja.full_name as name,
        ja.email,
        ja.phone,
        ja.resume_url, 

        ja.current_status as status,
        ja.applied_at as "appliedAt",
        u.avatar_url,
        u.headline,
        u.location,
        u.about_text as about,
        ja.screening_required as "screeningRequired",
        ja.screening_type as "screeningType",
        ja.screening_question as "screeningQuestion",
        ja.screening_submitted_at as "screeningSubmittedAt",
        ja.screening_response_url as "screeningResponseUrl",
        -- Aggregate skills
        COALESCE((
          SELECT array_agg(s.name)
          FROM user_skills us
          JOIN skills s ON us.skill_id = s.skill_id
          JOIN profiles p ON us.profile_id = p.profile_id
          WHERE p.user_id = ja.applicant_id
        ), '{}') as skills,
        -- Get latest experience (simplified for list view)
        (
            SELECT json_agg(json_build_object(
                'role', e.title,
                'company', e.company_name,
                'duration', TO_CHAR(e.start_date, 'YYYY') || ' - ' || COALESCE(TO_CHAR(e.end_date, 'YYYY'), 'Present')
            ))
            FROM experiences e
            JOIN profiles p ON e.profile_id = p.profile_id
            WHERE p.user_id = ja.applicant_id
            LIMIT 2
        ) as experience,
         -- Get latest education
        (
            SELECT json_agg(json_build_object(
                'degree', ed.degree,
                'school', ed.school_name,
                'year', TO_CHAR(ed.end_date, 'YYYY')
            ))
            FROM educations ed
            JOIN profiles p ON ed.profile_id = p.profile_id
            WHERE p.user_id = ja.applicant_id
            LIMIT 1
        ) as education

      FROM job_applications ja
      LEFT JOIN active_users u ON ja.applicant_id = u.user_id
      WHERE ja.job_id = $1
      ORDER BY ja.applied_at DESC
    `, [id]);

    const applicants = result.rows.map(row => ({
      id: row.applicant_id, // or application_id depending on frontend need
      applicationId: row.application_id,
      name: row.name,
      headline: row.headline || "No headline",
      location: row.location || "Unknown",
      email: row.email,
      phone: row.phone,
      about: row.about,
      skills: row.skills || [],
      experience: row.experience || [],
      education: row.education || [],
      resumeUrl: row.resume_url,
      resumeName: row.resume_url ? row.resume_url.split('/').pop() : "Resume.pdf",

      screening: row.screeningRequired ? {
        required: true,
        type: row.screeningType,
        question: row.screeningQuestion,
        submittedAt: row.screeningSubmittedAt,
        responseUrl: row.screeningResponseUrl
      } : null,
      status: row.status,
      initials: row.name ? row.name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase() : "??",
      color: "bg-blue-500", // random color logic could be here
      appliedAt: row.appliedAt
    }));

    res.json(applicants);

  } catch (err) {
    console.error("Get job applicants error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

exports.deleteJob = async (req, res) => {
  const { id } = req.params;
  const userId = req.user.sub;

  try {
    // Check ownership and existence
    const jobCheck = await pool.query(
      `SELECT org_id, recruiter_id FROM jobs WHERE job_id = $1`,
      [id]
    );

    if (jobCheck.rowCount === 0) {
      return res.status(404).json({ message: "Job not found" });
    }

    const { org_id, recruiter_id } = jobCheck.rows[0];
    let isAuthorized = recruiter_id === userId;
    if (!isAuthorized && org_id) {
      try {
        await assertOrgPermission(req, org_id, ['POST_JOBS', 'MANAGE_COMPANY']);
        isAuthorized = true;
      } catch (err) {
        return res.status(err.statusCode || 403).json({ message: err.message || "Not authorized to delete this job" });
      }
    }
    if (!isAuthorized) {
      return res.status(403).json({ message: "Not authorized to delete this job" });
    }

    // Soft delete by setting is_active = FALSE and status = 'CLOSED' for consistency
    const result = await pool.query(
      `UPDATE jobs SET is_active = FALSE, status = 'CLOSED' WHERE job_id = $1`,
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Job not found or already deleted" });
    }

    res.json({ message: "Job deleted successfully" });
  } catch (err) {
    console.error("Delete job error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};


exports.updateJob = async (req, res) => {
  const { id } = req.params;
  const userId = req.user.sub;

  let {
    title,
    location,
    description,
    minSalary,
    maxSalary,
    job_type,
    work_mode,
    // company_type removed
    experience_level,
    industry,
    easy_apply,
    actively_hiring,
    org_id,
    skills = []
  } = req.body;

  // Sanitize user-generated content
  title = sanitizeContent(title);
  description = sanitizeContent(description);
  industry = sanitizeContent(industry);

  // Sanitize integer fields - default to 0 if empty because DB has NOT NULL constraint
  const safeMinSalary = (minSalary === "" || minSalary === null || minSalary === undefined) ? 0 : parseInt(minSalary);
  const safeMaxSalary = (maxSalary === "" || maxSalary === null || maxSalary === undefined) ? 0 : parseInt(maxSalary);

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // 1. Check ownership
    const checkRes = await client.query(
      `SELECT org_id, recruiter_id FROM jobs WHERE job_id = $1`,
      [id]
    );

    if (checkRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Job not found" });
    }

    const { org_id, recruiter_id } = checkRes.rows[0];
    let isAuthorized = recruiter_id === userId;
    if (!isAuthorized && org_id) {
      try {
        await assertOrgPermission(req, org_id, ['POST_JOBS', 'MANAGE_COMPANY'], client);
        isAuthorized = true;
      } catch (err) {
        await client.query("ROLLBACK");
        return res.status(err.statusCode || 403).json({ message: err.message || "Not authorized to update this job" });
      }
    }
    if (!isAuthorized) {
      await client.query("ROLLBACK");
      return res.status(403).json({ message: "Not authorized to update this job" });
    }

    let resolvedCompanyName = oldJobData.company_name;
    if (org_id) {
      const orgRes = await client.query('SELECT name FROM organizations WHERE org_id = $1', [org_id]);
      if (orgRes.rows.length) resolvedCompanyName = orgRes.rows[0].name;
    } else if (recruiter_id) {
      const userRes = await client.query('SELECT full_name FROM users WHERE user_id = $1', [recruiter_id]);
      if (userRes.rows.length) resolvedCompanyName = userRes.rows[0].full_name;
    }

    // 2. Update job details
    const updateRes = await client.query(
      `
      UPDATE jobs
      SET 
        title = $1, company_name = $2, location = $3,
        description = $4, salary_min = $5, salary_max = $6,
        job_type = $7, work_mode = $8, company_type = $9,
        experience_level = $10, about_company = null, industry = $12,
        easy_apply = $13, actively_hiring = $14, org_id = $15,
        posted_as_company = $16
      WHERE job_id = $17
      RETURNING *
      `,
      [
        title, resolvedCompanyName, location,
        description, safeMinSalary, safeMaxSalary,
        job_type, work_mode, null,
        experience_level, null, industry,
        easy_apply, actively_hiring, org_id || null,
        !!org_id, id
      ]
    );

    const job = updateRes.rows[0];

    // 3. Update skills (delete all and re-insert for simplicity)
    await client.query(`DELETE FROM job_skills WHERE job_id = $1`, [id]);

    for (let skill of skills) {
      const skillRes = await client.query(
        `
        WITH s AS (
            SELECT skill_id FROM skills WHERE lower(name) = lower($1)
        ),
        i AS (
            INSERT INTO skills (name)
            SELECT $1
            WHERE NOT EXISTS (SELECT 1 FROM s)
            RETURNING skill_id
        )
        SELECT skill_id FROM s
        UNION ALL
        SELECT skill_id FROM i
        `,
        [skill]
      );
      const skillId = skillRes.rows[0].skill_id;

      await client.query(
        `
        INSERT INTO job_skills(job_id, skill_id)
        VALUES ($1, $2)
        ON CONFLICT DO NOTHING
        `,
        [id, skillId]
      );
    }

    await client.query("COMMIT");

    if (title) {
      // Automatically add this new role to the master table if they update the title
      await client.query(
        `INSERT INTO job_roles_master (role_name, category) 
         VALUES ($1, 'Custom') 
         ON CONFLICT (role_name) DO NOTHING`,
        [title]
      );
    }

    res.json({
      message: "Job updated successfully",
      job
    });

  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === '23514' && err.constraint === 'salary_valid') {
      return res.status(400).json({
        field: "salary",
        message: "Minimum salary cannot be greater than maximum salary"
      });
    }
    console.error("Update job error:", err);
    res.status(500).json({ message: "Internal server error" });
  } finally {
    client.release();
  }
};

exports.getRecruiterStats = async (req, res) => {
  const { id } = req.params; // recruiter_id

  try {
    const stats = await pool.query(
      `
      SELECT 
        COUNT(*) as total_applications,
        COUNT(*) FILTER (WHERE ja.current_status != 'Applied') as responded_count
      FROM job_applications ja
      JOIN jobs j ON ja.job_id = j.job_id
      LEFT JOIN active_users u ON j.recruiter_id = u.user_id
      WHERE j.recruiter_id = $1
      GROUP BY u.user_id
      `,
      [id]
    );

    const data = stats.rows[0] || { total_applications: 0, responded_count: 0 };
    const total = parseInt(data.total_applications);
    const responded = parseInt(data.responded_count);
    const rate = total > 0 ? Math.round((responded / total) * 100) : 0;

    res.json({
      responseRate: rate,
      totalApplicants: total,
      typicallyRespondsIn: "2 days",
      isActive: true
    });

  } catch (err) {
    res.status(500).json({ message: "Internal server error" });
  }
};

exports.updateApplicationStatus = async (req, res) => {
  const { id } = req.params; // application_id
  const { status, screening } = req.body; // screening: { required, type, question }
  const userId = req.user.sub;

  try {
    // 1. Verify ownership of the job associated with this application
    const check = await pool.query(`
      SELECT j.recruiter_id, j.org_id, ja.job_id 
      FROM job_applications ja
      JOIN jobs j ON ja.job_id = j.job_id
      WHERE ja.application_id = $1
    `, [id]);

    if (check.rowCount === 0) return res.status(404).json({ message: "Application not found" });

    const { recruiter_id, org_id } = check.rows[0];
    let isAuthorized = recruiter_id === userId;
    if (!isAuthorized && org_id) {
      try {
        await assertOrgPermission(req, org_id, ['MANAGE_APPLICANTS', 'MANAGE_COMPANY']);
        isAuthorized = true;
      } catch (err) {
        return res.status(err.statusCode || 403).json({ message: err.message || "Not authorized" });
      }
    }
    if (!isAuthorized) return res.status(403).json({ message: "Not authorized" });

    // 2. Build Update Query
    let query = `UPDATE job_applications SET current_status = $1`;
    const params = [status, id];
    let paramCount = 3; // $2 is id

    if (status === 'Shortlisted' && screening && screening.required) {
      query += `, screening_required = TRUE, screening_type = $${paramCount++}, screening_question = $${paramCount++}`;
      params.push(screening.type, screening.question);
    } else if (status === 'Shortlisted') {
      // If just shortlisting without task, ensure flags are false (or keep existing? Assuming reset or fresh shortlist)
      // For now, let's assume if they don't send screening, we don't enable it.
      // But if they are re-shortlisting, careful not to wipe if not intended.
      // Frontend should send explicit false if disabling.
      // Let's stick to: if screening.required is explicitly true, set it.
    }

    query += ` WHERE application_id = $2 RETURNING *`;

    // Log history
    await pool.query(
      `INSERT INTO application_status_history (application_id, status) VALUES ($1, $2) ON CONFLICT DO NOTHING`, // simple log
      [id, status]
    );

    const result = await pool.query(query, params);

    // Notify candidate logic could go here (Socket/Email)

    res.json({ message: "Status updated", application: result.rows[0] });

  } catch (err) {
    console.error("Update status error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

exports.submitTask = async (req, res) => {
  const { id } = req.params; // application_id
  const userId = req.user.sub;

  try {
    // Verify applicant
    const check = await pool.query(`SELECT applicant_id FROM job_applications WHERE application_id = $1`, [id]);
    if (check.rowCount === 0) return res.status(404).json({ message: "Application not found" });
    if (check.rows[0].applicant_id !== userId) return res.status(403).json({ message: "Not authorized" });

    let responseUrl = null;
    if (req.file) {
      responseUrl = req.file.path;
    } else if (req.body.responseUrl) {
      responseUrl = req.body.responseUrl;
    }

    if (!responseUrl) return res.status(400).json({ message: "No file or URL provided" });

    await pool.query(`
      UPDATE job_applications 
      SET screening_submitted_at = NOW(), screening_response_url = $1
      WHERE application_id = $2
    `, [responseUrl, id]);

    res.json({ message: "Task submitted successfully" });

  } catch (err) {
    console.error("Submit task error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

exports.reviewApplication = async (req, res) => {
  // Wrapper for status update but specifically for Review flow (Approve/Reject)
  // currently updateApplicationStatus handles it well enough if generic.
  // We can alias or reuse it.
  return exports.updateApplicationStatus(req, res);
};

exports.getJobRoles = async (req, res) => {
    try {
        const { q } = req.query;
        let query = `SELECT role_name, category FROM job_roles_master`;
        let values = [];

        if (q) {
            query += ` WHERE role_name ILIKE $1`;
            values.push(`%${q}%`);
        }

        query += ` ORDER BY role_name ASC LIMIT 10`;

        const result = await pool.query(query, values);
        
        res.json(result.rows);
    } catch (err) {
        console.error("Error fetching job roles:", err);
        res.status(500).json({ error: "Internal server error" });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// AI Job Description Generator
// POST /api/v1/jobs/:id/generate
// Body: { "role": "Software Engineer" }
// ─────────────────────────────────────────────────────────────────────────────

exports.generateJD = async (req, res) => {
  const { id } = req.params;
  const userId = req.user.sub;
  const startTime = Date.now();

  // ── Step 1: Input validation ────────────────────────────────────────────────
  let role = req.body?.role;

  if (!role || typeof role !== "string") {
    return res.status(400).json({ message: "\"role\" is required and must be a string." });
  }

  role = role.trim();

  if (role.length < 2 || role.length > 100) {
    return res.status(400).json({
      message: "Role must be between 2 and 100 characters.",
      field: "role",
    });
  }

  // Basic sanity check — reject obvious HTML/injection in role name
  if (/<[^>]+>/.test(role)) {
    return res.status(400).json({
      message: "Role name must not contain HTML.",
      field: "role",
    });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ── Step 2: Load job from DB ──────────────────────────────────────────────
    const jobRes = await client.query(
      `SELECT job_id, org_id, recruiter_id, company_name, status FROM jobs WHERE job_id = $1`,
      [id]
    );
    if (jobRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Job not found." });
    }
    const job = jobRes.rows[0];

    // Only allow generation on DRAFT or ACTIVE jobs
    if (job.status !== "DRAFT" && job.status !== "ACTIVE") {
      await client.query("ROLLBACK");
      return res.status(400).json({
        message: `AI generation is only available for DRAFT or ACTIVE jobs. Current status: ${job.status}`,
      });
    }

    // ── Step 3: Ownership check ───────────────────────────────────────────────
    if (job.org_id) {
      await assertOrgPermission(
        req,
        getRequestedOrganizationActorId(req, job.org_id),
        ["POST_JOBS", "MANAGE_COMPANY"],
        client
      );
    } else {
      if (job.recruiter_id !== userId) {
        await client.query("ROLLBACK");
        return res.status(403).json({ message: "Unauthorized." });
      }
    }

    // ── Step 4: Redis cache check ─────────────────────────────────────────────
    // Cache key: SHA256(role (normalised) + company_id)
    const cacheInput = `${role.toLowerCase()}:${job.org_id || userId}`;
    const cacheKey = `jd_gen:${crypto.createHash("sha256").update(cacheInput).digest("hex")}`;

    let cachedResult;
    try {
      cachedResult = await redis.get(cacheKey);
    } catch {
      // Redis unavailable — proceed without cache
      cachedResult = null;
    }

    if (cachedResult) {
      await client.query("ROLLBACK"); // No DB changes needed for cache hit
      return res.status(200).json({
        message: "Job description generated successfully (cached).",
        job: JSON.parse(cachedResult),
        ai_metadata: { cached: true, model: process.env.AI_MODEL || "gemini-2.5-flash" },
      });
    }

    // ── Step 5: Call AI service ───────────────────────────────────────────────
    let generated;
    try {
      generated = await aiService.generateJobDescription({
        role,
        companyName: job.company_name || null,
        jobId: id,
        companyId: job.org_id || null,
      });
    } catch (aiErr) {
      await client.query("ROLLBACK");
      return res.status(aiErr.statusCode || 503).json({
        message: aiErr.message || "AI service is temporarily unavailable.",
      });
    }

    // ── Step 6: 3-stage validation pipeline ──────────────────────────────────
    try {
      validateSchema(generated);
      validateBusiness(generated);
      validateContentSafety(generated);
    } catch (validationErr) {
      await client.query("ROLLBACK");
      return res.status(validationErr.statusCode || 422).json({
        message: validationErr.message,
        field: validationErr.field || null,
      });
    }

    // ── Step 7: Cache the validated result ────────────────────────────────────
    const cacheTTL = parseInt(process.env.AI_CACHE_TTL_SECONDS || "3600", 10);
    try {
      await redis.setEx(cacheKey, cacheTTL, JSON.stringify(generated));
    } catch {
      // Non-fatal — proceed even if caching fails
    }

    // ── Step 8: Persist to DB ─────────────────────────────────────────────────
    // Build SET clause dynamically from validated AI output
    const AI_FIELD_MAP = {
      title: generated.title,
      description: generated.description,
      experience_min: generated.experience_min,
      experience_max: generated.experience_max,
    };

    // Store rich fields (arrays / strings) as JSONB-compatible values in columns
    // that exist on the jobs table. Fields like responsibilities, skills etc.
    // are stored as JSON strings in the summary / description or as separate columns
    // if your schema has them. Adjust the mapping below to match your actual schema.
    const setClauses = [];
    const values = [];
    let paramCount = 1;

    for (const [col, val] of Object.entries(AI_FIELD_MAP)) {
      setClauses.push(`${col} = $${paramCount}`);
      values.push(val);
      paramCount++;
    }

    values.push(id);
    const updateQuery = `UPDATE jobs SET ${setClauses.join(", ")} WHERE job_id = $${paramCount} RETURNING *`;
    const updatedJobRes = await client.query(updateQuery, values);
    const updatedJob = updatedJobRes.rows[0];

    // ── Step 9: AI provenance record ──────────────────────────────────────────
    await client.query(
      `INSERT INTO job_versions (job_id, changed_by, trigger_event, provenance, previous_data)
       VALUES ($1, $2, 'AI_GENERATE', 'AI', $3)`,
      [id, userId, job]
    );

    await client.query(
      `INSERT INTO job_activity (job_id, actor_id, action) VALUES ($1, $2, 'AI_GENERATED')`,
      [id, userId]
    );

    await client.query("COMMIT");

    // ── Step 10: Return response ──────────────────────────────────────────────
    return res.status(200).json({
      message: "Job description generated successfully.",
      job: {
        ...updatedJob,
        // Attach the rich AI fields so the frontend has the full JD
        // even if some are not yet persisted as separate DB columns
        ai_content: {
          summary: generated.summary,
          responsibilities: generated.responsibilities,
          requirements: generated.requirements,
          preferred_skills: generated.preferred_skills,
          employment_type: generated.employment_type,
          education: generated.education,
          skills: generated.skills,
          benefits: generated.benefits,
        },
      },
      ai_metadata: {
        model: process.env.AI_MODEL || "gemini-2.5-flash",
        latency_ms: Date.now() - startTime,
        cached: false,
      },
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Generate JD error:", err);
    return res.status(err.statusCode || 500).json({
      message: err.message || "Internal server error.",
    });
  } finally {
    client.release();
  }
};