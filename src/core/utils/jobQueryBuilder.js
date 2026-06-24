/**
 * Builds parameterized SQL filter conditions for the jobs table (alias `j`).
 *
 * Multi-value filters (jobType, workMode, companyType, industry, experienceLevel)
 * accept comma-separated values and produce a SQL ANY(ARRAY[...]) OR filter.
 * Example: `?jobType=Full-time,Part-time` → `j.job_type = ANY(ARRAY[$n, $n+1])`
 *
 * Boolean filters (easyApply, activelyHiring) accept "true" | "false".
 * Omitting the param applies no filter (all jobs returned regardless of value).
 *
 * NOTE: `status` is intentionally NOT a public filter.
 * The whereClause in each controller enforces j.status = 'ACTIVE' directly.
 * Exposing status as a filter param would let anyone query DRAFT/CLOSED/etc. jobs.
 *
 * @param {object} params         - Typically req.query
 * @param {number} paramCountStart - The $N offset to begin from (default 1)
 * @returns {{ conditions: string[], values: any[], nextIndex: number }}
 */
const buildJobFilters = (params, paramCountStart = 1) => {
    const {
        title,
        q,
        search,
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
        org_id,
    } = params;

    let conditions = [];
    let values = [];
    let currentIndex = paramCountStart;

    // ─── Helper: multi-value OR filter (comma-separated input) ───────────────
    // Single value  → exact match:       j.col = $n
    // Multiple vals → ANY match:         j.col::text = ANY(ARRAY[$n, $n+1, ...])
    // NOTE: The ::text cast on the column is required for PostgreSQL enum columns.
    // Without it, pg infers the ARRAY as text[] and throws:
    //   "operator does not exist: <enum_type> = text"
    // Single-value path keeps the bare column reference since pg auto-casts
    // unknown-typed parameters against enum columns without issue.
    const applyMultiValue = (rawValue, column) => {
        if (!rawValue) return;
        const vals = rawValue.split(",").map(v => v.trim()).filter(Boolean);
        if (vals.length === 0) return;
        if (vals.length === 1) {
            conditions.push(`${column} = $${currentIndex}`);
            values.push(vals[0]);
            currentIndex++;
        } else {
            const placeholders = vals.map((_, i) => `$${currentIndex + i}`).join(", ");
            conditions.push(`${column}::text = ANY(ARRAY[${placeholders}])`);
            values.push(...vals);
            currentIndex += vals.length;
        }
    };

    // ─── Text search ─────────────────────────────────────────────────────────
    // q / search / title are aliases — first truthy value wins
    const searchQuery = q || search || title;
    if (searchQuery) {
        conditions.push(`(j.title ILIKE $${currentIndex} OR j.company_name ILIKE $${currentIndex})`);
        values.push(`%${searchQuery}%`);
        currentIndex++;
    }

    // ─── Location ────────────────────────────────────────────────────────────
    if (location) {
        conditions.push(`j.location ILIKE $${currentIndex}`);
        values.push(`%${location}%`);
        currentIndex++;
    }

    // ─── Boolean toggles ─────────────────────────────────────────────────────
    // "true"  → filter for true
    // "false" → filter for false
    // omitted → no filter applied (show all)
    if (easyApply === "true") {
        conditions.push(`j.easy_apply = TRUE`);
    } else if (easyApply === "false") {
        conditions.push(`j.easy_apply = FALSE`);
    }

    if (activelyHiring === "true") {
        conditions.push(`j.actively_hiring = TRUE`);
    } else if (activelyHiring === "false") {
        conditions.push(`j.actively_hiring = FALSE`);
    }

    // ─── Experience level (multi-value; "All Levels" is a no-op) ─────────────
    if (experienceLevel && experienceLevel !== "All Levels") {
        applyMultiValue(experienceLevel, "j.experience_level");
    }

    // ─── Salary range (overlapping range logic) ───────────────────────────────
    // A job overlaps [minSalary, maxSalary] when:
    //   job.salary_max >= minSalary  AND  job.salary_min <= maxSalary
    // Treat empty string as absent to avoid 0-value false positives.
    const min = minSalary ? Number(minSalary) : NaN;
    const max = maxSalary ? Number(maxSalary) : NaN;

    if (!isNaN(min) && !isNaN(max)) {
        conditions.push(`j.salary_max >= $${currentIndex} AND j.salary_min <= $${currentIndex + 1}`);
        values.push(min, max);
        currentIndex += 2;
    } else if (!isNaN(min)) {
        conditions.push(`j.salary_max >= $${currentIndex}`);
        values.push(min);
        currentIndex++;
    } else if (!isNaN(max)) {
        conditions.push(`j.salary_min <= $${currentIndex}`);
        values.push(max);
        currentIndex++;
    }

    // ─── Date posted ──────────────────────────────────────────────────────────
    // Case-insensitive lookup; unrecognised values are silently ignored.
    // Accepted values and their day offsets:
    if (datePosted) {
        const DATE_POSTED_DAYS = {
            "past 24 hours": 1,
            "today":         1,
            "past week":     7,
            "last 7 days":   7,
            "past month":    30,
            "last 30 days":  30,
        };
        const daysAgo = DATE_POSTED_DAYS[datePosted.toLowerCase().trim()];
        if (daysAgo !== undefined) {
            const fromDate = new Date();
            fromDate.setDate(fromDate.getDate() - daysAgo);
            conditions.push(`j.created_at >= $${currentIndex}`);
            values.push(fromDate);
            currentIndex++;
        }
    }

    // ─── Enum filters (all multi-value) ───────────────────────────────────────
    applyMultiValue(jobType, "j.job_type");
    applyMultiValue(workMode, "j.work_mode");
    applyMultiValue(companyType, "j.company_type");
    applyMultiValue(industry, "j.industry");

    // ─── Org filter (exact match) ─────────────────────────────────────────────
    if (org_id) {
        conditions.push(`j.org_id = $${currentIndex}`);
        values.push(org_id);
        currentIndex++;
    }

    return { conditions, values, nextIndex: currentIndex };
};

module.exports = { buildJobFilters };
