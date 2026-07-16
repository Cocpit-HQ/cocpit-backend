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
const { extractRequirementsFromJDText } = require("../../services/jdExtractor.service");
const { calculateBackendScore, calculateTotalExperienceYears, getLatestEducation } = require("./applications/application.utils");


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

/**
 * Actor-context-aware job write authorization.
 *
 * Enforces creator isolation based purely on actor context — no role names.
 *   - Personal jobs (no org_id): caller is responsible for recruiter_id check.
 *   - Org jobs, actor type ORGANIZATION:
 *       • Admin-level (permissions includes "*" or "MANAGE_COMPANY") → can write any org job.
 *       • All other org members → can only write jobs they personally created (recruiter_id = userId).
 *   - No org actor context: DB-RBAC fallback with the same admin-vs-creator logic.
 *
 * Use this instead of assertOrgPermission for all write operations on existing jobs.
 */
const assertJobActorAccess = async (req, job, permissions, queryable = pool) => {
  const userId = req.user.sub;

  if (!job.org_id) {
    // Personal job — creator check handled by the caller
    return;
  }

  if (req.actor?.type === "ORGANIZATION") {
    // Must be acting as the correct org
    if (req.actor.orgId !== job.org_id) {
      const err = new Error("Active organization actor does not match requested organization");
      err.statusCode = 403;
      throw err;
    }

    const actorPermissions = req.actor.permissions || [];

    // Check required permission
    if (!hasAnyActorPermission(actorPermissions, permissions)) {
      const err = new Error("Not authorized for this organization");
      err.statusCode = 403;
      throw err;
    }

    // Admin-level bypass: wildcard or MANAGE_COMPANY can manage all org jobs
    if (actorPermissions.includes("*") || actorPermissions.includes("MANAGE_COMPANY")) {
      return;
    }

    // Creator isolation: non-admin members can only manage jobs they created
    if (job.recruiter_id !== userId) {
      const err = new Error("You can only manage jobs that you created");
      err.statusCode = 403;
      throw err;
    }

    return;
  }

  // No org actor context — DB-level RBAC fallback
  const ok = await checkOrgPermission(queryable, job.org_id, userId, permissions);
  if (!ok) {
    const err = new Error("Not authorized for this organization");
    err.statusCode = 403;
    throw err;
  }

  // DB check passed — determine if admin-level to bypass creator isolation
  const memberRes = await queryable.query(
    `SELECT cr.permissions
     FROM organization_members cm
     LEFT JOIN organization_roles cr ON cm.role_id = cr.role_id
     WHERE cm.org_id = $1 AND cm.user_id = $2`,
    [job.org_id, userId]
  );

  const memberPerms = memberRes.rows[0]?.permissions || [];
  if (memberPerms.includes("*") || memberPerms.includes("MANAGE_COMPANY")) {
    return; // Admin-level — can manage all org jobs
  }

  // Creator isolation for non-admin fallback path
  if (job.recruiter_id !== userId) {
    const err = new Error("You can only manage jobs that you created");
    err.statusCode = 403;
    throw err;
  }
};

exports.getAllJobs = async (req, res) => {
  const { limit = 10, cursor } = req.query;
  const userId = req.user?.sub;

  try {
    const { conditions, values, nextIndex } = buildJobFilters(req.query, userId ? 2 : 1);

    if (userId) {
      conditions.push(`j.recruiter_id != $1`);
      conditions.push(`(ja.application_id IS NULL OR ja.current_status = 'Withdrawn')`);
      conditions.push(`jo.offer_id IS NULL`);
    }

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
        u.avatar_url AS recruiter_avatar,
        c.logo_url AS company_logo,
        COALESCE(c.logo_url, '') AS company_avatar,
        c.slug AS company_slug,
        ${userId ? '(js.user_id IS NOT NULL) AS "isSaved",' : 'FALSE AS "isSaved",'}
        ${userId ? '(ja.application_id IS NOT NULL AND ja.current_status != \'Withdrawn\') AS "hasApplied",' : 'FALSE AS "hasApplied",'}
        ${userId ? 'ja.current_status AS "applicationStatus",' : 'NULL AS "applicationStatus",'}
        ${userId ? '(jo.offer_id IS NOT NULL) AS "is_offer",' : 'FALSE AS "is_offer",'}
        ${userId ? 'jo.offer_id,' : 'NULL AS offer_id,'}
        ${userId ? 'CASE WHEN jo.status = \'pending\' AND jo.expires_at <= NOW() THEN \'expired\' ELSE jo.status END AS "offerStatus",' : 'NULL AS "offerStatus",'}
        ${userId ? 'jo.expires_at AS "offer_expires_at",' : 'NULL AS "offer_expires_at",'}
        (SELECT COUNT(*)::int FROM job_applications ja_count WHERE ja_count.job_id = j.job_id) as applicants
      FROM jobs j
      LEFT JOIN active_users u ON j.recruiter_id = u.user_id
      LEFT JOIN organizations c ON j.org_id = c.org_id
      ${userId ? "LEFT JOIN job_saves js ON js.job_id = j.job_id AND js.user_id = $1" : ""}
      ${userId ? "LEFT JOIN job_applications ja ON ja.job_id = j.job_id AND ja.applicant_id = $1" : ""}
      ${userId ? "LEFT JOIN job_offers jo ON jo.job_id = j.job_id AND jo.user_id = $1" : ""}
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
  }
};

