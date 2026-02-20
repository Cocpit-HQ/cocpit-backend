const pool = require("../db/pool");
const { buildJobFilters } = require("../utils/jobQueryBuilder");
const { v4: uuidv4 } = require("uuid"); // Ensure unique ID generation for idempotency checks

exports.createCompanyJob = async (req, res) => {
    const { companyId } = req.params;
    const userId = req.user.sub;
    const idempotencyKey = req.headers["idempotency-key"] || uuidv4();

    const {
        title,
        location,
        description,
        salary_min,
        salary_max,
        salary_currency = "USD",
        salary_period = "YEARLY",
        salary_visibility = "PUBLIC",
        job_type,
        work_mode,
        company_type,
        experience_level,
        about_company,
        industry,
        easy_apply = false,
        actively_hiring = false,
        status = "DRAFT",
        expires_at, // Expected ISO 8601 string or null
        skills = []
    } = req.body;

    if (salary_min && salary_max && Number(salary_min) > Number(salary_max)) {
        return res.status(400).json({ message: "Minimum salary cannot be greater than maximum salary" });
    }

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        // Check idempotency (simplified - relies on unique index in db for exact matches or external Redis normally)
        // Relying on `idx_unique_recent_job_company` for exact dupes active jobs.

        // 1. Fetch Company Name (needed for legacy columns in jobs table)
        const companyRes = await client.query("SELECT name FROM companies WHERE company_id = $1 AND is_deleted = FALSE", [companyId]);
        if (companyRes.rowCount === 0) {
            throw new Error("Company not found or deleted");
        }
        const companyName = companyRes.rows[0].name;

        // 2. Insert job
        const jobRes = await client.query(
            `
      INSERT INTO jobs
      (
        recruiter_id, title, company_name, company_id, location,
        description, salary_min, salary_max, job_type,
        work_mode, company_type, experience_level,
        about_company, industry, easy_apply, actively_hiring,
        posted_as_company, status, expires_at, salary_currency, salary_period, salary_visibility
      )
      VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
      RETURNING *
      `,
            [
                userId, title, companyName, companyId, location,
                description, salary_min, salary_max, job_type,
                work_mode, company_type, experience_level,
                about_company, industry, easy_apply, actively_hiring,
                true, status, expires_at || null, salary_currency, salary_period, salary_visibility
            ]
        );

        const job = jobRes.rows[0];

        // 3. Handle skills
        if (skills.length > 0) {
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
        }

        // 4. Audit Log
        await client.query(
            `INSERT INTO audit_logs (entity_type, entity_id, actor_id, action, metadata)
         VALUES ('COMPANY', $1, $2, 'POST_JOB', $3)`,
            [companyId, userId, JSON.stringify({ type: 'job', id: job.job_id, title: job.title })]
        );

        // 5. Event Outbox
        await client.query(
            `INSERT INTO event_outbox (topic, payload) VALUES ($1, $2)`,
            ['JOB_POSTED', JSON.stringify({ jobId: job.job_id, companyId, status })]
        );

        await client.query("COMMIT");

        res.status(201).json({
            message: "Job created successfully",
            job
        });

    } catch (err) {
        await client.query("ROLLBACK");
        if (err.code === '23505' && err.constraint === 'idx_unique_recent_job_company') {
            return res.status(409).json({ message: "Duplicate active job found for this company." });
        }
        console.error("Create company job error:", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

exports.getCompanyJobs = async (req, res) => {
    const { companyId } = req.params;
    const { scope = 'public', limit = 10, cursor } = req.query;

    // For 'internal' scope, the route middleware should already guarantee they are a member.
    // We enforce the query filter.

    try {
        let conditions = ["j.company_id = $1"];
        let params = [companyId];
        let paramCount = 2;

        if (scope === 'public') {
            // Public fetching requires company to be verified and not suspended
            const companyCheck = await pool.query("SELECT verification_status FROM companies WHERE company_id = $1 AND is_deleted = FALSE", [companyId]);
            if (companyCheck.rowCount === 0) {
                return res.status(404).json({ message: "Company not found" });
            }
            if (companyCheck.rows[0].verification_status === 'SUSPENDED') {
                return res.status(403).json({ message: "Company is suspended" });
            }

            // Only ACTIVE jobs that are not expired
            conditions.push("j.status = 'ACTIVE'");
            conditions.push("(j.expires_at IS NULL OR j.expires_at > NOW())");
        } else if (scope === 'internal') {
            // Allow all statuses, internal members only
        } else {
            return res.status(400).json({ message: "Invalid scope parameter. Use 'public' or 'internal'." });
        }

        if (cursor) {
            conditions.push(`j.created_at < $${paramCount}`);
            params.push(new Date(cursor));
            paramCount++;
        }

        const limitClause = `LIMIT $${paramCount}`;
        params.push(Number(limit));

        const whereClause = `WHERE ${conditions.join(" AND ")}`;

        const query = `
            SELECT 
                j.*,
                u.full_name AS recruiter_name,
                (SELECT COUNT(*)::int FROM job_applications ja_count WHERE ja_count.job_id = j.job_id) as applicants
            FROM jobs j
            LEFT JOIN users u ON j.recruiter_id = u.user_id
            ${whereClause}
            ORDER BY j.created_at DESC
            ${limitClause}
        `;

        const result = await pool.query(query, params);
        res.status(200).json(result.rows);

    } catch (err) {
        console.error("Get company jobs error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.updateCompanyJob = async (req, res) => {
    const { companyId, jobId } = req.params;
    const userId = req.user.sub;

    const {
        title, location, description,
        salary_min, salary_max, salary_currency, salary_period, salary_visibility,
        job_type, work_mode, experience_level, industry, easy_apply, actively_hiring,
        status, expires_at
    } = req.body;

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        // 1. Verify Job Ownership
        const jobCheck = await client.query("SELECT * FROM jobs WHERE job_id = $1 AND company_id = $2 FOR UPDATE", [jobId, companyId]);
        if (jobCheck.rowCount === 0) return res.status(404).json({ message: "Job not found in this company." });

        const oldJobData = jobCheck.rows[0];

        // 2. State Transition Rules Check
        if (status && oldJobData.status !== status) {
            const validTransitions = {
                'DRAFT': ['ACTIVE', 'CLOSED'],
                'ACTIVE': ['CLOSED', 'EXPIRED'],
                'CLOSED': ['ACTIVE'], // Reopen
                'EXPIRED': [], // Disallowed to reactivate directly
                'REJECTED': [] // Disallowed
            };
            if (!validTransitions[oldJobData.status]?.includes(status)) {
                return res.status(400).json({ message: `Invalid status transition from ${oldJobData.status} to ${status}` });
            }
        }

        // 3. Update Job
        const updateRes = await client.query(`
            UPDATE jobs
            SET title = COALESCE($1, title),
                location = COALESCE($2, location),
                description = COALESCE($3, description),
                salary_min = COALESCE($4, salary_min),
                salary_max = COALESCE($5, salary_max),
                salary_currency = COALESCE($6, salary_currency),
                salary_period = COALESCE($7, salary_period),
                salary_visibility = COALESCE($8, salary_visibility),
                job_type = COALESCE($9, job_type),
                work_mode = COALESCE($10, work_mode),
                experience_level = COALESCE($11, experience_level),
                industry = COALESCE($12, industry),
                easy_apply = COALESCE($13, easy_apply),
                actively_hiring = COALESCE($14, actively_hiring),
                status = COALESCE($15, status),
                expires_at = COALESCE($16, expires_at)
            WHERE job_id = $17
            RETURNING *
        `, [
            title, location, description, salary_min, salary_max, salary_currency, salary_period, salary_visibility,
            job_type, work_mode, experience_level, industry, easy_apply, actively_hiring, status, expires_at, jobId
        ]);

        const updatedJob = updateRes.rows[0];

        // 4. Job Versioning
        await client.query(`
            INSERT INTO job_versions (job_id, changed_by, previous_data)
            VALUES ($1, $2, $3)
        `, [jobId, userId, JSON.stringify(oldJobData)]);

        // 5. Audit Log
        await client.query(
            `INSERT INTO audit_logs (entity_type, entity_id, actor_id, action, metadata)
             VALUES ('COMPANY', $1, $2, 'UPDATE_JOB', $3)`,
            [companyId, userId, JSON.stringify({ jobId, newStatus: updatedJob.status })]
        );

        // 6. Event Outbox
        await client.query(
            `INSERT INTO event_outbox (topic, payload) VALUES ($1, $2)`,
            ['JOB_UPDATED', JSON.stringify({ jobId, companyId, status: updatedJob.status })]
        );

        await client.query("COMMIT");

        res.status(200).json({ message: "Job updated successfully", job: updatedJob });
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Update company job error:", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

exports.deleteCompanyJob = async (req, res) => {
    // Soft delete equivalent
    req.body.status = 'CLOSED';
    return exports.updateCompanyJob(req, res);
};
