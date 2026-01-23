const pool = require("../db/pool");

exports.getAllJobs = async (req, res) => {
  const {
    title,
    location,
    easyApply,
    activelyHiring,
    experienceLevel,
    minSalary,
    maxSalary,
    datePosted,
    jobType,
    workMode,
    companyType,
    industry,
  } = req.query;
  const userId = req.user?.sub; // optional (works for guest also)

  try {
    let query = `
      SELECT 
        j.*,
        u.full_name AS recruiter_name,
        ${userId
        ? '(js.user_id IS NOT NULL) AS "isSaved",'
        : 'FALSE AS "isSaved",'
      }
        ${userId
        ? '(ja.application_id IS NOT NULL) AS "hasApplied",'
        : 'FALSE AS "hasApplied",'
      }
        ${userId
        ? 'ja.current_status AS "applicationStatus"'
        : 'NULL AS "applicationStatus"'
      }
      FROM jobs j
      LEFT JOIN users u ON j.recruiter_id = u.user_id
      ${userId
        ? "LEFT JOIN job_saves js ON js.job_id = j.job_id AND js.user_id = $1"
        : ""
      }
      ${userId
        ? "LEFT JOIN job_applications ja ON ja.job_id = j.job_id AND ja.applicant_id = $1"
        : ""
      }
      WHERE j.is_active = TRUE
    `;

    const params = [];
    let paramCount = 1;

    if (userId) {
      params.push(userId);
      paramCount++;
    }

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
    if (workMode) {
      query += ` AND j.work_mode = $${paramCount}`;
      params.push(workMode);
      paramCount++;
    }
    if (companyType) {
      query += ` AND j.company_type = $${paramCount}`;
      params.push(companyType);
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
        ${userId ? '(js.user_id IS NOT NULL) AS "isSaved",' : 'FALSE AS "isSaved",'}
        ${userId ? '(ja.application_id IS NOT NULL) AS "hasApplied",' : 'FALSE AS "hasApplied",'}
        ${userId ? 'ja.current_status AS "applicationStatus"' : 'NULL AS "applicationStatus"'}
      FROM jobs j
      LEFT JOIN users u ON j.recruiter_id = u.user_id
      ${userId ? 'LEFT JOIN job_saves js ON js.job_id = j.job_id AND js.user_id = $2' : ''}
      ${userId ? 'LEFT JOIN job_applications ja ON ja.job_id = j.job_id AND ja.applicant_id = $2' : ''}
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
        recruiter_id, title, company_name, location,
        description, salary_min,salary_max, job_type,
        work_mode, company_type, experience_level,
        about_company,industry, easy_apply, actively_hiring
      )
      VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      RETURNING *
      `,
      [
        userId, title, company_name, location,
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
        INSERT INTO skills(name)
        VALUES ($1)
        ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
        RETURNING skill_id
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
    const jobCheck = await pool.query(`SELECT 1 FROM jobs WHERE job_id = $1`, [id]);
    if (jobCheck.rowCount === 0) {
      return res.status(404).json({ message: "Job not found" });
    }

    // Check if already applied
    const existing = await pool.query(
      `SELECT 1 FROM job_applications WHERE job_id = $1 AND applicant_id = $2`,
      [id, userId]
    );
    if (existing.rowCount > 0) {
      return res.status(409).json({ message: "Already applied to this job" });
    }

    // Resume file URL from Cloudinary
    if (!req.file) {
      return res.status(400).json({ message: "Resume is required" });
    }
    const resume_url = req.file.path;

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
  const {
    title,
    location,
    easyApply,
    activelyHiring,
    experienceLevel,
    minSalary,
    maxSalary,
    datePosted,
    jobType,
    workMode,
    companyType,
    industry,
  } = req.query;
  const userId = req.user?.sub; // optional, if user is logged in

  try {
    // Base query
    let query = `
      SELECT 
        j.*,
        u.full_name AS recruiter_name,
        ${userId
        ? '(js.user_id IS NOT NULL) AS "isSaved",'
        : 'FALSE AS "isSaved",'
      }
        ${userId
        ? '(ja.application_id IS NOT NULL) AS "hasApplied",'
        : 'FALSE AS "hasApplied",'
      }
        ${userId
        ? 'ja.current_status AS "applicationStatus"'
        : 'NULL AS "applicationStatus"'
      }
      FROM jobs j
      LEFT JOIN users u ON j.recruiter_id = u.user_id
      ${userId
        ? "LEFT JOIN job_saves js ON js.job_id = j.job_id AND js.user_id = $1"
        : ""
      }
      ${userId
        ? "LEFT JOIN job_applications ja ON ja.job_id = j.job_id AND ja.applicant_id = $1"
        : ""
      }
      WHERE j.is_active = TRUE AND j.is_offer = TRUE
    `;

    const params = [];
    let paramCount = 1;

    // If user is logged in, add userId for isSaved check
    if (userId) {
      params.push(userId);
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
    if (workMode) {
      query += ` AND j.work_mode = $${paramCount}`;
      params.push(workMode);
      paramCount++;
    }
    if (companyType) {
      query += ` AND j.company_type = $${paramCount}`;
      params.push(companyType);
      paramCount++;
    }
    if (industry) {
      query += ` AND j.industry = $${paramCount}`;
      params.push(industry);
      paramCount++;
    }

    // Order by newest first
    query += ` ORDER BY j.created_at DESC`;

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
  const {
    location,
    easyApply,
    activelyHiring,
    experienceLevel,
    minSalary,
    maxSalary,
    datePosted,
    jobType,
    workMode,
    companyType,
    industry,
  } = req.query;

  try {
    let query = `
      SELECT j.*, u.full_name AS recruiter_name, TRUE AS "isSaved"
      FROM job_saves js
      JOIN jobs j ON js.job_id = j.job_id
      LEFT JOIN users u ON j.recruiter_id = u.user_id
      WHERE js.user_id = $1 AND j.is_active = TRUE
      `;
    const params = [userId];
    let paramCount = 2;

    if (location) {
      query += ` AND j.location ILIKE $${paramCount}`;
      params.push(`%${location}%`);
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
    if (workMode) {
      query += ` AND j.work_mode = $${paramCount}`;
      params.push(workMode);
      paramCount++;
    }
    if (companyType) {
      query += ` AND j.company_type = $${paramCount}`;
      params.push(companyType);
      paramCount++;
    }
    if (industry) {
      query += ` AND j.industry = $${paramCount}`;
      params.push(industry);
      paramCount++;
    }

    query += ` ORDER BY js.saved_at DESC`;

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
  const {
    status,
    location,
    easyApply,
    activelyHiring,
    experienceLevel,
    minSalary,
    maxSalary,
    datePosted,
    jobType,
    workMode,
    companyType,
    industry,
  } = req.query;

  const allowedStatus = ['applied', 'in progress', 'in past', 'saved'];

  if (status && !allowedStatus.includes(status.toLowerCase())) {
    return res.status(400).json({ message: "Invalid status" });
  }

  if (status?.toLowerCase() === 'saved') {
    return exports.getMySavedJobs(req, res);
  }

  try {
    let query;
    const params = [userId];
    let paramCount = 2;

    let baseQuery = `
        FROM job_applications ja
        JOIN jobs j ON ja.job_id = j.job_id
        LEFT JOIN users u ON j.recruiter_id = u.user_id
        LEFT JOIN job_saves js ON j.job_id = js.job_id AND js.user_id = $1
        WHERE ja.applicant_id = $1
    `;

    // ... (filters logic remains same, just append to baseQuery) ...

    if (status) {
      if (status.toLowerCase() === 'in past') {
        baseQuery += ` AND j.is_active = false`;
      } else if (status.toLowerCase() === 'in progress') {
        baseQuery += ` AND ja.current_status = ANY($${paramCount++})`;
        params.push(['Under Review', 'Interview']);
      } else if (status.toLowerCase() === 'applied') {
        baseQuery += ` AND ja.current_status = 'Applied'`;
      }
    }

    // ... (rest of filtering logic) ...

    query = `
        SELECT 
          j.*, 
          u.full_name AS recruiter_name,
          (js.user_id IS NOT NULL) AS "isSaved",
          TRUE AS "hasApplied",
          ja.current_status AS "applicationStatus",
          ja.applied_at
        ${baseQuery}
        ORDER BY ja.applied_at DESC
    `;

    if (location) {
      baseQuery += ` AND j.location ILIKE $${paramCount}`;
      params.push(`%${location}%`);
      paramCount++;
    }

    if (easyApply === "true") {
      baseQuery += ` AND j.easy_apply = TRUE`;
    }
    if (activelyHiring === "true") {
      baseQuery += ` AND j.actively_hiring = TRUE`;
    }
    if (experienceLevel) {
      baseQuery += ` AND j.experience_level = $${paramCount}`;
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

      baseQuery += `
    AND j.salary_max >= $${paramCount}
    AND j.salary_min <= $${paramCount + 1}
  `;
      params.push(min, max);
      paramCount += 2;

    } else if (!isNaN(min)) {
      baseQuery += ` AND j.salary_max >= $${paramCount}`;
      params.push(min);
      paramCount++;

    } else if (!isNaN(max)) {
      baseQuery += ` AND j.salary_min <= $${paramCount}`;
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
        baseQuery += ` AND j.created_at >= $${paramCount}`;
        params.push(fromDate);
        paramCount++;
      }
    }
    if (jobType) {
      baseQuery += ` AND j.job_type = $${paramCount}`;
      params.push(jobType);
      paramCount++;
    }
    if (workMode) {
      baseQuery += ` AND j.work_mode = $${paramCount}`;
      params.push(workMode);
      paramCount++;
    }
    if (companyType) {
      baseQuery += ` AND j.company_type = $${paramCount}`;
      params.push(companyType);
      paramCount++;
    }
    if (industry) {
      baseQuery += ` AND j.industry = $${paramCount}`;
      params.push(industry);
      paramCount++;
    }

    query = `
        SELECT 
          j.*, 
          u.full_name AS recruiter_name,
          (js.user_id IS NOT NULL) AS "isSaved",
          TRUE AS "hasApplied",
          ja.current_status AS "applicationStatus",
          ja.applied_at
        ${baseQuery}
        ORDER BY ja.applied_at DESC
    `;

    const result = await pool.query(query, params);

    return res.json(result.rows);

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
      SELECT j.*, u.full_name AS recruiter_name
      FROM jobs j
      LEFT JOIN users u ON j.recruiter_id = u.user_id
      WHERE j.recruiter_id = $1
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