exports.getRecommendations = async (req, res) => {
  const userId = req.user?.sub;

  try {
    const query = `
      SELECT 
        j.*,
        u.full_name AS recruiter_name,
        u.avatar_url AS recruiter_avatar,
        c.logo_url AS company_logo,
        COALESCE(c.logo_url, '') AS company_avatar,
        c.slug AS company_slug,
        ${userId ? '(js.user_id IS NOT NULL) AS "isSaved",' : 'FALSE AS "isSaved",'}
        ${userId ? '(ja.application_id IS NOT NULL AND ja.current_status != \'Withdrawn\') AS "hasApplied",' : 'FALSE AS "hasApplied",'}
        ${userId ? 'ja.current_status AS "applicationStatus",' : 'NULL AS "applicationStatus",'}
        (SELECT COUNT(*)::int FROM job_applications ja_count WHERE ja_count.job_id = j.job_id) as applicants
      FROM jobs j
      LEFT JOIN active_users u ON j.recruiter_id = u.user_id
      LEFT JOIN organizations c ON j.org_id = c.org_id
      ${userId ? "LEFT JOIN job_saves js ON js.job_id = j.job_id AND js.user_id = $1" : ""}
      ${userId ? "LEFT JOIN job_applications ja ON ja.job_id = j.job_id AND ja.applicant_id = $1" : ""}
      ${userId ? "LEFT JOIN job_offers jo ON jo.job_id = j.job_id AND jo.user_id = $1" : ""}
      WHERE j.is_active = TRUE AND j.status = 'ACTIVE'
      ${userId ? "AND j.recruiter_id != $1" : ""}
      ${userId ? "AND (ja.application_id IS NULL OR ja.current_status = 'Withdrawn')" : ""}
      ${userId ? "AND jo.offer_id IS NULL" : ""}
      ORDER BY j.created_at DESC
      LIMIT 3
    `;

    const params = userId ? [userId] : [];
    const result = await pool.query(query, params);

    const recommendations = result.rows.map((job, index) => {
      const mockBadges = ["Top 5%", "Top 10%", "Top 15%"];
      const mockResponseRates = ["98%", "95%", "92%"];
      const mockAvgReplies = ["1 day", "2 days", "3 days"];
      const mockReasons = [
        "Matches your skills in React and Node.js",
        "Strong match for your Figma portfolio",
        "Matches your experience with AWS"
      ];
      const mockScores = [95, 90, 85];

      return {
        ...job,
        is_recommended: true,
        recommended_badge: mockBadges[index % mockBadges.length],
        response_rate: mockResponseRates[index % mockResponseRates.length],
        avg_reply: mockAvgReplies[index % mockAvgReplies.length],
        match_reason: mockReasons[index % mockReasons.length],
        match_score: job.match_score || mockScores[index % mockScores.length]
      };
    });

    res.json(recommendations);
  } catch (err) {
    console.error("Get recommendations error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

const formatReplyTime = (interval) => {
  if (!interval) return null;

  const days = interval.days || 0;
  const hours = interval.hours || 0;
  const minutes = interval.minutes || 0;
  const seconds = interval.seconds || 0;

  const totalHours = (days * 24) + hours + (minutes / 60) + (seconds / 3600);

  if (totalHours < 1) {
    const mins = Math.max(1, Math.round(minutes || (seconds / 60)));
    return mins === 1 ? '1 minute' : `${mins} minutes`;
  }

  if (totalHours < 24) {
    const hrs = Math.round(totalHours);
    return hrs === 1 ? '1 hour' : `${hrs} hours`;
  }

  const totalDays = totalHours / 24;
  const roundedDays = Math.round(totalDays);
  return roundedDays === 1 ? '1 day' : `${roundedDays} days`;
};

exports.getJobById = async (req, res) => {
  const { id } = req.params;
  const userId = req.user?.sub; // optional

  try {
    let resolvedJobId = id;
    const offerCheck = await pool.query("SELECT job_id FROM job_offers WHERE offer_id = $1", [id]);
    if (offerCheck.rowCount > 0) {
      resolvedJobId = offerCheck.rows[0].job_id;
    }

    const result = await pool.query(
      `
      SELECT 
        j.*,
        u.full_name AS recruiter_name,
        u.avatar_url AS recruiter_avatar,
        c.logo_url AS company_logo,
        COALESCE(c.logo_url, '') AS company_avatar,
        c.slug AS company_slug,
        ${userId ? '(js.user_id IS NOT NULL) AS "isSaved",' : 'FALSE AS "isSaved",'}
        ${userId ? '(ja.application_id IS NOT NULL AND ja.current_status != \'Withdrawn\') AS "hasApplied",' : 'FALSE AS "hasApplied",'}
        ${userId ? 'ja.current_status AS "applicationStatus",' : 'NULL AS "applicationStatus",'}
        ${userId ? '(jo.offer_id IS NOT NULL) AS "is_offer",' : 'FALSE AS "is_offer",'}
        ${userId ? 'CASE WHEN jo.status = \'pending\' AND jo.expires_at <= NOW() THEN \'expired\' ELSE jo.status END AS "offerStatus",' : 'NULL AS "offerStatus",'}
        ${userId ? 'jo.expires_at AS "offer_expires_at",' : 'NULL AS "offer_expires_at",'}
        ${userId ? 'jo.offer_id AS "offer_id",' : 'NULL AS "offer_id",'}
        ${userId ? 'jo.message AS "recruiter_message",' : 'NULL AS "recruiter_message",'}
        ${userId ? 'ja.application_id AS "applicationId",' : 'NULL AS "applicationId",'}
        ${userId ? 'ja.screening_required AS "screeningRequired",' : 'NULL AS "screeningRequired",'}
        ${userId ? 'ja.screening_type AS "screeningType",' : 'NULL AS "screeningType",'}
        ${userId ? 'ja.screening_question AS "screeningQuestion",' : 'NULL AS "screeningQuestion",'}
        ${userId ? 'ja.screening_submitted_at AS "screeningSubmittedAt",' : 'NULL AS "screeningSubmittedAt",'}
        ${userId ? '(of.user_id IS NOT NULL OR uf.follower_id IS NOT NULL) AS "is_followed",' : 'FALSE AS "is_followed",'}
        (SELECT COUNT(*)::int FROM job_applications ja_count WHERE ja_count.job_id = j.job_id) as applicants
      FROM jobs j
      LEFT JOIN active_users u ON j.recruiter_id = u.user_id
      LEFT JOIN organizations c ON j.org_id = c.org_id
      ${userId ? 'LEFT JOIN job_saves js ON js.job_id = j.job_id AND js.user_id = $2' : ''}
      ${userId ? 'LEFT JOIN job_applications ja ON ja.job_id = j.job_id AND ja.applicant_id = $2' : ''}
      ${userId ? 'LEFT JOIN organization_followers of ON of.org_id = j.org_id AND of.user_id = $2' : ''}
      ${userId ? 'LEFT JOIN followers uf ON uf.following_id = j.recruiter_id AND uf.follower_id = $2' : ''}
      ${userId ? 'LEFT JOIN job_offers jo ON jo.job_id = j.job_id AND jo.user_id = $2' : ''}
      WHERE j.job_id = $1
      `,
      userId ? [resolvedJobId, userId] : [resolvedJobId]
    );

    if (result.rowCount === 0 || !result.rows[0].is_active) {
      return res.status(404).json({ message: "Job not found" });
    }

    const job = result.rows[0];

    // Calculate recruiter/company analytics
    let responseRate = null;
    let avgReply = null;

    let targetCondition = '';
    let targetParams = [];
    if (job.org_id) {
      targetCondition = 'j.org_id = $1';
      targetParams = [job.org_id];
    } else {
      targetCondition = 'j.recruiter_id = $1 AND j.org_id IS NULL';
      targetParams = [job.recruiter_id];
    }

    const statsRes = await pool.query(
      `
      WITH first_replies AS (
        SELECT 
          ja.application_id,
          ja.applied_at,
          ja.current_status,
          (
            SELECT MIN(ash.changed_at) 
            FROM application_status_history ash 
            WHERE ash.application_id = ja.application_id 
              AND ash.status != 'Applied'
          ) AS first_response_at
        FROM job_applications ja
        JOIN jobs j ON ja.job_id = j.job_id
        WHERE ${targetCondition}
      )
      SELECT 
        COUNT(*)::int AS total_applications,
        COUNT(CASE WHEN current_status != 'Applied' THEN 1 END)::int AS responded_count,
        AVG(first_response_at - applied_at) AS avg_reply_interval
      FROM first_replies
      `,
      targetParams
    );

    if (statsRes.rowCount > 0 && statsRes.rows[0].total_applications > 0) {
      const stats = statsRes.rows[0];
      const total = stats.total_applications;
      const responded = stats.responded_count;
      responseRate = `${Math.round((responded / total) * 100)}%`;
      avgReply = formatReplyTime(stats.avg_reply_interval);
    }

    job.response_rate = responseRate;
    job.avg_reply = avgReply;
    // Fetch AI generation limit for UI state
    try {
      const rateLimitKey = `ai_rate_limit:job:${resolvedJobId}`;
      const count = await redis.get(rateLimitKey);
      job.ai_generation_count = count ? parseInt(count, 10) : 0;
    } catch (e) {
      job.ai_generation_count = 0;
    }

    res.json(job);

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

  const maxGenerationsPerDay = parseInt(process.env.AI_MAX_DRAFT_GENERATIONS_PER_DAY || "10", 10);
  const rateLimitKey = `ai_draft_gen:user:${userId}:date:${new Date().toISOString().split('T')[0]}`;
  let generationCount = 0;
  try {
    generationCount = await redis.incr(rateLimitKey);
    if (generationCount === 1) {
      await redis.expire(rateLimitKey, 24 * 60 * 60);
    }
  } catch (err) {
    console.warn("Redis daily draft generation rate limit failed, bypassing:", err);
  }

  // AI Generation Phase
  let aiDescription = "";
  let generated = null;

  if (generationCount <= maxGenerationsPerDay) {
    try {
      const aiService = require("../../services/ai.service");
      const companyReplacement = postedAsCompany ? resolvedCompanyName : "our team";
      generated = await aiService.generateJobDescription({
        role: title,
        companyName: companyReplacement,
        jobId: null,
        companyId: org_id || null,
        userId: userId,
        orgId: org_id || null,
        sourceIp: req.ip
      });

      // Use the shared helper so createJob and generateJD always produce
      // identical description formatting.
      aiDescription = buildAIDescription(generated);
    } catch (e) {
      console.error("Auto AI Generation failed during createJob:", e.message);
      // If it fails, we just leave aiDescription blank and let the draft be created normally.
    }
  } else {
    console.warn(`[createJob] User ${userId} exceeded daily draft generation cap (${maxGenerationsPerDay}). Skipping AI generation.`);
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const aiRequirements = generated ? {
      skills: generated.required_skills_keywords || [],
      experience_min: generated.experience_min || null,
      education: generated.education || null,
    } : null;

    const jobRes = await client.query(
      `
      INSERT INTO jobs
      (recruiter_id, title, company_name, org_id, posted_as_company, status, industry, description,
       experience_min, experience_max, ai_extracted_requirements)
      VALUES ($1, $2, $3, $4, $5, 'DRAFT', '', $6, $7, $8, $9)
      RETURNING *
      `,
      [
        userId,
        title,
        resolvedCompanyName,
        requestedOrgId || null,
        postedAsCompany,
        aiDescription,
        generated?.experience_min || null,
        generated?.experience_max || null,
        aiRequirements ? JSON.stringify(aiRequirements) : null
      ]
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

    // description already contains the full AI-generated markdown
    res.status(201).json({ message: "Draft created successfully", job });

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
    const jobRes = await pool.query(`SELECT org_id, recruiter_id, status, description FROM jobs WHERE job_id = $1`, [id]);
    if (jobRes.rowCount === 0) return res.status(404).json({ message: "Job not found" });
    const job = jobRes.rows[0];

    if (job.org_id) {
      await assertJobActorAccess(req, job, ["POST_JOBS", "MANAGE_COMPANY"]);
    } else {
      if (job.recruiter_id !== userId) return res.status(403).json({ message: "Unauthorized" });
    }

    if (job.status !== 'DRAFT' && job.status !== 'ACTIVE') {
      return res.status(400).json({ message: "Can only update jobs in DRAFT or ACTIVE state" });
    }

    if (updates.description !== undefined) {
      const isDescriptionChanged = updates.description.trim() !== (job.description || "").trim();

      if (isDescriptionChanged) {
        if (job.status === 'DRAFT') {
          // Defer extraction until submitJob (nulling out any previously extracted requirements)
          updates.ai_extracted_requirements = null;
        } else if (job.status === 'ACTIVE') {
          // Synchronously run extraction for live edits so candidates can be matched accurately
          const extracted = await extractRequirementsFromJDText(updates.description, id, userId, job.org_id, req.ip);
          updates.ai_extracted_requirements = JSON.stringify(extracted);
          // Only use AI-extracted experience_min if the user did NOT explicitly send one.
          if (extracted.experience_min !== null && updates.experience_min === undefined) {
            updates.experience_min = extracted.experience_min;
          }
        }
      }
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

    setClauses.push("updated_at = NOW()");

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

    if (updates.industry) {
      await pool.query(
        `INSERT INTO industries_master (industry_name) 
         VALUES ($1) 
         ON CONFLICT (industry_name) DO NOTHING`,
        [updates.industry]
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
      await assertJobActorAccess(req, job, ["POST_JOBS", "MANAGE_COMPANY"], client);
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

    let updated;
    if (!job.ai_extracted_requirements) {
      const extracted = await extractRequirementsFromJDText(job.description);
      const setClauses = ["status = 'ACTIVE'", "ai_extracted_requirements = $2", "created_at = NOW()"];
      const params = [id, JSON.stringify(extracted)];
      // Only set experience_min from extraction if the job doesn't already have one
      if (extracted.experience_min !== null && (job.experience_min === null || job.experience_min === undefined)) {
        setClauses.push("experience_min = $3");
        params.push(extracted.experience_min);
      }
      updated = await client.query(
        `UPDATE jobs SET ${setClauses.join(", ")} WHERE job_id = $1 RETURNING *`,
        params
      );
    } else {
      updated = await client.query(
        `UPDATE jobs SET status = 'ACTIVE', created_at = NOW() WHERE job_id = $1 RETURNING *`,
        [id]
      );
    }

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
  } catch (err) {
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
      await assertJobActorAccess(req, job, ["POST_JOBS", "MANAGE_COMPANY"], client);
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
  } catch (err) {
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

    // Ownership check: approve/reject are admin-level actions (not yet role-gated).
    // All other lifecycle actions (pause, close, archive) enforce actor-based creator isolation.
    if (actionName !== 'APPROVE' && actionName !== 'REJECT') {
      if (job.org_id) {
        await assertJobActorAccess(req, job, ["POST_JOBS", "MANAGE_COMPANY"], client);
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
  } catch (err) {
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

    setClauses.push("updated_at = NOW()");

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

  // Take other fields from request body (guard against undefined body e.g. missing Content-Type)
  const body = req.body || {};
  let { full_name, email, phone, mobile_number, cover_note } = body;

  // Sanitize user-generated content
  cover_note = sanitizeContent(cover_note);
  const contactPhone = phone || mobile_number;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // If name or email missing, fetch from user profile for robustness
    if (!full_name || !email) {
      const userResult = await client.query(
        `SELECT full_name, email FROM users WHERE user_id = $1`,
        [userId]
      );
      if (userResult.rowCount > 0) {
        full_name = full_name || userResult.rows[0].full_name;
        email = email || userResult.rows[0].email;
      }
    }

    if (!full_name || !email) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Name and Email are required for application" });
    }

    // 3. Fetch live profile data (INSIDE the transaction — data is frozen at this instant)
    const [skillsRes, expRes, eduRes, jobRes] = await Promise.all([
      client.query(`
        SELECT s.name FROM user_skills us
        JOIN skills s ON us.skill_id = s.skill_id
        JOIN profiles p ON us.profile_id = p.profile_id
        WHERE p.user_id = $1`, [userId]),
      client.query(`
        SELECT title, company_name, start_date, end_date, is_current
        FROM experiences e JOIN profiles p ON e.profile_id = p.profile_id
        WHERE p.user_id = $1 ORDER BY start_date DESC`, [userId]),
      client.query(`
        SELECT degree, school_name, end_date FROM educations ed
        JOIN profiles p ON ed.profile_id = p.profile_id
        WHERE p.user_id = $1 ORDER BY end_date DESC LIMIT 2`, [userId]),
      client.query(`
        SELECT title, description, experience_min, experience_max,
               experience_label, location, ai_extracted_requirements, org_id, recruiter_id, status, is_active
        FROM jobs WHERE job_id = $1`, [id]),
    ]);

    if (jobRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Job not found" });
    }

    const job = jobRes.rows[0];
    if (job.status === 'CLOSED' || job.is_active === false) {
      await client.query("ROLLBACK");
      return res.status(403).json({ message: "This job is closed and no longer accepting applications" });
    }
    const candidateSkills = skillsRes.rows.map(r => r.name);
    const experienceRows = expRes.rows;
    const educationRows = eduRes.rows;

    const { org_id, recruiter_id } = job;

    // Check if user is the recruiter
    if (recruiter_id === userId) {
      await client.query("ROLLBACK");
      return res.status(403).json({ message: "You cannot apply to your own job" });
    }

    // Check if user has permission to post jobs for this organization
    if (org_id) {
      const canPostJobs = await checkOrgPermission(pool, org_id, userId, ['POST_JOBS', 'MANAGE_COMPANY']);
      if (canPostJobs) {
        await client.query("ROLLBACK");
        return res.status(403).json({ message: "You cannot apply to a job posted by your organization" });
      }
    }

    // Check if already applied (active application — not withdrawn)
    const existing = await client.query(
      `SELECT application_id, current_status FROM job_applications WHERE job_id = $1 AND applicant_id = $2`,
      [id, userId]
    );
    if (existing.rowCount > 0 && existing.rows[0].current_status !== 'Withdrawn') {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "Already applied to this job" });
    }
    const existingWithdrawn = existing.rowCount > 0 && existing.rows[0].current_status === 'Withdrawn';

    // Resume file URL from Cloudinary or existing profile resume
    let resume_url = null;
    let resume_file_name = null;
    if (req.file) {
      resume_url = req.file.path;
      resume_file_name = req.file.originalname;
    } else if (req.files && req.files['resume'] && req.files['resume'][0]) {
      resume_url = req.files['resume'][0].path;
      resume_file_name = req.files['resume'][0].originalname;
    }
    if (!resume_url && body.resume_url) {
      resume_url = body.resume_url;
      resume_file_name = body.resume_file_name || null;
    }
    if (!resume_url) {
      const recentResumeResult = await client.query(
        `SELECT resume_url, resume_file_name FROM job_applications
         WHERE applicant_id = $1 AND resume_url IS NOT NULL
         ORDER BY application_id DESC LIMIT 1`,
        [userId]
      );
      if (recentResumeResult.rowCount > 0) {
        resume_url = recentResumeResult.rows[0].resume_url;
        resume_file_name = recentResumeResult.rows[0].resume_file_name;
      }
    }

    if (!resume_url) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Resume is required" });
    }

    // 4. Calculate scalars
    const totalYears = calculateTotalExperienceYears(experienceRows);
    const highestDegree = getLatestEducation(educationRows)?.degree || null;
    const candidateLocation = req.body.location || null;

    // 5. Calculate backend score
    const backendScore = calculateBackendScore({
      candidateSkills,
      totalYears,
      jobRequirements: job.ai_extracted_requirements,
      experienceMin: job.experience_min,
      experienceMax: job.experience_max,
      experienceLabel: job.experience_label,
    });

    // 6. INSERT job_applications
    let appResult;
    if (existingWithdrawn) {
      appResult = await client.query(
        `UPDATE job_applications
         SET full_name = $3, email = $4, phone = $5, resume_url = $6, resume_file_name = $13, cover_note = $7,
             frozen_experience_years = $8, frozen_location = $9, frozen_skills = $10, frozen_highest_degree = $11, backend_score = $12,
             current_status = 'Applied'
         WHERE job_id = $1 AND applicant_id = $2
         RETURNING application_id`,
        [id, userId, full_name, email, contactPhone, resume_url, cover_note, Math.round(totalYears), candidateLocation, candidateSkills, highestDegree, backendScore, resume_file_name]
      );

      // Cleanup old snapshot/analyses for re-application
      await client.query(`DELETE FROM application_snapshots WHERE application_id = $1`, [appResult.rows[0].application_id]);
      await client.query(`DELETE FROM application_ai_analyses WHERE application_id = $1`, [appResult.rows[0].application_id]);
      await client.query(`DELETE FROM ai_analysis_queue WHERE application_id = $1`, [appResult.rows[0].application_id]);
    } else {
      appResult = await client.query(
        `INSERT INTO job_applications 
         (job_id, applicant_id, full_name, email, phone, resume_url, resume_file_name, cover_note, frozen_experience_years, frozen_location, frozen_skills, frozen_highest_degree, backend_score)
         VALUES ($1,$2,$3,$4,$5,$6,$13,$7,$8,$9,$10,$11,$12)
         RETURNING application_id`,
        [id, userId, full_name, email, contactPhone, resume_url, cover_note, Math.round(totalYears), candidateLocation, candidateSkills, highestDegree, backendScore, resume_file_name]
      );
    }

    const appId = appResult.rows[0].application_id;

    // 7. Build and store frozen snapshots
    const candidateSnapshot = {
      skills: candidateSkills,
      experience: experienceRows,
      education: educationRows,
      totalExperienceYears: totalYears,
      location: candidateLocation,
      highestDegree,
      resumeUrl: resume_url,
    };
    const jobSnapshot = {
      title: job.title,
      experienceMin: job.experience_min,
      experienceMax: job.experience_max,
      experienceLabel: job.experience_label,
      skills: job.ai_extracted_requirements?.skills || [],
      education: job.ai_extracted_requirements?.education,
    };
    await client.query(`
      INSERT INTO application_snapshots (application_id, candidate_snapshot, job_snapshot)
      VALUES ($1, $2, $3)`,
      [appId, JSON.stringify(candidateSnapshot), JSON.stringify(jobSnapshot)]
    );

    // 8. INSERT backend score into application_ai_analyses
    await client.query(`
      INSERT INTO application_ai_analyses (application_id, match_score, analysis_type, provider)
      VALUES ($1, $2, 'BACKEND', 'backend')`,
      [appId, backendScore]
    );

    // 9. Minimum Pool Gate & Determine tier and queue accordingly
    const MIN_POOL = parseInt(process.env.AI_MIN_APPLICATIONS_FOR_AUTO || '25', 10);
    const totalAppsRes = await client.query(
      `SELECT COUNT(*) AS total FROM job_applications WHERE job_id = $1`,
      [id]
    );
    const totalApplications = parseInt(totalAppsRes.rows[0].total, 10);

    if (totalApplications < MIN_POOL) {
      console.log(`[applyJob] Job ${id} has ${totalApplications}/${MIN_POOL} apps — skipping auto-queue.`);
    } else {
      const rankRes = await client.query(`
        SELECT COUNT(*) + 1 AS rank
        FROM job_applications
        WHERE job_id = $1 AND backend_score > $2`,
        [id, backendScore]
      );
      const rank = parseInt(rankRes.rows[0].rank, 10);

      const TIER1_THRESHOLD = parseInt(process.env.AI_TIER1_SCORE_THRESHOLD || '65', 10);
      const TIER1_TOP_N = parseInt(process.env.AI_TIER1_TOP_N || '15', 10);
      const TIER2_THRESHOLD = parseInt(process.env.AI_TIER2_SCORE_THRESHOLD || '30', 10);

      if (backendScore >= TIER1_THRESHOLD || rank <= TIER1_TOP_N) {
        // 🟢 TIER 1
        await client.query(`
          INSERT INTO ai_analysis_queue (application_id, priority, reason)
          VALUES ($1, 2, 'TIER1_AUTO')`,
          [appId]
        );

        // Demotion
        await client.query(`
          UPDATE ai_analysis_queue aq
          SET priority = 1, reason = 'TIER2_DEMOTED'
          WHERE aq.priority = 2
            AND aq.status = 'PENDING'
            AND aq.application_id IN (
              SELECT ja.application_id
              FROM job_applications ja
              WHERE ja.job_id = $1
                AND ja.backend_score < $2
                AND ja.application_id != $3
              ORDER BY ja.backend_score DESC
              OFFSET $4
            )`,
          [id, backendScore, appId, TIER1_TOP_N]
        );
      } else if (backendScore >= TIER2_THRESHOLD) {
        // 🟡 TIER 2
        await client.query(`
          INSERT INTO ai_analysis_queue (application_id, priority, reason)
          VALUES ($1, 1, 'TIER2_DEFERRED')`,
          [appId]
        );
      }
    }

    // 10. Existing status history log
    await client.query(
      `INSERT INTO application_status_history (application_id, status) VALUES ($1, 'Applied')`,
      [appId]
    );

    // 11. COMMIT and return
    await client.query('COMMIT');
    res.status(201).json({ message: "Application submitted successfully", applicationId: appId });

    // 🎯 Intent Layer: Log Apply Job
    logIntentActivity({ userId, action: "apply_job", metadata: { jobId: id, applicationId: appId } });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Apply job error:", err);
    res.status(500).json({ message: "Internal server error" });
  } finally {
    client.release();
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
        ${userId ? '(ja.application_id IS NOT NULL AND ja.current_status != \'Withdrawn\') AS "hasApplied",' : 'FALSE AS "hasApplied",'}
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
      return res.status(200).json({ message: "Job not found in saved list, but considered unsaved." });
    }

    res.json({ message: "Job removed from saved list" });
  } catch (err) {
    console.error("Unsave job error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};
exports.withdrawApplication = async (req, res) => {
  const jobId = req.params.id;
  const applicantId = req.user.sub;

  try {
    const updateResult = await pool.query(
      `UPDATE job_applications
       SET current_status = 'Withdrawn'
       WHERE job_id = $1 AND applicant_id = $2
       RETURNING application_id, current_status`,
      [jobId, applicantId]
    );

    if (updateResult.rowCount === 0) {
      return res.status(404).json({ message: "Application not found" });
    }

    if (updateResult.rows[0].current_status === 'Withdrawn') {
      // Actually it's updating it to Withdrawn, so we just continue.
    }

    // 🎯 Intent Layer: Log Withdraw Job
    if (logIntentActivity) {
      logIntentActivity({ userId: applicantId, action: "withdraw_application", metadata: { jobId, applicationId: updateResult.rows[0].application_id } });
    }

    res.json({
      success: true,
      message: "Application withdrawn successfully."
    });
  } catch (err) {
    console.error("Withdraw application error:", err);
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
        u.avatar_url AS recruiter_avatar,
        c.logo_url AS company_logo,
        COALESCE(c.logo_url, '') AS company_avatar,
        c.slug AS company_slug,
        TRUE AS "isSaved",
        (ja.application_id IS NOT NULL AND ja.current_status != 'Withdrawn') AS "hasApplied",
        ja.current_status AS "applicationStatus",
        (SELECT COUNT(*)::int FROM job_applications ja_count WHERE ja_count.job_id = j.job_id) as applicants,
        js.saved_at,
        (jo.offer_id IS NOT NULL) AS "is_offer",
        jo.offer_id,
        CASE WHEN jo.status = 'pending' AND jo.expires_at <= NOW() THEN 'expired' ELSE jo.status END AS "offerStatus",
        jo.expires_at AS "offer_expires_at"
      FROM job_saves js
      JOIN jobs j ON js.job_id = j.job_id
      LEFT JOIN active_users u ON j.recruiter_id = u.user_id
      LEFT JOIN organizations c ON j.org_id = c.org_id
      LEFT JOIN job_applications ja ON ja.job_id = j.job_id AND ja.applicant_id = $1
      LEFT JOIN job_offers jo ON jo.job_id = j.job_id AND jo.user_id = $1
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

exports.getMyRecentResumes = async (req, res) => {
  try {
    const applicantId = req.user.sub;
    const result = await pool.query(`
      SELECT resume_url, MAX(applied_at) as last_applied, (array_agg(resume_file_name ORDER BY applied_at DESC))[1] as resume_file_name
      FROM job_applications
      WHERE applicant_id = $1 AND resume_url IS NOT NULL
      GROUP BY resume_url
      ORDER BY last_applied DESC
      LIMIT 2
    `, [applicantId]);

    const resumes = result.rows.map(row => {
      const url = row.resume_url;
      let name = row.resume_file_name;

      if (!name) {
        name = url.split('/').pop() || 'Resume.pdf';
        // Clean up Cloudinary name (remove user id prefix if present)
        // Format: resume-userid-timestamp.pdf -> Resume-timestamp.pdf or just keep it simple
        if (name.startsWith('resume-')) {
          const parts = name.split('-');
          if (parts.length > 2) {
            // just pop the timestamp+ext and maybe user id, let's just make it look cleaner
            name = `Resume-${parts[parts.length - 1]}`;
          }
        }
      }
      return { id: url, name, url, last_applied: row.last_applied };
    });

    res.json(resumes);
  } catch (err) {
    console.error("Get my recent resumes error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

exports.getMyApplicationStats = async (req, res) => {
  try {
    const applicantId = req.user.sub;
    const result = await pool.query(`
      SELECT 
        COUNT(*) as total_applied,
        COUNT(*) FILTER (WHERE current_status ILIKE 'Shortlisted%') as shortlisted
      FROM job_applications
      WHERE applicant_id = $1
    `, [applicantId]);

    res.json({
      totalApplied: parseInt(result.rows[0].total_applied || 0),
      shortlisted: parseInt(result.rows[0].shortlisted || 0)
    });
  } catch (err) {
    console.error("Get my application stats error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

exports.getMyApplications = async (req, res) => {
  const userId = req.user.sub;
  const { limit = 10, cursor, status } = req.query;

  const allowedStatus = ['all', 'applied', 'in progress', 'in past', 'saved', 'in-progress', 'in-past', 'shortlisted', 'in review', 'in-review', 'declined', 'rejected'];

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
        LEFT JOIN users u ON j.recruiter_id = u.user_id
        LEFT JOIN job_saves js ON j.job_id = js.job_id AND js.user_id = $1
        LEFT JOIN job_offers jo ON j.job_id = jo.job_id AND jo.user_id = $1
        WHERE ja.applicant_id = $1 AND ja.current_status != 'Withdrawn' AND j.is_active = TRUE
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
      } else if (s === 'in review' || s === 'in-review') {
        baseQuery += ` AND ja.current_status ILIKE 'in-review'`;
      } else if (s === 'declined' || s === 'rejected') {
        baseQuery += ` AND (ja.current_status ILIKE 'declined' OR ja.current_status ILIKE 'rejected')`;
      } else if (s === 'shortlisted') {
        baseQuery += ` AND ja.current_status ILIKE 'shortlisted'`;
      }
      // If s === 'all', we don't add any specific status filter.
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
          (ja.current_status != 'Withdrawn') AS "hasApplied",
          ja.current_status AS "applicationStatus",
          ja.application_id AS "applicationId",
          ja.screening_required AS "screeningRequired",
          ja.screening_type AS "screeningType",
          ja.screening_question AS "screeningQuestion",
          ja.screening_submitted_at AS "screeningSubmittedAt",
          (jo.offer_id IS NOT NULL) AS "is_offer",
          jo.offer_id,
          CASE WHEN jo.status = 'pending' AND jo.expires_at <= NOW() THEN 'expired' ELSE jo.status END AS "offerStatus",
          jo.expires_at AS "offer_expires_at",
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
    limit = 10,
    cursor,
    status,
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
        u.avatar_url AS recruiter_avatar,
        c.logo_url AS company_logo,
        COALESCE(c.logo_url, '') AS company_avatar,
        c.slug AS company_slug,
        (SELECT COUNT(*)::int FROM job_applications ja_count WHERE ja_count.job_id = j.job_id AND ja_count.current_status != 'Withdrawn') as applicants_count,
        (SELECT COUNT(*)::int FROM job_applications ja_count WHERE ja_count.job_id = j.job_id AND ja_count.current_status = 'Shortlisted') as shortlisted_count,
        (SELECT COUNT(*)::int FROM job_offers jo_count WHERE jo_count.job_id = j.job_id) as offers_count
      FROM jobs j
      LEFT JOIN active_users u ON j.recruiter_id = u.user_id
      LEFT JOIN organizations c ON j.org_id = c.org_id
      WHERE j.recruiter_id = $1 
        AND (j.posted_as_company IS FALSE OR j.posted_as_company IS NULL OR j.org_id IS NULL)
        AND j.is_active = TRUE 
    `;
    const params = [recruiterId];
    let paramCount = 2;

    // Status filter (must come before pagination so we paginate filtered results)
    if (status && status.toUpperCase() !== 'ALL') {
      // Map frontend "IN_REVIEW" to DB "IN REVIEW" (underscore -> space)
      const dbStatus = status.replace(/_/g, ' ').toUpperCase();
      query += ` AND j.status = $${paramCount}`;
      params.push(dbStatus);
      paramCount++;
    }

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

    // Cursor-based pagination
    if (cursor) {
      query += ` AND j.created_at < $${paramCount}`;
      params.push(new Date(cursor));
      paramCount++;
    }

    query += ` ORDER BY j.created_at DESC`;

    // Fetch limit + 1 to determine hasMore
    const fetchLimit = Number(limit) + 1;
    query += ` LIMIT $${paramCount}`;
    params.push(fetchLimit);

    // Counts query — runs in parallel for performance
    const countsQuery = `
      SELECT 
        COUNT(*)::int AS "all",
        COUNT(*) FILTER (WHERE j.status = 'ACTIVE')::int AS "active",
        COUNT(*) FILTER (WHERE j.status = 'CLOSED')::int AS "closed",
        COUNT(*) FILTER (WHERE j.status = 'DRAFT')::int AS "draft",
        COUNT(*) FILTER (WHERE j.status = 'IN REVIEW')::int AS "inReview"
      FROM jobs j
      WHERE j.recruiter_id = $1
        AND (j.posted_as_company IS FALSE OR j.posted_as_company IS NULL OR j.org_id IS NULL)
        AND j.is_active = TRUE
    `;

    const [result, countsResult] = await Promise.all([
      pool.query(query, params),
      pool.query(countsQuery, [recruiterId])
    ]);

    const rows = result.rows;
    const hasMore = rows.length > Number(limit);
    const jobs = hasMore ? rows.slice(0, Number(limit)) : rows;
    const nextCursor = jobs.length > 0 ? jobs[jobs.length - 1].created_at : null;
    const counts = countsResult.rows[0] || { all: 0, active: 0, closed: 0, draft: 0, inReview: 0 };

    res.json({
      jobs,
      nextCursor,
      hasMore,
      counts
    });
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

// getJobApplicants — moved to src/modules/jobs/applications/application.controller.js

exports.deleteJob = async (req, res) => {
  const { id } = req.params;
  const userId = req.user.sub;

  try {
    // Check ownership and existence
    const jobCheck = await pool.query(
      `SELECT org_id, recruiter_id, is_active FROM jobs WHERE job_id = $1`,
      [id]
    );

    if (jobCheck.rowCount === 0 || !jobCheck.rows[0].is_active) {
      return res.status(404).json({ message: "Job not found" });
    }

    const { org_id, recruiter_id } = jobCheck.rows[0];
    const _jobData = { org_id, recruiter_id };

    // Personal job: only the creator can delete
    if (!org_id && recruiter_id !== userId) {
      return res.status(403).json({ message: "Not authorized to delete this job" });
    }

    // Org job: creator or admin-level member (actor context determines)
    if (org_id) {
      try {
        await assertJobActorAccess(req, _jobData, ['POST_JOBS', 'MANAGE_COMPANY']);
      } catch (err) {
        return res.status(err.statusCode || 403).json({ message: err.message || "Not authorized to delete this job" });
      }
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
    experience_min,
    experience_max,
    skills = []
  } = req.body;

  // Sanitize user-generated content
  title = sanitizeContent(title);
  description = sanitizeContent(description);
  industry = sanitizeContent(industry);

  // Sanitize integer fields - default to 0 if empty because DB has NOT NULL constraint
  const safeMinSalary = (minSalary === "" || minSalary === null || minSalary === undefined) ? 0 : parseInt(minSalary);
  const safeMaxSalary = (maxSalary === "" || maxSalary === null || maxSalary === undefined) ? 0 : parseInt(maxSalary);
  const safeExperienceMin = (experience_min === "" || experience_min === null || experience_min === undefined) ? null : parseInt(experience_min);
  const safeExperienceMax = (experience_max === "" || experience_max === null || experience_max === undefined) ? null : parseInt(experience_max);

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // 1. Check ownership
    const checkRes = await client.query(
      `SELECT org_id, recruiter_id, company_name, is_active FROM jobs WHERE job_id = $1`,
      [id]
    );

    if (checkRes.rowCount === 0 || !checkRes.rows[0].is_active) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Job not found" });
    }

    const { org_id: dbOrgId, recruiter_id } = checkRes.rows[0];
    const _jobData = { org_id: dbOrgId, recruiter_id };

    // Personal job: only the creator can update
    if (!dbOrgId && recruiter_id !== userId) {
      await client.query("ROLLBACK");
      return res.status(403).json({ message: "Not authorized to update this job" });
    }

    // Org job: creator or admin-level member (actor context determines)
    if (dbOrgId) {
      try {
        await assertJobActorAccess(req, _jobData, ['POST_JOBS', 'MANAGE_COMPANY'], client);
      } catch (err) {
        await client.query("ROLLBACK");
        return res.status(err.statusCode || 403).json({ message: err.message || "Not authorized to update this job" });
      }
    }

    let resolvedCompanyName = checkRes.rows[0].company_name;
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
        experience_level = $10, about_company = null, industry = $11,
        easy_apply = $12, actively_hiring = $13, org_id = $14,
        posted_as_company = $15, experience_min = $16, experience_max = $17,
        updated_at = NOW()
      WHERE job_id = $18
      RETURNING *
      `,
      [
        title, resolvedCompanyName, location,
        description, safeMinSalary, safeMaxSalary,
        job_type, work_mode, null,
        experience_level, industry,
        easy_apply, actively_hiring, org_id || null,
        !!org_id, safeExperienceMin, safeExperienceMax, id
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

    if (industry) {
      // Automatically add this new industry to the master table
      await client.query(
        `INSERT INTO industries_master (industry_name) 
         VALUES ($1) 
         ON CONFLICT (industry_name) DO NOTHING`,
        [industry]
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
      WITH first_replies AS (
        SELECT 
          ja.application_id,
          ja.applied_at,
          ja.current_status,
          (
            SELECT MIN(ash.changed_at) 
            FROM application_status_history ash 
            WHERE ash.application_id = ja.application_id 
              AND ash.status != 'Applied'
          ) AS first_response_at
        FROM job_applications ja
        JOIN jobs j ON ja.job_id = j.job_id
        WHERE j.recruiter_id = $1
      )
      SELECT 
        COUNT(*)::int AS total_applications,
        COUNT(CASE WHEN current_status != 'Applied' THEN 1 END)::int AS responded_count,
        AVG(first_response_at - applied_at) AS avg_reply_interval
      FROM first_replies
      `,
      [id]
    );

    const data = stats.rows[0] || { total_applications: 0, responded_count: 0, avg_reply_interval: null };
    const total = parseInt(data.total_applications || 0);
    const responded = parseInt(data.responded_count || 0);
    const rate = total > 0 ? Math.round((responded / total) * 100) : 0;
    const typicallyRespondsIn = total > 0 ? (formatReplyTime(data.avg_reply_interval) || "No data") : "No data";

    res.json({
      responseRate: rate,
      totalApplicants: total,
      typicallyRespondsIn: typicallyRespondsIn,
      isActive: true
    });

  } catch (err) {
    console.error("getRecruiterStats error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

// updateApplicationStatus — moved to src/modules/jobs/applications/application.controller.js

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

// reviewApplication — removed (was an alias for updateApplicationStatus)

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

exports.getIndustries = async (req, res) => {
  try {
    const { q } = req.query;
    let query = `SELECT industry_name FROM industries_master`;
    let values = [];

    if (q) {
      query += ` WHERE industry_name ILIKE $1`;
      values.push(`%${q}%`);
    }

    query += ` ORDER BY industry_name ASC LIMIT 50`;

    const result = await pool.query(query, values);

    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching industries:", err);
    res.status(500).json({ error: "Internal server error" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Shared helper: formats a structured AI JD object into a flat markdown string.
// Used by both createJob and generateJD so the output is always identical.
// Double-newline between sections guarantees consistent rendering on all clients.
// ─────────────────────────────────────────────────────────────────────────────
const buildAIDescription = (jdJson) => {
  const addSection = (heading, content) => {
    if (!content) return null;
    const body = Array.isArray(content)
      ? content.map(item => `- ${item}`).join("\n")
      : content;
    return `${heading}\n${body}`;
  };

  const sections = [
    jdJson.summary ? jdJson.summary : null,
    addSection("Description", jdJson.description),
    addSection("Responsibilities", jdJson.responsibilities),
    addSection("Requirements", jdJson.requirements),
    addSection("Preferred Skills", jdJson.preferred_skills),
    addSection("Benefits", jdJson.benefits),
  ].filter(Boolean);

  return sections.join("\n\n").trim();
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
  let { role, company, location, experience, work_type, work_mode, experience_min, experience_max } = req.body;

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

  // experience_min/experience_max are optional, but if the caller (the Create
  // Job form) sends the recruiter's current selection, it must be well-formed.
  // These are never taken from the AI response — see Step 8.
  const hasExperienceMin = experience_min !== undefined && experience_min !== null;
  const hasExperienceMax = experience_max !== undefined && experience_max !== null;

  if (hasExperienceMin && (typeof experience_min !== "number" || !Number.isInteger(experience_min) || experience_min < 0)) {
    return res.status(400).json({
      message: "\"experience_min\" must be a non-negative integer.",
      field: "experience_min",
    });
  }

  if (hasExperienceMax && (typeof experience_max !== "number" || !Number.isInteger(experience_max) || experience_max < 0)) {
    return res.status(400).json({
      message: "\"experience_max\" must be a non-negative integer.",
      field: "experience_max",
    });
  }

  if (hasExperienceMin && hasExperienceMax && experience_max < experience_min) {
    return res.status(400).json({
      message: "\"experience_max\" must be greater than or equal to \"experience_min\".",
      field: "experience_max",
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
      await assertJobActorAccess(req, job, ["POST_JOBS", "MANAGE_COMPANY"], client);
    } else {
      if (job.recruiter_id !== userId) {
        await client.query("ROLLBACK");
        return res.status(403).json({ message: "Unauthorized." });
      }
    }

    // ── Step 4: Redis cache check ─────────────────────────────────────────────
    // Cache key: SHA256(role (normalised) + company_id + context)
    const cacheInput = `${role.toLowerCase()}:${job.org_id || userId}:${company || ''}:${location || ''}:${experience || ''}:${work_type || ''}:${work_mode || ''}`;
    const cacheKey = `jd_gen:${crypto.createHash("sha256").update(cacheInput).digest("hex")}`;

    let cachedResult;
    try {
      cachedResult = await redis.get(cacheKey);
    } catch {
      // Redis unavailable — proceed without cache
      cachedResult = null;
    }

    if (cachedResult) {
      // Cache hit: assemble the full markdown from cached AI fields and update
      // the DB description so the job row is always in sync with what is shown.
      const cachedAI = JSON.parse(cachedResult);
      const fullDescription = buildAIDescription(cachedAI);

      const updatedCacheJobRes = await client.query(
        `UPDATE jobs SET title = $1, description = $2 WHERE job_id = $3 RETURNING *`,
        [role, fullDescription, id]
      );
      await client.query("COMMIT");

      return res.status(200).json({
        message: "Job description generated successfully.",
        job: updatedCacheJobRes.rows[0],
        ai_metadata: { cached: true, model: process.env.AI_MODEL || "gemini-2.5-flash" },
      });
    }

    // ── Step 4.5: Job-based AI Generation Rate Limiting (24 hours) ────
    const rateLimitKey = `ai_rate_limit:job:${id}`;
    let generationCount = 0;
    try {
      generationCount = await redis.incr(rateLimitKey);
      if (generationCount === 1) {
        await redis.expire(rateLimitKey, 24 * 60 * 60);
      }
    } catch (err) {
      console.warn("Redis rate limit failed, bypassing:", err);
    }

    if (generationCount > 3) {
      await client.query("ROLLBACK");
      return res.status(429).json({
        message: "AI generation limit reached. You can only regenerate a Job Description up to 3 times per 24 hours for a single job. Please try again tomorrow.",
      });
    }

    // ── Step 5: Call AI service ───────────────────────────────────────────────
    let generated;
    try {
      generated = await aiService.generateJobDescription({
        role,
        companyName: company || job.company_name || null,
        location,
        experience,
        work_type,
        work_mode,
        jobId: id,
        companyId: job.org_id || null,
        userId: userId,
        orgId: job.org_id || null,
        sourceIp: req.ip,
      });
    } catch (aiErr) {
      // Revert the rate limit counter on failure
      try { await redis.decr(rateLimitKey); } catch (e) { /* ignore */ }

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
      // Revert the rate limit counter on failure
      try { await redis.decr(rateLimitKey); } catch (e) { /* ignore */ }

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
    // Build the same full markdown that createJob produces so the description
    // field is always consistent regardless of which endpoint was called.
    const fullDescription = buildAIDescription(generated);

    const aiRequirements = {
      skills: generated.required_skills_keywords || [],
      education: generated.education || null,
    };

    // experience_min/experience_max are recruiter-authored form fields, not
    // AI output — the Gemini schema no longer generates them (jd-generator.v1.js).
    // Only touch these columns when the caller sent the current form values;
    // otherwise leave whatever is already persisted untouched.
    const AI_FIELD_MAP = {
      title: generated.title || role,
      description: fullDescription,
      ai_extracted_requirements: JSON.stringify(aiRequirements),
    };

    if (hasExperienceMin) AI_FIELD_MAP.experience_min = experience_min;
    if (hasExperienceMax) AI_FIELD_MAP.experience_max = experience_max;

    const setClauses = [];
    const values = [];
    let paramCount = 1;

    for (const [col, val] of Object.entries(AI_FIELD_MAP)) {
      setClauses.push(`${col} = $${paramCount}`);
      values.push(val);
      paramCount++;
    }

    setClauses.push("updated_at = NOW()");

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
    // Same shape as createJob: { message, job } — no separate ai_content.
    // The full markdown is already in job.description.
    return res.status(200).json({
      message: "Job description generated successfully.",
      job: updatedJob,
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