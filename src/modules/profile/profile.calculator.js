/**
 * Pure calculation functions for Profile Score & Completeness
 */

/**
 * Section 1: Basic Info (Max 30 points)
 * Evaluates 8 fields: full_name, headline, location, status (account_type), about, looking_for, availability, work_setup
 */
function calculateBasicInfoScore(userProfile) {
    const fields = [
        { key: "full_name", value: userProfile?.full_name },
        { key: "headline", value: userProfile?.headline },
        { key: "location", value: userProfile?.location },
        { key: "status", value: userProfile?.account_type },
        { key: "about", value: userProfile?.about_text },
        { key: "looking_for", value: userProfile?.open_to },
        { key: "availability", value: userProfile?.availability },
        { key: "work_setup", value: userProfile?.work_preference }
    ];

    const filledFields = fields.filter(f => f.value && String(f.value).trim() !== "");
    const filledCount = filledFields.length;
    const totalCount = fields.length;
    const missingFields = fields.filter(f => !f.value || String(f.value).trim() === "").map(f => f.key);

    let score = 0;
    if (filledCount >= 4) {
        score = 15 + Math.round(((filledCount - 4) / 4) * 15);
    } else {
        score = Math.round((filledCount / 4) * 15);
    }

    return {
        score: Math.min(30, Math.max(0, score)),
        max_score: 30,
        filled_count: filledCount,
        total_count: totalCount,
        missing_fields: missingFields
    };
}

/**
 * Section 2: Skills (Max 15 points)
 * 5+ skills -> 15 pts
 * 3-4 skills -> 10 pts
 * 1-2 skills -> 5 pts
 * 0 skills -> 0 pts
 */
function calculateSkillsScore(skills) {
    const count = Array.isArray(skills) ? skills.length : 0;
    let score = 0;

    if (count >= 5) {
        score = 15;
    } else if (count >= 3) {
        score = 10;
    } else if (count >= 1) {
        score = 5;
    } else {
        score = 0;
    }

    return {
        score,
        max_score: 15,
        count
    };
}

/**
 * Section 3: Experience (Max 20 points)
 * Evaluates experiences. Complete entry requires: company_name, title, start_date, description.
 * Multi-entry strategy: Option A (MAX single entry score).
 */
function calculateExperienceScore(experiences) {
    if (!Array.isArray(experiences) || experiences.length === 0) {
        return {
            score: 0,
            max_score: 20,
            count: 0,
            complete_count: 0
        };
    }

    let completeCount = 0;
    let maxEntryScore = 0;

    for (const exp of experiences) {
        let entryScore = 0;
        if (exp.company_name && String(exp.company_name).trim() !== "") entryScore += 5;
        if (exp.title && String(exp.title).trim() !== "") entryScore += 5;
        if (exp.start_date) entryScore += 5;
        if (exp.description && String(exp.description).trim() !== "") entryScore += 5;

        if (entryScore === 20) {
            completeCount++;
        }
        if (entryScore > maxEntryScore) {
            maxEntryScore = entryScore;
        }
    }

    return {
        score: Math.min(20, maxEntryScore),
        max_score: 20,
        count: experiences.length,
        complete_count: completeCount
    };
}

/**
 * Section 4: Projects (Max 20 points)
 * Evaluates projects. 
 * title + details -> 10 pts
 * title + details + (media || role || team_size) -> 20 pts
 * Multi-entry strategy: Option A (MAX single entry score).
 */
function calculateProjectsScore(projects) {
    if (!Array.isArray(projects) || projects.length === 0) {
        return {
            score: 0,
            max_score: 20,
            count: 0,
            complete_count: 0
        };
    }

    let completeCount = 0;
    let maxProjectScore = 0;

    for (const proj of projects) {
        const hasTitle = proj.title && String(proj.title).trim() !== "";
        const hasDetails = proj.details && String(proj.details).trim() !== "";
        const hasMedia = Array.isArray(proj.media) && proj.media.length > 0;
        const hasRole = proj.role && String(proj.role).trim() !== "";
        const hasTeam = proj.team_size && String(proj.team_size).trim() !== "";

        let projectScore = 0;
        if (hasTitle && hasDetails) {
            if (hasMedia || hasRole || hasTeam) {
                projectScore = 20;
                completeCount++;
            } else {
                projectScore = 10;
            }
        } else if (hasTitle || hasDetails) {
            projectScore = 5;
        }

        if (projectScore > maxProjectScore) {
            maxProjectScore = projectScore;
        }
    }

    return {
        score: Math.min(20, maxProjectScore),
        max_score: 20,
        count: projects.length,
        complete_count: completeCount
    };
}

