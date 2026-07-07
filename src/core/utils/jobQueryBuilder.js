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
        salaryRanges,
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
    let expCondition = null;
    if (experienceLevel && experienceLevel !== "All Levels") {
        const mappedLevels = [];
        experienceLevel.split(",").map(v => v.trim()).filter(Boolean).forEach(val => {
            const lowerVal = val.toLowerCase();
            if (lowerVal === "fresher") {
                mappedLevels.push("Fresher");
            } else if (lowerVal === "junior") {
                mappedLevels.push("Junior (1-3 yrs)");
            } else if (lowerVal === "mid-level") {
                mappedLevels.push("Mid-level (3-5 yrs)");
            } else if (lowerVal === "senior") {
                mappedLevels.push("Senior (5+ yrs)");
            } else {
                mappedLevels.push(val);
            }
        });
        
        const uniqueLevels = [...new Set(mappedLevels)];
        if (uniqueLevels.length > 0) {
            if (uniqueLevels.length === 1) {
                expCondition = `j.experience_label = $${currentIndex}`;
                values.push(uniqueLevels[0]);
                currentIndex++;
            } else {
                const placeholders = uniqueLevels.map((_, i) => `$${currentIndex + i}`).join(", ");
                expCondition = `j.experience_label::text = ANY(ARRAY[${placeholders}])`;
                values.push(...uniqueLevels);
                currentIndex += uniqueLevels.length;
            }
        }
    }

    let numCondition = null;
    if (experience_min !== undefined && experience_max !== undefined) {
        numCondition = `(COALESCE(j.experience_max, j.experience_min) >= $${currentIndex} AND COALESCE(j.experience_min, j.experience_max) <= $${currentIndex + 1})`;
        values.push(Number(experience_min), Number(experience_max));
        currentIndex += 2;
    } else if (experience_min !== undefined) {
        numCondition = `(COALESCE(j.experience_max, j.experience_min) >= $${currentIndex})`;
        values.push(Number(experience_min));
        currentIndex++;
    } else if (experience_max !== undefined) {
        numCondition = `(COALESCE(j.experience_min, j.experience_max) <= $${currentIndex})`;
        values.push(Number(experience_max));
        currentIndex++;
    }

    if (expCondition && numCondition) {
        conditions.push(`(${expCondition} OR ${numCondition})`);
    } else if (expCondition) {
        conditions.push(expCondition);
    } else if (numCondition) {
        conditions.push(numCondition);
    }

    // ─── Named salary range filter (multi-select, OR logic) ──────────────────
    // Accepts `salaryRanges` as a comma-separated list of named ranges.
    // Example: `?salaryRanges=Under 3L,10L+`
    // Each named range is expanded into numeric bounds, then combined via OR so
    // a job is included if its salary overlaps ANY of the selected ranges.
    //
    // Range map (INR):
    //   Under 3L  → salary_max <= 300,000
    //   3L-5L     → salary_min <= 500,000  AND salary_max >= 300,000
    //   6L-10L    → salary_min <= 1,000,000 AND salary_max >= 600,000
    //   10L+      → salary_min >= 1,000,000
    const SALARY_RANGE_MAP = {
        "under 3l":  { max: 300000 },
        "3l-5l":     { min: 300000, max: 500000 },
        "6l-10l":    { min: 600000, max: 1000000 },
        "10l+":      { min: 1000000 },
    };

    if (salaryRanges) {
        const selectedRanges = salaryRanges
            .split(",")
            .map(v => v.trim().toLowerCase())
            .filter(Boolean)
            .map(v => SALARY_RANGE_MAP[v])
            .filter(Boolean);

        if (selectedRanges.length > 0) {
            const rangeClauses = selectedRanges.map(range => {
                if (range.min !== undefined && range.max !== undefined) {
                    // Overlapping range: job overlaps [min, max] when
                    //   job.salary_max >= min AND job.salary_min <= max
                    const clause = `(j.salary_max >= $${currentIndex} AND j.salary_min <= $${currentIndex + 1})`;
                    values.push(range.min, range.max);
                    currentIndex += 2;
                    return clause;
                } else if (range.min !== undefined) {
                    // Open upper bound: job salary_min >= min
                    const clause = `j.salary_min >= $${currentIndex}`;
                    values.push(range.min);
                    currentIndex++;
                    return clause;
                } else if (range.max !== undefined) {
                    // Open lower bound: job salary_max <= max
                    const clause = `j.salary_max <= $${currentIndex}`;
                    values.push(range.max);
                    currentIndex++;
                    return clause;
                }
                return null;
            }).filter(Boolean);

            if (rangeClauses.length > 0) {
                conditions.push(`(${rangeClauses.join(" OR ")})`);
            }
        }
    }

    // ─── Salary range (overlapping range logic) ───────────────────────────────
    // A job overlaps [minSalary, maxSalary] when:
    //   job.salary_max \>= minSalary  AND  job.salary_min \<= maxSalary
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
