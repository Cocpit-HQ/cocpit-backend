const pool = require("../../core/db/pool");
const { buildJobFilters } = require("../../core/utils/jobQueryBuilder");
const { logAudit } = require("../../core/infrastructure/audit.service");
const { checkCompanyPermission } = require("../../core/utils/rbac");

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

    const whereClause = conditions.length > 0 ? `WHERE j.is_active = TRUE AND ${conditions.join(" AND ")}` : `WHERE j.is_active = TRUE`;

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
      LEFT JOIN users u ON j.recruiter_id = u.user_id
      LEFT JOIN companies c ON j.company_id = c.company_id
      ${userId ? "LEFT JOIN job_saves js ON js.job_id = j.job_id AND js.user_id = $1" : ""}
      ${userId ? "LEFT JOIN job_applications ja ON ja.job_id = j.job_id AND ja.applicant_id = $1" : ""}
      ${whereClause}
      ORDER BY j.created_at DESC
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
      LEFT JOIN users u ON j.recruiter_id = u.user_id
      LEFT JOIN companies c ON j.company_id = c.company_id
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
  } catch (err) {
    console.error("Get job error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

exports.createJob = async (req, res) => {
  const userId = req.user.sub;

  const {
    title,
    company_name,
    location,
    description,
    minSalary,
    maxSalary,
    job_type,
    work_mode,
    company_type,
    experience_level,
    about_company,
    industry,
    easy_apply = false,
    actively_hiring = false,

    skills = []
  } = req.body;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // 1. Insert job
    const jobRes = await client.query(
      `
      INSERT INTO jobs
      (
        recruiter_id, title, company_name, company_id, location,
        description, salary_min, salary_max, job_type,
        work_mode, company_type, experience_level,
        about_company, industry, easy_apply, actively_hiring
      )
      VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      RETURNING *
      `,
      [
        userId, title, company_name, req.body.company_id || null, location,
        description, minSalary, maxSalary, job_type,
        work_mode, company_type, experience_level,
        about_company, industry, easy_apply, actively_hiring
      ]
    );

    const job = jobRes.rows[0];

    // 2. Handle skills
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
        VALUES ($1,$2)
        ON CONFLICT DO NOTHING
        `,
        [job.job_id, skillId]
      );
    }

    await client.query("COMMIT");

    // Async Audit Log (after commit is fine, or inside)
    if (job.company_id) {
      // Re-acquire client for audit or use pool? 
      // Since we released client, let's use pool or new client.
      // Actually, let's do it inside transaction before commit for consistency
      // But code structure... let's do it after commit with a new client connection 
      // OR better, move it up before commit.
      // Re-writing this block entirely is risky.
      // Let's just launch it async without awaiting to not block response?
      // No, reliability is key.
      const auditClient = await pool.connect();
      try {
        await logAudit(auditClient, {
          entityId: job.company_id,
          actorId: userId,
          action: 'POST_JOB',
          metadata: {
            type: 'job',
            id: job.job_id,
            title: job.title
          }
        });
      } finally {
        auditClient.release();
      }
    }

    res.status(201).json({
      message: "Job posted successfully",
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
    console.error(err);
    res.status(500).json({ message: "Internal server error" });
  } finally {
    client.release();
  }
};

exports.applyJob = async (req, res) => {
  const { id } = req.params; // job_id
  const userId = req.user.sub;

  // Take other fields from request body
  const { full_name, email, phone, cover_note } = req.body;

  try {
    // Check if job exists
    const jobCheck = await pool.query(`SELECT company_id, recruiter_id FROM jobs WHERE job_id = $1`, [id]);
    if (jobCheck.rowCount === 0) {
      return res.status(404).json({ message: "Job not found" });
    }

    const { company_id, recruiter_id } = jobCheck.rows[0];

    // Check if user is the recruiter
    if (recruiter_id === userId) {
      return res.status(403).json({ message: "You cannot apply to your own job" });
    }

    // Check if user has permission to post jobs for this company
    if (company_id) {
      const canPostJobs = await checkCompanyPermission(pool, company_id, userId, ['POST_JOBS', 'MANAGE_COMPANY']);
      if (canPostJobs) {
        return res.status(403).json({ message: "You cannot apply to a job posted by your company" });
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
      [id, userId, full_name, email, phone, resume_url, cover_note]
    );

    const appId = appResult.rows[0].application_id;

    // Log status history
    await pool.query(
      `INSERT INTO application_status_history (application_id, status) VALUES ($1, 'Applied')`,
      [appId]
    );

    res.status(201).json({ message: "Application submitted successfully", applicationId: appId });
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

    const whereClause = conditions.length > 0 ? `WHERE j.is_active = TRUE AND ${conditions.join(" AND ")}` : `WHERE j.is_active = TRUE`;

    const query = `
      SELECT 
        j.*,
        u.full_name AS recruiter_name,
        ${userId ? '(js.user_id IS NOT NULL) AS "isSaved",' : 'FALSE AS "isSaved",'}
        ${userId ? '(ja.application_id IS NOT NULL) AS "hasApplied",' : 'FALSE AS "hasApplied",'}
        ${userId ? 'ja.current_status AS "applicationStatus",' : 'NULL AS "applicationStatus",'}
        (SELECT COUNT(*)::int FROM job_applications ja_count WHERE ja_count.job_id = j.job_id) as applicants
      FROM jobs j
      LEFT JOIN users u ON j.recruiter_id = u.user_id
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
      LEFT JOIN users u ON j.recruiter_id = u.user_id
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
    const { conditions, values, nextIndex } = buildJobFilters(req.query, 2);

    // Base params: userId is $1
    const params = [userId, ...values];
    let paramCount = nextIndex;

    let baseQuery = `
        FROM job_applications ja
        JOIN jobs j ON ja.job_id = j.job_id
        LEFT JOIN users u ON j.recruiter_id = u.user_id
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
      if (s === 'in past' || s === 'in-past') {
        // Include: Closed jobs OR Rejected applications OR Submitted Tasks
        baseQuery += ` AND (j.is_active = FALSE OR ja.current_status = 'Rejected' OR ja.screening_submitted_at IS NOT NULL)`;
      } else if (s === 'applied') {
        // Include: Active jobs AND Not Rejected AND Task Not Submitted (or not required)
        baseQuery += ` AND j.is_active = TRUE AND ja.current_status != 'Rejected' AND ja.screening_submitted_at IS NULL`;
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
      LEFT JOIN users u ON j.recruiter_id = u.user_id
      WHERE j.recruiter_id = $1 
        AND j.is_active = TRUE 
        AND (j.posted_as_company IS FALSE OR j.posted_as_company IS NULL)
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

  try {
    const stats = await pool.query(`
      SELECT
        COUNT(j.job_id) FILTER (WHERE j.is_active = TRUE AND (j.posted_as_company IS FALSE OR j.posted_as_company IS NULL)) as "activeJobs",
        COUNT(j.job_id) FILTER (WHERE j.posted_as_company IS FALSE OR j.posted_as_company IS NULL) as "totalJobs",
        (
           SELECT COUNT(*) 
           FROM job_applications ja 
           JOIN jobs j2 ON ja.job_id = j2.job_id 
           WHERE j2.recruiter_id = $1
        ) as "totalApplicants"
      FROM jobs j
      WHERE j.recruiter_id = $1 
        AND (j.posted_as_company IS FALSE OR j.posted_as_company IS NULL)
    `, [userId]);

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
      `SELECT company_id, recruiter_id FROM jobs WHERE job_id = $1`,
      [id]
    );

    if (jobCheck.rowCount === 0) {
      return res.status(404).json({ message: "Job not found" });
    }

    const { company_id, recruiter_id } = jobCheck.rows[0];
    let isAuthorized = recruiter_id === userId;

    if (!isAuthorized && company_id) {
      isAuthorized = await checkCompanyPermission(pool, company_id, userId, ['VIEW_APPLICANTS', 'MANAGE_APPLICANTS', 'MANAGE_COMPANY']);
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
      LEFT JOIN users u ON ja.applicant_id = u.user_id
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
      `SELECT company_id, recruiter_id FROM jobs WHERE job_id = $1`,
      [id]
    );

    if (jobCheck.rowCount === 0) {
      return res.status(404).json({ message: "Job not found" });
    }

    const { company_id, recruiter_id } = jobCheck.rows[0];
    let isAuthorized = recruiter_id === userId;

    if (!isAuthorized && company_id) {
      isAuthorized = await checkCompanyPermission(pool, company_id, userId, ['POST_JOBS', 'MANAGE_COMPANY']);
    }

    if (!isAuthorized) {
      return res.status(403).json({ message: "Not authorized to delete this job" });
    }

    // Soft delete by setting is_active = FALSE
    await pool.query(
      `UPDATE jobs SET is_active = FALSE WHERE job_id = $1`,
      [id]
    );

    res.json({ message: "Job deleted successfully" });
  } catch (err) {
    console.error("Delete job error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};


exports.updateJob = async (req, res) => {
  const { id } = req.params;
  const userId = req.user.sub;

  const {
    title,
    company_name,
    location,
    description,
    minSalary,
    maxSalary,
    job_type,
    work_mode,
    company_type,
    experience_level,
    about_company,
    industry,
    easy_apply,
    actively_hiring,
    skills = []
  } = req.body;

  // Sanitize integer fields - default to 0 if empty because DB has NOT NULL constraint
  const safeMinSalary = (minSalary === "" || minSalary === null || minSalary === undefined) ? 0 : parseInt(minSalary);
  const safeMaxSalary = (maxSalary === "" || maxSalary === null || maxSalary === undefined) ? 0 : parseInt(maxSalary);

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // 1. Check ownership
    const checkRes = await client.query(
      `SELECT company_id, recruiter_id FROM jobs WHERE job_id = $1`,
      [id]
    );

    if (checkRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Job not found" });
    }

    const { company_id, recruiter_id } = checkRes.rows[0];
    let isAuthorized = recruiter_id === userId;

    if (!isAuthorized && company_id) {
      isAuthorized = await checkCompanyPermission(client, company_id, userId, ['POST_JOBS', 'MANAGE_COMPANY']);
    }

    if (!isAuthorized) {
      await client.query("ROLLBACK");
      return res.status(403).json({ message: "Not authorized to update this job" });
    }

    // 2. Update job details
    const updateRes = await client.query(
      `
      UPDATE jobs
      SET 
        title = $1, company_name = $2, location = $3,
        description = $4, salary_min = $5, salary_max = $6,
        job_type = $7, work_mode = $8, company_type = $9,
        experience_level = $10, about_company = $11, industry = $12,
        easy_apply = $13, actively_hiring = $14
      WHERE job_id = $15
      RETURNING *
      `,
      [
        title, company_name, location,
        description, safeMinSalary, safeMaxSalary,
        job_type, work_mode, company_type,
        experience_level, about_company, industry,
        easy_apply, actively_hiring, id
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
      LEFT JOIN users u ON j.recruiter_id = u.user_id
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
      SELECT j.recruiter_id, j.company_id, ja.job_id 
      FROM job_applications ja
      JOIN jobs j ON ja.job_id = j.job_id
      WHERE ja.application_id = $1
    `, [id]);

    if (check.rowCount === 0) return res.status(404).json({ message: "Application not found" });

    const { recruiter_id, company_id } = check.rows[0];
    let isAuthorized = recruiter_id === userId;

    if (!isAuthorized && company_id) {
      isAuthorized = await checkCompanyPermission(pool, company_id, userId, ['MANAGE_APPLICANTS', 'MANAGE_COMPANY']);
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

