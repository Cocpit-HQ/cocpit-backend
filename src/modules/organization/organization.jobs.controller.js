const pool = require("../../core/db/pool");
const { buildJobFilters } = require("../../core/utils/jobQueryBuilder");
const { v4: uuidv4 } = require("uuid"); // Ensure unique ID generation for idempotency checks
const { notifyCompanyFollowers } = require("../../services/notification.service");

exports.createOrganizationJob = async (req, res) => {
    const { orgId: companyId } = req.params;
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
        experience_level,
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

        // 1. Fetch Organization Name (needed for legacy columns in jobs table)
        const companyRes = await client.query("SELECT name FROM organizations WHERE org_id = $1 AND is_deleted = FALSE", [companyId]);
        if (companyRes.rowCount === 0) {
            throw new Error("Organization not found or deleted");
        }
        const companyName = companyRes.rows[0].name;

        // 2. Insert job
        const jobRes = await client.query(
            `
      INSERT INTO jobs
      (
        recruiter_id, title, company_name, org_id, location,
        description, salary_min, salary_max, job_type,
        work_mode, null, experience_level,
        null, industry, easy_apply, actively_hiring,
        posted_as_company, status, expires_at, salary_currency, salary_period, salary_visibility
      )
      VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
      RETURNING *
      `,
            [
                userId, title, companyName, companyId, location,
                description, salary_min, salary_max, job_type,
                work_mode, null, experience_level,
                null, industry, easy_apply, actively_hiring,
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
         VALUES ('ORGANIZATION', $1, $2, 'POST_JOB', $3)`,
            [companyId, userId, JSON.stringify({ type: 'job', id: job.job_id, title: job.title })]
        );

        // 5. Event Outbox
        await client.query(
            `INSERT INTO event_outbox (topic, payload) VALUES ($1, $2)`,
            ['JOB_POSTED', JSON.stringify({ jobId: job.job_id, companyId, status })]
        );

        await client.query("COMMIT");

        // 6. Notify followers with 'jobs' preference enabled (fire-and-forget, after commit)
        if (status === "ACTIVE") {
            notifyCompanyFollowers(companyId, "jobs", {
                type: "company_job",
                text: `${companyName} posted a new job: ${title}`,
                referenceId: job.job_id,
                metadata: { job_title: title, location: location || null },
            }).catch(err => console.error("Job notification error:", err));
        }

        res.status(201).json({
            message: "Job created successfully",
            job
        });

    } catch (err) {
        await client.query("ROLLBACK");
        if (err.code === '23505' && err.constraint === 'idx_unique_recent_job_company') {
            return res.status(409).json({ message: "Duplicate active job found for this organization." });
        }
        console.error("Create organization job error:", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

exports.getOrganizationJobs = async (req, res) => {
    const { orgId: companyId } = req.params;
    const { scope = 'public', limit = 10, cursor, status } = req.query;

    // For 'internal' scope, the route middleware should already guarantee they are a member.
    // We enforce the query filter.

    try {
        let conditions = ["j.org_id = $1", "j.is_active = TRUE"];
        let params = [companyId];
        let paramCount = 2;

        if (scope === 'public') {
            // Public fetching requires company to be verified and not suspended
            const companyCheck = await pool.query("SELECT verification_status FROM organizations WHERE org_id = $1 AND is_deleted = FALSE", [companyId]);
            if (companyCheck.rowCount === 0) {
                return res.status(404).json({ message: "Organization not found" });
            }
            if (companyCheck.rows[0].verification_status === 'SUSPENDED') {
                return res.status(403).json({ message: "Organization is suspended" });
            }

            // Only ACTIVE jobs that are not expired
            conditions.push("j.status = 'ACTIVE'");
            conditions.push("(j.expires_at IS NULL OR j.expires_at > NOW())");
        } else if (scope === 'internal') {
            // Allow all statuses, internal members only
            if (!req.user || !req.user.sub) {
                return res.status(401).json({ message: "Unauthorized" });
            }
            const memberCheck = await pool.query(
                "SELECT 1 FROM organization_members WHERE org_id = $1 AND user_id = $2 AND status = 'ACTIVE'",
                [companyId, req.user.sub]
            );
            if (memberCheck.rowCount === 0) {
                return res.status(403).json({ message: "Forbidden: You are not a member of this organization" });
            }

            // Status filter for internal scope
            if (status && status.toUpperCase() !== 'ALL') {
                const dbStatus = status.replace(/_/g, ' ').toUpperCase();
                conditions.push(`j.status = $${paramCount}`);
                params.push(dbStatus);
                paramCount++;
            }
        } else {
            return res.status(400).json({ message: "Invalid scope parameter. Use 'public' or 'internal'." });
        }

        if (cursor) {
            conditions.push(`j.created_at < $${paramCount}`);
            params.push(new Date(cursor));
            paramCount++;
        }

        // Fetch limit + 1 to determine hasMore
        const fetchLimit = Number(limit) + 1;
        const limitClause = `LIMIT $${paramCount}`;
        params.push(fetchLimit);

        const whereClause = `WHERE ${conditions.join(" AND ")}`;

        const query = `
            SELECT 
                j.*,
                u.full_name AS recruiter_name,
                (SELECT COUNT(*)::int FROM job_applications ja_count WHERE ja_count.job_id = j.job_id) as applicants_count,
                (SELECT COUNT(*)::int FROM job_applications ja_count WHERE ja_count.job_id = j.job_id AND ja_count.current_status = 'Shortlisted') as shortlisted_count,
                (SELECT COUNT(*)::int FROM job_offers jo_count WHERE jo_count.job_id = j.job_id) as offers_count
            FROM jobs j
            LEFT JOIN active_users u ON j.recruiter_id = u.user_id
            ${whereClause}
            ORDER BY j.created_at DESC
            ${limitClause}
        `;

        if (scope === 'internal') {
            // Counts query for internal scope — runs in parallel
            const countsQuery = `
                SELECT 
                    COUNT(*)::int AS "all",
                    COUNT(*) FILTER (WHERE j.status = 'ACTIVE')::int AS "active",
                    COUNT(*) FILTER (WHERE j.status = 'CLOSED')::int AS "closed",
                    COUNT(*) FILTER (WHERE j.status = 'DRAFT')::int AS "draft",
                    COUNT(*) FILTER (WHERE j.status = 'IN REVIEW')::int AS "inReview"
                FROM jobs j
                WHERE j.org_id = $1
                    AND j.is_active = TRUE
            `;

            const [result, countsResult] = await Promise.all([
                pool.query(query, params),
                pool.query(countsQuery, [companyId])
            ]);

            const rows = result.rows;
            const hasMore = rows.length > Number(limit);
            const jobs = hasMore ? rows.slice(0, Number(limit)) : rows;
            const nextCursor = jobs.length > 0 ? jobs[jobs.length - 1].created_at : null;
            const counts = countsResult.rows[0] || { all: 0, active: 0, closed: 0, draft: 0, inReview: 0 };

            return res.status(200).json({
                jobs,
                nextCursor,
                hasMore,
                counts
            });
        }

        // Public scope — keep flat array response to avoid breaking changes
        const result = await pool.query(query, params);
        const rows = result.rows;
        const publicJobs = rows.length > Number(limit) ? rows.slice(0, Number(limit)) : rows;
        res.status(200).json(publicJobs);

    } catch (err) {
        console.error("Get organization jobs error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.updateOrganizationJob = async (req, res) => {
    const { orgId: companyId, jobId } = req.params;
    const userId = req.user.sub;

    const {
        title, location, description,
        salary_min, salary_max, salary_currency, salary_period, salary_visibility,
        job_type, work_mode, experience_level, industry, easy_apply, actively_hiring,
        status, expires_at, is_active
    } = req.body;

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        // 1. Verify Job Ownership
        const jobCheck = await client.query("SELECT * FROM jobs WHERE job_id = $1 AND org_id = $2 FOR UPDATE", [jobId, companyId]);
        if (jobCheck.rowCount === 0) return res.status(404).json({ message: "Job not found in this organization." });

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
                expires_at = COALESCE($16, expires_at),
                is_active = COALESCE($17, is_active)
            WHERE job_id = $18
            RETURNING *
        `, [
            title, location, description, salary_min, salary_max, salary_currency, salary_period, salary_visibility,
            job_type, work_mode, experience_level, industry, easy_apply, actively_hiring, status, expires_at, is_active, jobId
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
             VALUES ('ORGANIZATION', $1, $2, 'UPDATE_JOB', $3)`,
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
        console.error("Update organization job error:", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

exports.deleteOrganizationJob = async (req, res) => {
    // Soft delete equivalent
    req.body.status = 'CLOSED';
    req.body.is_active = false;
    return exports.updateOrganizationJob(req, res);
};
