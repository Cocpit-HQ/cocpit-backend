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
        status,
    } = params;

    let conditions = [];
    let values = [];
    let currentIndex = paramCountStart;

    const searchQuery = q || search || title;
    if (searchQuery) {
        conditions.push(`(j.title ILIKE $${currentIndex} OR j.company_name ILIKE $${currentIndex})`);
        values.push(`%${searchQuery}%`);
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
        const datePostedStr = datePosted.toLowerCase();
        if (datePostedStr === "past 24 hours" || datePostedStr === "today") {
            fromDate = new Date(now.setDate(now.getDate() - 1));
        } else if (datePostedStr === "past week" || datePostedStr === "last 7 days") {
            fromDate = new Date(now.setDate(now.getDate() - 7));
        } else if (datePostedStr === "past month" || datePostedStr === "last 30 days") {
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
    if (companyType) {
        conditions.push(`j.company_type = $${currentIndex}`);
        values.push(companyType);
        currentIndex++;
    }
    if (industry) {
        conditions.push(`j.industry = $${currentIndex}`);
        values.push(industry);
        currentIndex++;
    }
    if (org_id) {
        conditions.push(`j.org_id = $${currentIndex}`);
        values.push(org_id);
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
