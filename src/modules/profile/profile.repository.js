/**
 * Profile Repository
 * All database queries for profile data: user info, experiences, educations, skills, resume.
 */
const pool = require("../../core/db/pool");

// ─── User / Profile Queries ────────────────────────────────────────────────────

const getFullProfile = async (userId) => {
    const result = await pool.query(
        `SELECT u.user_id, u.full_name, u.headline, u.avatar_url, u.cover_image_url,
                u.location, u.about_text, u.email, u.mobile_number, u.account_name, u.website, u.created_at,
                u.onboarding_step,
                u.location_formatted, u.location_country, u.location_state, u.location_city,
                u.location_lat, u.location_lng, u.location_place_id,
                p.profile_id, p.account_type, p.open_to, p.availability, p.work_preference,
                p.profile_views_count, p.search_appearances_count, p.version
         FROM active_users u
         LEFT JOIN profiles p ON u.user_id = p.user_id
         WHERE u.user_id = $1`,
        [userId]
    );
    return result.rows[0] || null;
};

const updateUserFields = async (userId, fields) => {
    const { full_name, headline, job_title, company_name, school, degree, location, about_text, mobile_number, account_name, website } = fields;
    await pool.query("BEGIN");
    await pool.query(
        `UPDATE users
     SET full_name = COALESCE($1, full_name), headline = COALESCE($2, headline),
         job_title = COALESCE($3, job_title), company_name = COALESCE($4, company_name),
         school = COALESCE($5, school), degree = COALESCE($6, degree),
         location = COALESCE($7, location), about_text = COALESCE($8, about_text),
         mobile_number = COALESCE($9, mobile_number),account_name = COALESCE($10, account_name), website = COALESCE($11, website), updated_at = now()
     WHERE user_id = $12`,
        [full_name, headline, job_title, company_name, school, degree, location, about_text, mobile_number, account_name, website, userId]
    );
    await pool.query("COMMIT");
};

const updateAvatarUrl = async (userId, url) => {
    await pool.query("UPDATE users SET avatar_url = $1 WHERE user_id = $2", [url, userId]);
};

const getAvatarUrl = async (userId) => {
    const result = await pool.query("SELECT avatar_url FROM users WHERE user_id = $1", [userId]);
    return result.rows[0]?.avatar_url || null;
};

const updateCoverUrl = async (userId, url) => {
    await pool.query("UPDATE users SET cover_image_url = $1 WHERE user_id = $2", [url, userId]);
};

// ─── Identity ──────────────────────────────────────────────────────────────────

const getIdentity = async (userId) => {
    const result = await pool.query(
        `SELECT open_to, availability, work_preference FROM profiles WHERE user_id = $1`,
        [userId]
    );
    return result.rows[0] || null;
};

const updateIdentity = async (userId, { open_to, availability, work_preference, account_type }) => {
    let query = `UPDATE profiles SET open_to = $1, availability = $2, work_preference = $3`;
    let params = [open_to, availability, work_preference];
    let idx = 4;
    if (account_type !== undefined) {
        query += `, account_type = $${idx}`;
        params.push(account_type);
        idx++;
    }
    query += `, updated_at = now() WHERE user_id = $${idx} RETURNING *`;
    params.push(userId);
    const result = await pool.query(query, params);
    return result.rows[0] || null;
};

// ─── Resume ────────────────────────────────────────────────────────────────────

const getResume = async (userId) => {
    const result = await pool.query(`SELECT * FROM user_resumes WHERE user_id = $1`, [userId]);
    return result.rows[0] || null;
};

const getLatestResume = async (userId) => {
    const result = await pool.query(
        `SELECT file_name, file_url FROM user_resumes WHERE user_id = $1 ORDER BY uploaded_at DESC LIMIT 1`,
        [userId]
    );
    return result.rows[0] || null;
};

