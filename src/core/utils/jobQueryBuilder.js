/**
 * Builds parameterized SQL filter conditions for the jobs table (alias `j`).
 *
 * Multi-value filters (job_type, work_mode, companyType, industry, experience_level)
 * accept comma-separated or pipe-separated values and produce SQL filter clauses.
 *
 * Boolean filters (easyApply, activelyHiring, is_verified) accept "true" | "false" | boolean.
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
        experience_level,
        experience,
        experience_min,
        experience_max,
        minSalary,
        maxSalary,
        salary_min,
        salary_max,
        salaryRanges,
        salary_range,
        salaryRange,
        datePosted,
        date_posted,
        jobType,
        job_type,
        employment_type,
        workMode,
        work_mode,
        work_model,
        companyType,
        company,
        verified,
        is_verified,
        industry,
        org_id,
    } = params;

    let conditions = [];
    let values = [];
    let currentIndex = paramCountStart;

    // ─── Helper: multi-value OR filter ───────────────────────────────────────
    const applyMultiValue = (rawValue, column) => {
        if (!rawValue) return;
        const vals = (Array.isArray(rawValue) ? rawValue : String(rawValue).split(/[|,]/))
            .map(v => String(v).trim())
            .filter(Boolean);
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
        conditions.push(`(j.title ILIKE $${currentIndex} OR j.company_name ILIKE $${currentIndex} OR (u.full_name IS NOT NULL AND u.full_name ILIKE $${currentIndex}))`);
        values.push(`%${searchQuery}%`);
        currentIndex++;
    }

    // ─── Location ────────────────────────────────────────────────────────────
    if (location) {
        const rawLocations = Array.isArray(location) ? location : String(location).split('|');
        const locParts = rawLocations.map(s => String(s).trim()).filter(Boolean);
        if (locParts.length > 0) {
            const orClauses = [];
            for (const part of locParts) {
                const primaryCity = part.split(',')[0].trim();
                orClauses.push(`j.location ILIKE $${currentIndex}`);
                values.push(`%${primaryCity}%`);
                currentIndex++;

                const lowerCity = primaryCity.toLowerCase();
                if (lowerCity === 'bengaluru') {
                    orClauses.push(`j.location ILIKE $${currentIndex}`);
                    values.push(`%Bangalore%`);
                    currentIndex++;
                } else if (lowerCity === 'bangalore') {
                    orClauses.push(`j.location ILIKE $${currentIndex}`);
                    values.push(`%Bengaluru%`);
                    currentIndex++;
                }
            }
            if (orClauses.length > 0) {
                conditions.push(`(${orClauses.join(' OR ')})`);
            }
        }
    }

    // ─── Boolean toggles ─────────────────────────────────────────────────────
    if (easyApply === "true" || easyApply === true) {
        conditions.push(`j.easy_apply = TRUE`);
    } else if (easyApply === "false" || easyApply === false) {
        conditions.push(`j.easy_apply = FALSE`);
    }

    if (activelyHiring === "true" || activelyHiring === true) {
        conditions.push(`j.actively_hiring = TRUE`);
    } else if (activelyHiring === "false" || activelyHiring === false) {
        conditions.push(`j.actively_hiring = FALSE`);
    }

    // ─── Experience level ────────────────────────────────────────────────────
    const rawExperienceLevel = experience_level || experienceLevel || experience;
    let expCondition = null;
    if (rawExperienceLevel && rawExperienceLevel !== "All Levels") {
        const rawLevels = Array.isArray(rawExperienceLevel) ? rawExperienceLevel : String(rawExperienceLevel).split(/[|,]/);
        const orClauses = [];

        rawLevels.map(v => String(v).trim()).filter(Boolean).forEach(val => {
            const lower = val.toLowerCase();
            if (lower.includes('fresher') || lower.includes('entry') || lower === '0-2' || lower.includes('0 - 2')) {
                orClauses.push(`(
                    j.experience_label ILIKE '%fresher%'
                    OR j.experience_label ILIKE '%0%2%'
                    OR (
                        (j.experience_min IS NOT NULL OR j.experience_max IS NOT NULL)
                        AND COALESCE(j.experience_min, 0) = 0
                        AND COALESCE(j.experience_max, j.experience_min, 0) <= 2
                    )
                )`);
            } else if (lower.includes('junior') || lower.includes('1-3') || lower.includes('1 - 3')) {
                orClauses.push(`(
                    j.experience_label ILIKE '%junior%'
                    OR j.experience_label ILIKE '%1%3%'
                    OR (
                        (j.experience_min IS NOT NULL OR j.experience_max IS NOT NULL)
                        AND COALESCE(j.experience_min, j.experience_max) <= 3
                        AND COALESCE(j.experience_max, j.experience_min) >= 1
                        AND COALESCE(j.experience_max, 0) >= 2
                        AND COALESCE(j.experience_min, 0) <= 2
                    )
                )`);
            } else if (lower.includes('mid') || lower.includes('3-5') || lower.includes('3 - 5')) {
                orClauses.push(`(
                    j.experience_label ILIKE '%mid%'
                    OR j.experience_label ILIKE '%3%5%'
                    OR (
                        (j.experience_min IS NOT NULL OR j.experience_max IS NOT NULL)
                        AND COALESCE(j.experience_min, j.experience_max) <= 5
                        AND COALESCE(j.experience_max, j.experience_min) >= 3
                        AND COALESCE(j.experience_min, 0) >= 2
                    )
                )`);
            } else if (lower.includes('senior') || lower.includes('5+') || lower.includes('5 +')) {
                orClauses.push(`(
                    j.experience_label ILIKE '%senior%'
                    OR j.experience_label ILIKE '%5%'
                    OR (
                        (j.experience_min IS NOT NULL OR j.experience_max IS NOT NULL)
                        AND COALESCE(j.experience_max, j.experience_min, 0) >= 5
                        AND COALESCE(j.experience_min, 0) >= 4
                    )
                )`);
            } else {
                orClauses.push(`j.experience_label ILIKE $${currentIndex}`);
                values.push(`%${val}%`);
                currentIndex++;
            }
        });

        if (orClauses.length > 0) {
            expCondition = `(${orClauses.join(' OR ')})`;
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
    // Range map (INR):
    //   Under 3L  → salary_min <= 300,000 (starting salary under 3L)
    //   3L-5L     → salary_min <= 500,000  AND salary_max >= 300,000
    //   6L-10L    → salary_min <= 1,000,000 AND salary_max >= 600,000
    //   10L+      → salary_max >= 1,000,000
    const rawSalaryRanges = salary_range || salaryRanges || salaryRange;
    if (rawSalaryRanges) {
        const rawList = Array.isArray(rawSalaryRanges) ? rawSalaryRanges : String(rawSalaryRanges).split(/[|,]/);
        const selectedRanges = [];

        rawList.map(v => String(v).trim().toLowerCase()).filter(Boolean).forEach(val => {
            if (val.includes('under 3l') || val.includes('under 3') || val.includes('< 3') || val.includes('under 300k')) {
                selectedRanges.push({ max: 300000 });
            } else if (val.includes('3l-5l') || val.includes('3-5') || val.includes('3l - 5l') || val.includes('300k-500k')) {
                selectedRanges.push({ min: 300000, max: 500000 });
            } else if (val.includes('6l-10l') || val.includes('6-10') || val.includes('6l - 10l') || val.includes('600k-1000k')) {
                selectedRanges.push({ min: 600000, max: 1000000 });
            } else if (val.includes('10l+') || val.includes('10l +') || val.includes('> 10') || val.includes('1000k+')) {
                selectedRanges.push({ min: 1000000 });
            }
        });

        if (selectedRanges.length > 0) {
            const rangeClauses = selectedRanges.map(range => {
                if (range.min !== undefined && range.max !== undefined) {
                    const clause = `(COALESCE(j.salary_max, j.salary_min) >= $${currentIndex} AND COALESCE(j.salary_min, j.salary_max) <= $${currentIndex + 1})`;
                    values.push(range.min, range.max);
                    currentIndex += 2;
                    return clause;
                } else if (range.min !== undefined) {
                    const clause = `(COALESCE(j.salary_max, j.salary_min) >= $${currentIndex})`;
                    values.push(range.min);
                    currentIndex++;
                    return clause;
                } else if (range.max !== undefined) {
                    const clause = `(COALESCE(j.salary_min, j.salary_max) <= $${currentIndex})`;
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

    // ─── Salary range (overlapping numeric range logic) ───────────────────────
    const effMinSalary = salary_min !== undefined ? salary_min : (params.min_salary !== undefined ? params.min_salary : minSalary);
    const effMaxSalary = salary_max !== undefined ? salary_max : (params.max_salary !== undefined ? params.max_salary : maxSalary);
    const min = effMinSalary ? Number(effMinSalary) : NaN;
    const max = effMaxSalary ? Number(effMaxSalary) : NaN;

    if (!isNaN(min) && !isNaN(max)) {
        conditions.push(`(COALESCE(j.salary_max, j.salary_min) >= $${currentIndex} AND COALESCE(j.salary_min, j.salary_max) <= $${currentIndex + 1})`);
        values.push(min, max);
        currentIndex += 2;
    } else if (!isNaN(min)) {
        conditions.push(`(COALESCE(j.salary_max, j.salary_min) >= $${currentIndex})`);
        values.push(min);
        currentIndex++;
    } else if (!isNaN(max)) {
        conditions.push(`(COALESCE(j.salary_min, j.salary_max) <= $${currentIndex})`);
        values.push(max);
        currentIndex++;
    }

    // ─── Date posted ──────────────────────────────────────────────────────────
    const rawDatePosted = date_posted || datePosted;
    if (rawDatePosted) {
        const DATE_POSTED_DAYS = {
            "past 24 hours": 1,
            "today":         1,
            "past week":     7,
            "last 7 days":   7,
            "past month":    30,
            "last 30 days":  30,
        };
        const daysAgo = DATE_POSTED_DAYS[String(rawDatePosted).toLowerCase().trim()];
        if (daysAgo !== undefined) {
            const fromDate = new Date();
            fromDate.setDate(fromDate.getDate() - daysAgo);
            conditions.push(`COALESCE(j.published_at, j.created_at) >= $${currentIndex}`);
            values.push(fromDate);
            currentIndex++;
        }
    }

    // ─── Job Type (multi-value, handles hyphen / space variants) ─────────────
    const rawJobType = job_type || jobType || employment_type;
    if (rawJobType) {
        const rawTypes = Array.isArray(rawJobType) ? rawJobType : String(rawJobType).split(/[|,]/);
        const mappedTypes = [];
        rawTypes.map(t => String(t).trim().toLowerCase()).filter(Boolean).forEach(t => {
            if (t === 'full-time' || t === 'full time' || t === 'fulltime') {
                mappedTypes.push('full-time', 'full time');
            } else if (t === 'part-time' || t === 'part time' || t === 'parttime') {
                mappedTypes.push('part-time', 'part time');
            } else {
                mappedTypes.push(t);
            }
        });
        const uniqueTypes = [...new Set(mappedTypes)];
        if (uniqueTypes.length > 0) {
            const placeholders = uniqueTypes.map((_, i) => `$${currentIndex + i}`).join(", ");
            conditions.push(`LOWER(j.job_type::text) = ANY(ARRAY[${placeholders}])`);
            values.push(...uniqueTypes);
            currentIndex += uniqueTypes.length;
        }
    }

    // ─── Work Mode (multi-value, handles Onsite / On-site variants) ───────────
    const rawWorkMode = work_mode || workMode || work_model;
    if (rawWorkMode) {
        const rawModes = Array.isArray(rawWorkMode) ? rawWorkMode : String(rawWorkMode).split(/[|,]/);
        const mappedModes = [];
        rawModes.map(m => String(m).trim().toLowerCase()).filter(Boolean).forEach(m => {
            if (m === 'onsite' || m === 'on-site') {
                mappedModes.push('onsite', 'on-site');
            } else {
                mappedModes.push(m);
            }
        });
        const uniqueModes = [...new Set(mappedModes)];
        if (uniqueModes.length > 0) {
            const placeholders = uniqueModes.map((_, i) => `$${currentIndex + i}`).join(", ");
            conditions.push(`LOWER(j.work_mode::text) = ANY(ARRAY[${placeholders}])`);
            values.push(...uniqueModes);
            currentIndex += uniqueModes.length;
        }
    }

    // ─── Company Type ────────────────────────────────────────────────────────
    applyMultiValue(companyType, "j.company_type");

    // ─── Company (exact & fuzzy matching with organizations join) ────────────
    if (company) {
        const rawCompanies = Array.isArray(company) ? company : String(company).split(/[|,]/);
        const vals = rawCompanies.map(v => String(v).trim()).filter(Boolean);
        if (vals.length > 0) {
            const companyClauses = [];
            for (const c of vals) {
                companyClauses.push(`(
                    TRIM(LOWER(j.company_name)) = LOWER($${currentIndex})
                    OR j.company_name ILIKE $${currentIndex + 1}
                    OR EXISTS (
                        SELECT 1 FROM organizations o
                        WHERE o.org_id = j.org_id
                          AND (TRIM(LOWER(o.name)) = LOWER($${currentIndex}) OR o.name ILIKE $${currentIndex + 1})
                    )
                )`);
                values.push(c, `%${c}%`);
                currentIndex += 2;
            }
            conditions.push(`(${companyClauses.join(' OR ')})`);
        }
    }

    // ─── Verified Organization ───────────────────────────────────────────────
    const rawVerified = is_verified !== undefined ? is_verified : verified;
    if (rawVerified === "true" || rawVerified === true) {
        conditions.push(`EXISTS (
            SELECT 1 FROM organizations o
            WHERE o.org_id = j.org_id
              AND o.verification_status IN ('VERIFIED', 'DOMAIN_VERIFIED')
        )`);
    }

    // ─── Industry ────────────────────────────────────────────────────────────
    const rawIndustry = industry;
    if (rawIndustry) {
        const indParts = Array.isArray(rawIndustry) ? rawIndustry : String(rawIndustry).split(/[|,]/);
        const mappedIndustries = [];
        indParts.map(v => String(v).trim()).filter(Boolean).forEach(val => {
            mappedIndustries.push(val);
            if (val.includes(' ')) {
                mappedIndustries.push(val.replace(/\s+/g, '_'));
            } else if (val.includes('_')) {
                mappedIndustries.push(val.replace(/_/g, ' '));
            }
            if (val.toLowerCase() === 'tech' || val.toLowerCase() === 'technology') {
                mappedIndustries.push('Information Technology', 'information_technology');
            }
        });
        const uniqueIndustries = [...new Set(mappedIndustries)];
        if (uniqueIndustries.length > 0) {
            const placeholders = uniqueIndustries.map((_, i) => `LOWER(TRIM($${currentIndex + i}))`).join(", ");
            conditions.push(`LOWER(TRIM(j.industry)) = ANY(ARRAY[${placeholders}])`);
            values.push(...uniqueIndustries);
            currentIndex += uniqueIndustries.length;
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