/**
 * Section 5: Education (Max 5 points)
 * Evaluates education. Complete entry requires: school_name, degree, (start_date || end_date)
 * Multi-entry strategy: Option A (MAX single entry score).
 */
function calculateEducationScore(educations) {
    if (!Array.isArray(educations) || educations.length === 0) {
        return {
            score: 0,
            max_score: 5,
            count: 0,
            complete_count: 0
        };
    }

    let completeCount = 0;
    let maxEduScore = 0;

    for (const edu of educations) {
        const hasSchool = edu.school_name && String(edu.school_name).trim() !== "";
        const hasDegree = edu.degree && String(edu.degree).trim() !== "";
        const hasDates = edu.start_date || edu.end_date;

        let eduScore = 0;
        if (hasSchool && hasDegree && hasDates) {
            eduScore = 5;
            completeCount++;
        } else if (hasSchool) {
            eduScore = 3;
        }

        if (eduScore > maxEduScore) {
            maxEduScore = eduScore;
        }
    }

    return {
        score: Math.min(5, maxEduScore),
        max_score: 5,
        count: educations.length,
        complete_count: completeCount
    };
}

/**
 * Section 6: Profile Media (Max 10 points)
 * Both avatar and cover -> 10 pts
 * Only one -> 5 pts
 * Neither -> 0 pts
 */
function calculateMediaScore(userProfile) {
    const hasAvatar = !!(userProfile?.avatar_url && String(userProfile.avatar_url).trim() !== "");
    const hasCover = !!(userProfile?.cover_image_url && String(userProfile.cover_image_url).trim() !== "");

    let score = 0;
    if (hasAvatar && hasCover) {
        score = 10;
    } else if (hasAvatar || hasCover) {
        score = 5;
    } else {
        score = 0;
    }

    return {
        score,
        max_score: 10,
        has_avatar: hasAvatar,
        has_cover: hasCover
    };
}

/**
 * Computes full ProfileScoreResponse with score & breakdown for frontend UI component.
 */
function calculateFullProfileScore(userProfile, skills, experiences, projects, educations) {
    const basicInfo = calculateBasicInfoScore(userProfile);
    const skillsScore = calculateSkillsScore(skills);
    const expScore = calculateExperienceScore(experiences);
    const projScore = calculateProjectsScore(projects);
    const eduScore = calculateEducationScore(educations);
    const mediaScore = calculateMediaScore(userProfile);

    const breakdown = {
        basic_info: {
            earned: basicInfo.score,
            max: 30,
            missing: basicInfo.missing_fields
        },
        skills: {
            earned: skillsScore.score,
            max: 15,
            missing: skillsScore.count < 5 ? ["skills"] : []
        },
        experience: {
            earned: expScore.score,
            max: 20,
            missing: expScore.score < 20 ? ["experience"] : []
        },
        projects: {
            earned: projScore.score,
            max: 20,
            missing: projScore.score < 20 ? ["projects"] : []
        },
        education: {
            earned: eduScore.score,
            max: 5,
            missing: eduScore.score < 5 ? ["education"] : []
        },
        profile_banner: {
            earned: mediaScore.score,
            max: 10,
            missing: mediaScore.score < 10 ? ["profile_banner"] : []
        }
    };

    const totalEarned = breakdown.basic_info.earned +
                        breakdown.skills.earned +
                        breakdown.experience.earned +
                        breakdown.projects.earned +
                        breakdown.education.earned +
                        breakdown.profile_banner.earned;

    const score = Math.min(100, Math.max(0, Math.round(totalEarned)));

    return {
        score,
        breakdown
    };
}

module.exports = {
    calculateBasicInfoScore,
    calculateSkillsScore,
    calculateExperienceScore,
    calculateProjectsScore,
    calculateEducationScore,
    calculateMediaScore,
    calculateFullProfileScore
};