const replaceResume = async (userId, { originalname, path, mimetype, size }) => {
    await pool.query(`DELETE FROM user_resumes WHERE user_id = $1`, [userId]);
    const result = await pool.query(
        `INSERT INTO user_resumes (user_id, file_name, file_url, file_type, file_size)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [userId, originalname, path, mimetype, size]
    );
    return result.rows[0];
};

const deleteResume = async (userId) => {
    const result = await pool.query(`DELETE FROM user_resumes WHERE user_id = $1 RETURNING *`, [userId]);
    return result.rows[0] || null;
};

// ─── Profile ID Helper ─────────────────────────────────────────────────────────

const getProfileId = async (userId) => {
    const result = await pool.query(`SELECT profile_id FROM profiles WHERE user_id = $1`, [userId]);
    return result.rows[0]?.profile_id || null;
};

const ensureProfileId = async (userId, accountType = "Student") => {
    let profileId = await getProfileId(userId);
    if (!profileId) {
        const result = await pool.query(
            `INSERT INTO profiles (user_id, open_to, availability, work_preference) 
             VALUES ($1, $2, $3, $4) RETURNING profile_id`,
            [userId, accountType === "Employer" ? "Full-time" : "Freelance", "Immediate", "Remote"]
        );
        profileId = result.rows[0].profile_id;
    }
    return profileId;
};

const getProfileVersion = async (profileId) => {
    const result = await pool.query(`SELECT version FROM profiles WHERE profile_id = $1`, [profileId]);
    return result.rows[0]?.version ?? 0;
};

const incrementProfileVersion = async (client, profileId, currentVersion) => {
    const result = await client.query(
        `UPDATE profiles SET version = version + 1, updated_at = now() 
         WHERE profile_id = $1 AND version = $2 
         RETURNING version`,
        [profileId, currentVersion]
    );
    return result.rows[0]?.version || null;
};

// ─── Idempotency ──────────────────────────────────────────────────────────────

const getIdempotentResponse = async (requestId) => {
    const result = await pool.query(
        `SELECT response_body, status_code FROM idempotent_requests WHERE request_id = $1`,
        [requestId]
    );
    return result.rows[0] || null;
};

const saveIdempotentResponse = async (requestId, statusCode, responseBody) => {
    await pool.query(
        `INSERT INTO idempotent_requests (request_id, status_code, response_body)
         VALUES ($1, $2, $3)
         ON CONFLICT (request_id) DO UPDATE 
         SET status_code = EXCLUDED.status_code, response_body = EXCLUDED.response_body`,
        [requestId, statusCode, JSON.stringify(responseBody)]
    );
};

// ─── Experiences ────────────────────────────────────────────────────────────────

const getExperiences = async (profileId) => {
    const result = await pool.query(
        `SELECT e.*, o.logo_url 
         FROM experiences e 
         LEFT JOIN organizations o ON e.org_id = o.org_id 
         WHERE e.profile_id = $1 
         ORDER BY e.is_current DESC, e.start_date DESC`,
        [profileId]
    );
    return groupByCompany(result.rows);
};

/** Returns flat (ungrouped) experience rows for a profile — used for validation checks */
const getExperiencesByProfileId = async (profileId) => {
    const result = await pool.query(
        `SELECT * FROM experiences WHERE profile_id = $1 ORDER BY is_current DESC, start_date DESC`,
        [profileId]
    );
    return result.rows;
};

const groupByCompany = (rows) => {
    if (!rows || rows.length === 0) return [];

    // Step 1: Sort experiences by latest start_date first
    const sortedRows = [...rows].sort(
        (a, b) => new Date(b.start_date) - new Date(a.start_date)
    );

    const grouped = [];
    let currentGroup = null;

    for (const exp of sortedRows) {
        const normalizedName = exp.company_name.toLowerCase().trim();
        const orgId = exp.org_id;

        // Group only if previous consecutive company is same (by org_id or by name)
        const isSameGroup = currentGroup && (
            (orgId && currentGroup.org_id === orgId) ||
            (!orgId && !currentGroup.org_id && currentGroup.normalized_company === normalizedName)
        );

        if (isSameGroup) {
            currentGroup.experiences.push(exp);
        } else {
            currentGroup = {
                company_name: exp.company_name, 
                logo_url: exp.logo_url,
                org_id: orgId,
                normalized_company: normalizedName,
                experiences: [exp],
            };

            grouped.push(currentGroup);
        }
    }

    // Remove helper field before returning response
    return grouped.map(({ normalized_company, org_id, ...rest }) => rest);
};

const addExperience = async (profileId, data) => {
    const { title, company_name, location, work_type, work_mode, start_date, end_date, is_current, description, org_id } = data;
    const result = await pool.query(
        `INSERT INTO experiences (profile_id, title, company_name, location, work_type, work_mode, start_date, end_date, is_current, description, org_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
        [profileId, title, company_name, location ?? null, work_type ?? null, work_mode ?? null, start_date, end_date ?? null, is_current ?? false, description ?? null, org_id ?? null]
    );
    return result.rows[0];
};

const findExperience = async (experienceId, profileId) => {
    const result = await pool.query(
        `SELECT * FROM experiences WHERE experience_id = $1 AND profile_id = $2`,
        [experienceId, profileId]
    );
    return result.rows[0] || null;
};

const ALLOWED_EXPERIENCE_COLUMNS = new Set([
    'title', 'company_name', 'location', 'work_type', 'work_mode',
    'start_date', 'end_date', 'is_current', 'description', 'org_id',
]);

const updateExperience = async (experienceId, profileId, data) => {
    const fields = [];
    const values = [];
    let idx = 1;
    for (const [key, val] of Object.entries(data)) {
        if (!ALLOWED_EXPERIENCE_COLUMNS.has(key)) continue; // drop unknown / sensitive columns
        if (val !== undefined) { fields.push(`${key} = $${idx++}`); values.push(val); }
    }
    if (fields.length === 0) return null;
    values.push(experienceId, profileId);
    const result = await pool.query(
        `UPDATE experiences SET ${fields.join(", ")} WHERE experience_id = $${idx++} AND profile_id = $${idx} RETURNING *`,
        values
    );
    return result.rows[0] || null;
};

const deleteExperience = async (experienceId, profileId) => {
    const result = await pool.query(
        `DELETE FROM experiences WHERE experience_id = $1 AND profile_id = $2 RETURNING *`,
        [experienceId, profileId]
    );
    return result.rows[0] || null;
};

const deleteExperienceInTx = async (client, experienceId, profileId) => {
    const result = await client.query(
        `DELETE FROM experiences WHERE experience_id = $1 AND profile_id = $2 RETURNING *`,
        [experienceId, profileId]
    );
    return result.rows[0] || null;
};

/**
 * Ends a specific experience inside an existing pg transaction.
 * Only succeeds if the experience belongs to this profile AND is still active.
 * Returns the updated row, or null if not found / already ended.
 */
const endExperienceById = async (client, experienceId, profileId, endDate) => {
    const result = await client.query(
        `UPDATE experiences
         SET is_current = false, end_date = $1
         WHERE experience_id = $2
           AND profile_id    = $3
           AND is_current    = true
         RETURNING *`,
        [endDate, experienceId, profileId]
    );
    return result.rows[0] || null;
};

/**
 * Inserts a new experience inside an existing pg transaction.
 */
const addExperienceInTx = async (client, profileId, data) => {
    const { title, company_name, location, work_type, work_mode,
            start_date, end_date, is_current, description, org_id } = data;
    const result = await client.query(
        `INSERT INTO experiences
             (profile_id, title, company_name, location, work_type, work_mode,
              start_date, end_date, is_current, description, org_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [profileId, title, company_name, location ?? null, work_type ?? null, work_mode ?? null,
         start_date, end_date ?? null, is_current ?? false, description ?? null, org_id ?? null]
    );
    return result.rows[0];
};

const updateExperienceInTx = async (client, experienceId, profileId, data) => {
    const fields = [];
    const values = [];
    let idx = 1;
    for (const [key, val] of Object.entries(data)) {
        if (!ALLOWED_EXPERIENCE_COLUMNS.has(key)) continue;
        if (val !== undefined) { 
            fields.push(`${key} = $${idx++}`); 
            values.push(val); 
        }
    }
    if (fields.length === 0) return null;
    values.push(experienceId, profileId);
    const result = await client.query(
        `UPDATE experiences SET ${fields.join(", ")} WHERE experience_id = $${idx++} AND profile_id = $${idx} RETURNING *`,
        values
    );
    return result.rows[0] || null;
};

// ─── Educations ─────────────────────────────────────────────────────────────────

const getEducations = async (profileId) => {
    const result = await pool.query(
        `SELECT * FROM educations WHERE profile_id = $1 ORDER BY start_date DESC`,
        [profileId]
    );
    return result.rows;
};

const addEducation = async (profileId, data) => {
    const { school_name, degree, field_of_study, location, start_date, end_date, description } = data;
    const result = await pool.query(
        `INSERT INTO educations (profile_id, school_name, degree, field_of_study, location, start_date, end_date, description)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [profileId, school_name, degree, field_of_study, location, start_date, end_date, description]
    );
    return result.rows[0];
};

const updateEducation = async (educationId, profileId, data) => {
    const fields = [];
    const values = [];
    let idx = 1;
    for (const [key, val] of Object.entries(data)) {
        if (val !== undefined) { fields.push(`${key} = $${idx++}`); values.push(val); }
    }
    if (fields.length === 0) return null;
    values.push(educationId, profileId);
    const result = await pool.query(
        `UPDATE educations SET ${fields.join(", ")} WHERE education_id = $${idx++} AND profile_id = $${idx} RETURNING *`,
        values
    );
    return result.rows[0] || null;
};

const deleteEducation = async (educationId, profileId) => {
    const result = await pool.query(
        `DELETE FROM educations WHERE education_id = $1 AND profile_id = $2 RETURNING *`,
        [educationId, profileId]
    );
    return result.rows[0] || null;
};

// ─── Skills ─────────────────────────────────────────────────────────────────────

const getSkills = async (profileId) => {
    const result = await pool.query(
        `SELECT s.skill_id, s.name FROM user_skills us JOIN skills s ON us.skill_id = s.skill_id WHERE us.profile_id = $1`,
        [profileId]
    );
    return result.rows;
};

const deleteSkillMapping = async (profileId, skillId) => {
    const result = await pool.query(
        `DELETE FROM user_skills WHERE profile_id = $1 AND skill_id = $2 RETURNING *`,
        [profileId, skillId]
    );
    return result.rows[0] || null;
};

// ─── Social / Relationship Queries (used by getProfile) ────────────────────────

const getCompanyRoles = async (userId) => {
    const result = await pool.query(
        `SELECT c.org_id as company_id, c.org_id, c.name, c.slug, c.logo_url,
            COALESCE(cr.name, cm.role) as role,
            cm.is_primary_display, cm.is_role_visible, COALESCE(cr.priority, 0) as priority
     FROM organization_members cm
     JOIN organizations c ON cm.org_id = c.org_id
     LEFT JOIN organization_roles cr ON cm.role_id = cr.role_id
     WHERE cm.user_id = $1 AND c.is_deleted = FALSE
     ORDER BY cm.is_primary_display DESC, priority DESC, c.name ASC`,
        [userId]
    );
    return result.rows;
};

const getSocialCounts = async (userId) => {
    const result = await pool.query(
        `SELECT 
       (SELECT COUNT(*) FROM followers WHERE following_id = $1) as followers_count,
       (SELECT COUNT(*) FROM followers WHERE follower_id = $1) as following_count,
       (SELECT COUNT(*) FROM connections WHERE user_id = $1) as connections_count`,
        [userId]
    );
    return result.rows[0];
};

const getRelationshipInfo = async (viewerId, targetId) => {
    const followCheck = await pool.query(
        "SELECT 1 FROM followers WHERE follower_id = $1 AND following_id = $2",
        [viewerId, targetId]
    );
    const followedByCheck = await pool.query(
        "SELECT 1 FROM followers WHERE follower_id = $1 AND following_id = $2",
        [targetId, viewerId]
    );
    const connectionCheck = await pool.query(
        "SELECT 1 FROM connections WHERE user_id = $1 AND connected_user_id = $2",
        [viewerId, targetId]
    );

    let isFollowing = followCheck.rowCount > 0;
    let isFollowedBy = followedByCheck.rowCount > 0;
    let connectionRequestStatus = null;
    let connectionRequestId = null;
    let connectionRequestSender = null;
    const isConnected = connectionCheck.rowCount > 0;

    if (isConnected) {
        isFollowing = true;
        isFollowedBy = true;
        connectionRequestStatus = "connected";
    } else {
        const requestCheck = await pool.query(
            `SELECT request_id, sender_id, status FROM connection_requests
       WHERE (sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1)`,
            [viewerId, targetId]
        );
        if (requestCheck.rowCount > 0) {
            const reqRow = requestCheck.rows[0];
            connectionRequestStatus = reqRow.status;
            connectionRequestId = reqRow.request_id;
            connectionRequestSender = reqRow.sender_id === viewerId ? "me" : "them";
        }
    }

    return { isFollowing, isFollowedBy, connectionRequestStatus, connectionRequestId, connectionRequestSender };
};

// ─── Pool (for skills transactions that need client) ────────────────────────────

const getClient = async () => pool.connect();

const getUserRole = async (userId) => {
    const result = await pool.query(
        `SELECT r.role_name FROM user_roles ur
         JOIN roles r ON ur.role_id = r.role_id
         WHERE ur.user_id = $1
         LIMIT 1`,
        [userId]
    );
    return result.rows[0]?.role_name || null;
};

const getUserInterests = async (userId) => {
    const result = await pool.query(
        `SELECT i.name FROM user_interests ui
         JOIN interests i ON ui.interest_id = i.interest_id
         WHERE ui.user_id = $1`,
        [userId]
    );
    return result.rows;
};

module.exports = {
    getFullProfile, updateUserFields, updateAvatarUrl, getAvatarUrl, updateCoverUrl,
    getIdentity, updateIdentity,
    getResume, getLatestResume, replaceResume, deleteResume,
    getProfileId, ensureProfileId, getProfileVersion, incrementProfileVersion,
    getIdempotentResponse, saveIdempotentResponse,
    getExperiences, getExperiencesByProfileId, addExperience, findExperience, updateExperience, deleteExperience,
    endExperienceById, addExperienceInTx, updateExperienceInTx, deleteExperienceInTx,
    getEducations, addEducation, updateEducation, deleteEducation,
    getSkills, deleteSkillMapping,
    getCompanyRoles, getSocialCounts, getRelationshipInfo,
    getUserRole,
    getUserInterests,
    getClient,
};
