const pool = require("../db/pool");

exports.getAllJobs = async (req, res) => {
  const { title, location, type, mode } = req.query; // Filters

  try {
    let query = `
      SELECT j.*, u.full_name as recruiter_name
      FROM jobs j
      LEFT JOIN users u ON j.recruiter_id = u.user_id
      WHERE j.is_active = TRUE
    `;
    const params = [];
    let paramCount = 1;

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

    // Add other filters as needed

    query += ` ORDER BY j.created_at DESC`;

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error("Get jobs error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

exports.getJobById = async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `
      SELECT j.*, u.full_name as recruiter_name
      FROM jobs j
      LEFT JOIN users u ON j.recruiter_id = u.user_id
      WHERE j.job_id = $1
      `,
      [id]
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
  const recruiterId = req.user.sub;
  const { title, company_name, location, description, salary_range, work_mode, company_type } = req.body;

  try {
    const result = await pool.query(
      `
      INSERT INTO jobs (recruiter_id, title, company_name, location, description, salary_range, work_mode, company_type)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
      `,
      [recruiterId, title, company_name, location, description, salary_range, work_mode, company_type]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("Create job error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

exports.applyJob = async (req, res) => {
  const { id } = req.params; // job_id
  const userId = req.user.sub;

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

    // Create application
    const appResult = await pool.query(
      `
      INSERT INTO job_applications (job_id, applicant_id)
      VALUES ($1, $2)
      RETURNING application_id
      `,
      [id, userId]
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

exports.getMyApplications = async (req, res) => {
  const userId = req.user.sub;

  try {
    const result = await pool.query(
      `
      SELECT ja.*, j.title, j.company_name, j.location, j.work_mode
      FROM job_applications ja
      JOIN jobs j ON ja.job_id = j.job_id
      WHERE ja.applicant_id = $1
      ORDER BY ja.applied_at DESC
      `,
      [userId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("Get my applications error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};
exports.getMyJobs = async (req, res) => {
  const recruiterId = req.user.sub; // logged-in recruiter
  const { title, location, work_mode, company_type } = req.query;

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

    query += ` ORDER BY j.created_at DESC`;

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error("Get my jobs error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};
