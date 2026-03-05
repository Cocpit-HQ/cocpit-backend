const buildJobFilters = (params, paramCountStart = 1) => {
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
        organizationType,
        companyType,
        industry,
        org_id,
        orgId,
        status,
    } = params;
    const targetOrgId = org_id || orgId;
    const targetCompType = organizationType || companyType;

    let conditions = [];
    let values = [];
    let currentIndex = paramCountStart;

    if (title) {
        conditions.push(`j.title ILIKE $${currentIndex}`);
        values.push(`%${title}%`);
        currentIndex++;
    }
    if (location) {
        conditions.push(`j.location ILIKE $${currentIndex}`);
        values.push(`%${location}%`);
        currentIndex++;
    }
    if (easyApply === "true") {
        conditions.push(`j.easy_apply = TRUE`);
    }
    if (activelyHiring === "true") {
        conditions.push(`j.actively_hiring = TRUE`);
    }
    if (experienceLevel && experienceLevel !== "All Levels") {
        conditions.push(`j.experience_level = $${currentIndex}`);
        values.push(experienceLevel);
        currentIndex++;
    }

    const min = Number(minSalary);
    const max = Number(maxSalary);

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

    if (datePosted) {
        let fromDate;
        const now = new Date();
        if (datePosted === "Past 24 hours") {
            fromDate = new Date(now.setDate(now.getDate() - 1));
        } else if (datePosted === "Past week") {
            fromDate = new Date(now.setDate(now.getDate() - 7));
        } else if (datePosted === "Past month") {
            fromDate = new Date(now.setMonth(now.getMonth() - 1));
        }
        if (fromDate) {
            conditions.push(`j.created_at >= $${currentIndex}`);
            values.push(fromDate);
            currentIndex++;
        }
    }

    if (jobType) {
        conditions.push(`j.job_type = $${currentIndex}`);
        values.push(jobType);
        currentIndex++;
    }
    if (workMode) {
        conditions.push(`j.work_mode = $${currentIndex}`);
        values.push(workMode);
        currentIndex++;
    }
    if (targetCompType) {
        conditions.push(`j.company_type = $${currentIndex}`);
        values.push(targetCompType);
        currentIndex++;
    }
    if (industry) {
        conditions.push(`j.industry = $${currentIndex}`);
        values.push(industry);
        currentIndex++;
    }
    if (targetOrgId) {
        conditions.push(`j.org_id = $${currentIndex}`);
        values.push(targetOrgId);
        currentIndex++;
    }
    if (status) {
        conditions.push(`j.status = $${currentIndex}`);
        values.push(status);
        currentIndex++;
    }

    return { conditions, values, nextIndex: currentIndex };
};

module.exports = { buildJobFilters };
