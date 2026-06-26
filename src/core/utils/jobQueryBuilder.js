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
        experience_min,
        experience_max,
        minSalary,
        maxSalary,
        salary_min,
        salary_max,
        datePosted,
        jobType,
        employment_type,
        workMode,
        work_model,
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

    // ─── Experience level ─────────────
    if (experienceLevel && experienceLevel !== "All Levels") {
        const mappedLevels = [];
        experienceLevel.split(",").map(v => v.trim()).filter(Boolean).forEach(val => {
            const lowerVal = val.toLowerCase();
            if (lowerVal === "fresher") {
                mappedLevels.push("Fresher", "Entry Level");
            } else if (lowerVal === "junior") {
                mappedLevels.push("Junior", "Entry Level");
            } else if (lowerVal === "senior") {
                mappedLevels.push("Senior", "Senior Level");
            } else {
                mappedLevels.push(val);
            }
        });
        
        const uniqueLevels = [...new Set(mappedLevels)];
        if (uniqueLevels.length > 0) {
            applyMultiValue(uniqueLevels.join(","), "j.experience_level");
        }
    }

    if (experience_min !== undefined && experience_max !== undefined) {
        conditions.push(`(j.experience_max IS NULL OR j.experience_max >= $${currentIndex}) AND (j.experience_min IS NULL OR j.experience_min <= $${currentIndex + 1})`);
        values.push(Number(experience_min), Number(experience_max));
        currentIndex += 2;
    } else if (experience_min !== undefined) {
        conditions.push(`(j.experience_max IS NULL OR j.experience_max >= $${currentIndex})`);
        values.push(Number(experience_min));
        currentIndex++;
    } else if (experience_max !== undefined) {
        conditions.push(`(j.experience_min IS NULL OR j.experience_min <= $${currentIndex})`);
        values.push(Number(experience_max));
        currentIndex++;
    }

    // ─── Salary range (overlapping range logic) ───────────────────────────────
    // A job overlaps [minSalary, maxSalary] when:
    //   job.salary_max >= minSalary  AND  job.salary_min <= maxSalary
    // Treat empty string as absent to avoid 0-value false positives.
    const effMinSalary = salary_min !== undefined ? salary_min : minSalary;
    const effMaxSalary = salary_max !== undefined ? salary_max : maxSalary;
    const min = effMinSalary ? Number(effMinSalary) : NaN;
    const max = effMaxSalary ? Number(effMaxSalary) : NaN;

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
    const rawJobType = employment_type || jobType;
    if (rawJobType) {
        const normalizedJobTypes = rawJobType.split(",").map(v => {
            const trimmed = v.trim();
            const lower = trimmed.toLowerCase();
            if (lower === "full time" || lower === "full-time" || lower === "fulltime") return "Full-time";
            if (lower === "part time" || lower === "part-time" || lower === "parttime") return "Part-time";
            return trimmed;
        }).filter(Boolean);
        
        if (normalizedJobTypes.length > 0) {
            applyMultiValue(normalizedJobTypes.join(","), "j.job_type");
        }
    }
    applyMultiValue(work_model || workMode, "j.work_mode");
    applyMultiValue(companyType, "j.company_type");
    const rawIndustry = industry;
    if (rawIndustry) {
        const mappedIndustries = [];
        rawIndustry.split(",").map(v => v.trim()).filter(Boolean).forEach(val => {
            const lowerVal = val.toLowerCase();
            if (lowerVal === "tech" || lowerVal === "technology") {
                mappedIndustries.push("Tech", "Technology");
            } else {
                mappedIndustries.push(val);
            }
        });
        const uniqueIndustries = [...new Set(mappedIndustries)];
        if (uniqueIndustries.length > 0) {
            applyMultiValue(uniqueIndustries.join(","), "j.industry");
        }
    }

    // ─── Org filter (exact match) ─────────────────────────────────────────────
    if (org_id) {
        conditions.push(`j.org_id = $${currentIndex}`);
        values.push(org_id);
        currentIndex++;
    }

    return { conditions, values, nextIndex: currentIndex };
};

module.exports = { buildJobFilters };
