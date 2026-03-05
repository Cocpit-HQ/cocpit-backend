/**
 * Profile Repository
 * All database queries for profile data: user info, experiences, educations, skills, resume.
 */
const pool = require("../../core/db/pool");

// ─── User / Profile Queries ────────────────────────────────────────────────────

const getFullProfile = async (userId) => {
    const result = await pool.query(
        `SELECT u.user_id, u.full_name, u.headline, u.avatar_url, u.cover_image_url, u.location, u.about_text, u.email, u.mobile_number, u.account_name, u.created_at,
            p.profile_id, p.open_to, p.availability, p.work_preference, p.profile_views_count, p.search_appearances_count
     FROM users u
     LEFT JOIN profiles p ON u.user_id = p.user_id
     WHERE u.user_id = $1`,
        [userId]
    );
    return result.rows[0] || null;
};

const updateUserFields = async (userId, fields) => {
    const { full_name, headline, job_title, company_name, school, degree, location, about_text, mobile_number } = fields;
    await pool.query("BEGIN");
    await pool.query(
        `UPDATE users
     SET full_name = COALESCE($1, full_name), headline = COALESCE($2, headline),
         job_title = COALESCE($3, job_title), company_name = COALESCE($4, company_name),
         school = COALESCE($5, school), degree = COALESCE($6, degree),
         location = COALESCE($7, location), about_text = COALESCE($8, about_text),
         mobile_number = COALESCE($9, mobile_number),account_name = COALESCE($10, account_name), updated_at = now()
     WHERE user_id = $11`,
        [full_name, headline, job_title, company_name, school, degree, location, about_text, mobile_number,account_name, userId]
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

const updateIdentity = async (userId, { open_to, availability, work_preference }) => {
    const result = await pool.query(
        `UPDATE profiles SET open_to = $1, availability = $2, work_preference = $3, updated_at = now()
     WHERE user_id = $4 RETURNING *`,
        [open_to, availability, work_preference, userId]
    );
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

// ─── Experiences ────────────────────────────────────────────────────────────────

const getExperiences = async (profileId) => {
    const result = await pool.query(
        `SELECT * FROM experiences WHERE profile_id = $1 ORDER BY start_date DESC`,
        [profileId]
    );
    return result.rows;
};

const addExperience = async (profileId, data) => {
    const { title, company_name, location, start_date, end_date, is_current, description } = data;
    const result = await pool.query(
        `INSERT INTO experiences (profile_id, title, company_name, location, start_date, end_date, is_current, description)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [profileId, title, company_name, location, start_date, end_date, is_current ?? false, description]
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

const updateExperience = async (experienceId, profileId, data) => {
    const fields = [];
    const values = [];
    let idx = 1;
    for (const [key, val] of Object.entries(data)) {
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

// ─── Educations ─────────────────────────────────────────────────────────────────

const getEducations = async (profileId) => {
    const result = await pool.query(
        `SELECT * FROM educations WHERE profile_id = $1 ORDER BY start_date DESC`,
        [profileId]
    );
    return result.rows;
};

const addEducation = async (profileId, data) => {
    const { school_name, degree, field_of_study, start_date, end_date, description } = data;
    const result = await pool.query(
        `INSERT INTO educations (profile_id, school_name, degree, field_of_study, start_date, end_date, description)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [profileId, school_name, degree, field_of_study, start_date, end_date, description]
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
        `SELECT c.org_id, c.name, c.slug, c.logo_url, cr.name as role,
            cm.is_primary_display, cm.is_role_visible, cr.priority
     FROM organization_members cm
     JOIN organizations c ON cm.org_id = c.org_id
     JOIN organization_roles cr ON cm.role_id = cr.role_id
     WHERE cm.user_id = $1
     ORDER BY cm.is_primary_display DESC, cr.priority DESC, c.name ASC`,
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

module.exports = {
    getFullProfile, updateUserFields, updateAvatarUrl, getAvatarUrl, updateCoverUrl,
    getIdentity, updateIdentity,
    getResume, getLatestResume, replaceResume, deleteResume,
    getProfileId,
    getExperiences, addExperience, findExperience, updateExperience, deleteExperience,
    getEducations, addEducation, updateEducation, deleteEducation,
    getSkills, deleteSkillMapping,
    getCompanyRoles, getSocialCounts, getRelationshipInfo,
    getClient,
};
