/**
 * Onboarding Controller
 * Scaffolding for multi-step onboarding flow.
 */
const pool = require("../../core/db/pool");
const authRepo = require("../auth/auth.repository");
const { handleExperienceOrgLink, handleEducationOrgLink } = require("../../utils/orgLinkHelper");
const aiService = require("../../services/ai.service");
const cloudinary = require("../../core/infrastructure/cloudinary.client");

const ONBOARDING_STEPS = {
    ROLE: "ROLE",
    DETAILS: "DETAILS",
    INTERESTS: "INTERESTS",
    SKILLS: "SKILLS",
    PROFILE: "PROFILE",
    LOCATION: "LOCATION",
    COMPLETE: "COMPLETE",
};

const getClient = async () => pool.connect();

exports.saveRole = async (req, res) => {
    const userId = req.user?.sub;
    const { role } = req.body;

    if (!role) {
        return res.status(400).json({
            success: false,
            message: "Role is required"
        });
    }

    const client = await getClient();
    try {
        await client.query('BEGIN');

        let roleRes = await client.query(`SELECT role_id FROM roles WHERE role_name = $1`, [role]);
        let roleId;

        if (roleRes.rowCount > 0) {
            roleId = roleRes.rows[0].role_id;
        } else {
            const insertRoleRes = await client.query(
                `INSERT INTO roles (role_name) VALUES ($1) RETURNING role_id`,
                [role]
            );
            roleId = insertRoleRes.rows[0].role_id;
        }

        await client.query(
            `DELETE FROM user_roles WHERE user_id = $1`,
            [userId]
        );

        await client.query(
            `INSERT INTO user_roles (user_id, role_id)
             VALUES ($1, $2)`,
            [userId, roleId]
        );

        // When role is updated/changed on Step 2, clear previous background records in the database
        const profileId = await getProfileId(userId);
        if (profileId) {
            await client.query(`DELETE FROM educations WHERE profile_id = $1`, [profileId]);
            await client.query(`DELETE FROM experiences WHERE profile_id = $1`, [profileId]);
        }

        await client.query(
            `UPDATE users SET onboarding_step = $1, updated_at = NOW() WHERE user_id = $2`,
            [ONBOARDING_STEPS.DETAILS, userId]
        );

        await client.query('COMMIT');

        return res.status(200).json({
            success: true,
            message: "Role saved successfully",
            data: { next_step: ONBOARDING_STEPS.DETAILS }
        });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Save role error:", err);

        return res.status(500).json({
            success: false,
            message: "Failed to save role"
        });
    } finally {
        client.release();
    }
};
exports.saveDetails = async (req, res) => {
    const userId = req.user?.sub;
    const { role, school_name, school_org_id, degree, field_of_study, location, work_type, work_mode, title, company_name, org_id, educations, experiences } = req.body;

    const allowedRoles = ["student", "fresher", "intern", "self_employed", "employed", "unemployed"];
    if (!allowedRoles.includes(role)) {
        return res.status(400).json({ success: false, message: "Invalid role" });
    }

    const client = await getClient();
    try {
        await client.query('BEGIN');

        let profileId = await getProfileId(userId);
        if (!profileId) {
            console.log(`[Onboarding] Profile missing for user ${userId}. Auto-creating...`);
            await authRepo.createProfile(userId, role, client);
            profileId = await getProfileId(userId);
        }

        // Since this is the onboarding flow, if a user goes back and uploads a new resume,
        // we must clear out any previously saved educations/experiences to prevent duplication.
        await client.query(`DELETE FROM educations WHERE profile_id = $1`, [profileId]);
        await client.query(`DELETE FROM experiences WHERE profile_id = $1`, [profileId]);

        // Helper to parse diverse date formats from AI
        const parseDate = (d) => {
            if (!d) return null;
            if (typeof d !== 'string') return null;
            if (d.match(/^\d{4}-\d{2}-\d{2}$/)) return d;
            if (d.match(/^\d{4}-\d{2}$/)) return d + '-01';
            if (d.match(/^\d{2}\/\d{4}$/)) {
                const [m, y] = d.split('/');
                return `${y}-${m}-01`;
            }
            if (d.match(/^\d{4}$/)) return `${d}-01-01`;

            // Fallback to JS Date parser for text dates (e.g. "Jan 2024")
            const dateObj = new Date(d);
            if (!isNaN(dateObj.getTime())) {
                const yyyy = dateObj.getFullYear();
                const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
                const dd = String(dateObj.getDate()).padStart(2, '0');
                return `${yyyy}-${mm}-${dd}`;
            }
            return null;
        };

        const isStudentRole = ["student", "fresher", "unemployed"].includes(role);
        const isEmployedRole = ["self_employed", "employed", "intern"].includes(role);

        // ── PRIMARY insert: based on the user's declared role ───────────────
        if (isStudentRole) {
            // Student path: save primary education entry
            const eduData = { school_name, school_org_id, degree, field_of_study, location };
            await handleEducationOrgLink(client, userId, eduData);

            let startDate = null;
            let endDate = null;
            let primaryEduDesc = null;
            let primaryEduLocation = eduData.location;
            if (Array.isArray(educations) && educations.length > 0) {
                startDate = parseDate(educations[0].startDate);
                endDate = parseDate(educations[0].endDate);
                primaryEduDesc = educations[0].description || null;
                if (!primaryEduLocation) primaryEduLocation = educations[0].location;
            }
            await client.query(
                `INSERT INTO educations (profile_id, school_name, school_org_id, degree, field_of_study, location, start_date, end_date, description)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                [profileId, eduData.school_name, eduData.school_org_id || null, eduData.degree, eduData.field_of_study || null, primaryEduLocation || null, startDate, endDate, primaryEduDesc]
            );

        } else if (isEmployedRole) {
            // Employed path: save primary experience entry
            const expData = { title, company_name, location, work_type, work_mode, org_id };
            await handleExperienceOrgLink(client, userId, expData);

            let startDate = null;
            let endDate = null;
            let primaryExpDesc = null;
            let primaryExpLocation = expData.location;
            if (Array.isArray(experiences) && experiences.length > 0) {
                startDate = parseDate(experiences[0].startDate);
                endDate = parseDate(experiences[0].endDate);
                primaryExpDesc = experiences[0].description || null;
                if (!primaryExpLocation) primaryExpLocation = experiences[0].location;
            }
            await client.query(
                `INSERT INTO experiences (profile_id, title, company_name, location, work_type, work_mode, org_id, start_date, end_date, description)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                [profileId, expData.title, expData.company_name, primaryExpLocation || null, expData.work_type || null, expData.work_mode || null, expData.org_id || null, startDate, endDate, primaryExpDesc]
            );
        }
        // unemployed: no primary education or experience is saved

        // ── BULK insert: additional parsed entries from AI ──────────────────
        //
        // Role-based rules:
        //   student / fresher / intern  → Education ONLY  (no experience saved)
        //   employed / self_employed    → Both education AND experience
        //   unemployed                  → Both education AND experience

        // Save all additional educations:
        //   - For student roles  → skip index 0 (already inserted as primary above)
        //   - For employed/unemployed roles → save ALL education
        if (Array.isArray(educations) && educations.length > 0) {
            const extraEducations = isStudentRole ? educations.slice(1) : educations.slice(0);
            for (const edu of extraEducations) {
                const startDate = parseDate(edu.startDate);
                const endDate = parseDate(edu.endDate);
                await client.query(
                    `INSERT INTO educations (profile_id, school_name, degree, field_of_study, location, start_date, end_date)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [profileId, edu.schoolName, edu.degree, edu.fieldOfStudy || null, edu.location || null, startDate, endDate]
                );
            }
        }

        // Save experiences ONLY for employed / self_employed / unemployed roles.
        // Students, freshers and interns NEVER get experiences saved from the resume,
        // even if their resume contains past jobs.
        if (!isStudentRole && Array.isArray(experiences) && experiences.length > 0) {
            const extraExperiences = isEmployedRole ? experiences.slice(1) : experiences.slice(0);
            for (const exp of extraExperiences) {
                const startDate = parseDate(exp.startDate);
                const endDate = parseDate(exp.endDate);
                await client.query(
                    `INSERT INTO experiences (profile_id, title, company_name, location, description, start_date, end_date)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [profileId, exp.jobTitle, exp.companyName, exp.location || null, exp.description || null, startDate, endDate]
                );
            }
        }

        await client.query(
            `UPDATE users SET onboarding_step = $1, updated_at = NOW() WHERE user_id = $2`,
            [ONBOARDING_STEPS.SKILLS, userId]
        );

        await client.query('COMMIT');

        return res.status(200).json({
            success: true,
            message: "Details saved successfully",
            data: { next_step: ONBOARDING_STEPS.SKILLS }
        });
    } catch (err) {
        await client.query('ROLLBACK');
        if (err.message === "PROFILE_NOT_FOUND") return res.status(404).json({ success: false, message: "Profile not found" });
        console.error("Save details error:", err);
        return res.status(500).json({ success: false, message: "Internal server error" });
    } finally {
        client.release();
    }
};

exports.getInterests = async (req, res) => {
    const { q = "", cursor: rawCursor = "", limit: rawLimit = "20" } = req.query;

    const limit = Math.min(50, Math.max(1, parseInt(rawLimit, 10) || 20));
    const trimmedQ = q.trim();
    const searchPattern = trimmedQ.length >= 3 ? `%${trimmedQ}%` : null;

    // Decode cursor — base64(name of last seen item)
    let cursorName = null;
    if (rawCursor) {
        try {
            cursorName = Buffer.from(rawCursor, "base64").toString("utf8");
        } catch (_) {
            return res.status(400).json({ success: false, message: "Invalid cursor" });
        }
    }

    try {
        // Fetch limit+1 rows so we can detect if there's a next page
        const dataRes = await pool.query(
            `SELECT interest_id, name, slug, category, icon_url, usage_count
             FROM interests
             WHERE is_active = TRUE
               AND ($1::text IS NULL OR name ILIKE $1 OR slug ILIKE $1)
               AND ($2::text IS NULL OR LOWER(name) > LOWER($2))
               AND name !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             ORDER BY LOWER(name) ASC
             LIMIT $3`,
            [searchPattern, cursorName, limit + 1]
        );

        const rows = dataRes.rows;
        const has_more = rows.length > limit;
        const items = has_more ? rows.slice(0, limit) : rows;

        // Encode cursor from last returned item's name
        const next_cursor = has_more
            ? Buffer.from(items[items.length - 1].name, "utf8").toString("base64")
            : null;

        return res.status(200).json({
            success: true,
            data: {
                items,
                next_cursor,
                has_more
            }
        });
    } catch (err) {
        console.error("Get interests error:", err);
        return res.status(500).json({ success: false, message: "Internal server error" });
    }
};

exports.getSkills = async (req, res) => {
    const { q = "", cursor: rawCursor = "", limit: rawLimit = "20" } = req.query;

    const limit = Math.min(50, Math.max(1, parseInt(rawLimit, 10) || 20));
    const trimmedQ = q.trim();
    const searchPattern = trimmedQ.length >= 3 ? `%${trimmedQ}%` : null;

    // Decode cursor — base64(name of last seen item)
    let cursorName = null;
    if (rawCursor) {
        try {
            cursorName = Buffer.from(rawCursor, "base64").toString("utf8");
        } catch (_) {
            return res.status(400).json({ success: false, message: "Invalid cursor" });
        }
    }

    try {
        // Fetch limit+1 rows so we can detect if there's a next page
        const dataRes = await pool.query(
            `SELECT skill_id, name
             FROM skills
             WHERE is_active = TRUE
               AND ($1::text IS NULL OR name ILIKE $1)
               AND ($2::text IS NULL OR LOWER(name) > LOWER($2))
               AND name !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             ORDER BY LOWER(name) ASC
             LIMIT $3`,
            [searchPattern, cursorName, limit + 1]
        );

        const rows = dataRes.rows;
        const has_more = rows.length > limit;
        const items = has_more ? rows.slice(0, limit) : rows;

        // Encode cursor from last returned item's name
        const next_cursor = has_more
            ? Buffer.from(items[items.length - 1].name, "utf8").toString("base64")
            : null;

        return res.status(200).json({
            success: true,
            data: {
                items,
                next_cursor,
                has_more
            }
        });
    } catch (err) {
        console.error("Get skills error:", err);
        return res.status(500).json({ success: false, message: "Internal server error" });
    }
};

exports.saveInterests = async (req, res) => {
    const userId = req.user?.sub;
    const { interests } = req.body;

    const client = await pool.connect();
    try {
        if (!interests || !Array.isArray(interests) || interests.length < 3 || interests.length > 7) {
            return res.status(400).json({ success: false, message: "Please select between 3 and 7 interests" });
        }

        const rawInterests = interests
            .filter(i => typeof i === "string" && i.trim().length > 0)
            .map(i => i.trim());

        // Deduplicate by slug to prevent same-request collisions
        const uniqueMap = new Map();
        for (const name of rawInterests) {
            const slug = name.toLowerCase().replace(/\s+/g, '-');
            if (!uniqueMap.has(slug)) {
                uniqueMap.set(slug, name);
            }
        }

        const deduplicatedNames = Array.from(uniqueMap.values());
        const deduplicatedSlugs = Array.from(uniqueMap.keys());

        if (deduplicatedNames.length < 3 || deduplicatedNames.length > 7) {
            return res.status(400).json({ success: false, message: "Please select between 3 and 7 valid unique interests" });
        }

        await client.query('BEGIN');

        // 1. Fetch existing interests using name or slug (case-insensitive)
        const normalizedNames = deduplicatedNames.map(n => n.toLowerCase());
        const interestData = await client.query(
            `SELECT interest_id, name, slug FROM interests WHERE LOWER(name) = ANY($1::text[]) OR LOWER(slug) = ANY($1::text[])`,
            [normalizedNames]
        );

        let finalInterestIds = interestData.rows.map(r => r.interest_id);
        const existingNames = new Set(interestData.rows.map(r => r.name.toLowerCase()));
        const existingSlugs = new Set(interestData.rows.map(r => r.slug.toLowerCase()));

        // 2. Identify missing interests
        const missingEntries = Array.from(uniqueMap.entries()).filter(([slug, name]) => 
            !existingNames.has(name.toLowerCase()) && !existingSlugs.has(slug.toLowerCase())
        );

        // 3. Bulk insert missing interests safely
        if (missingEntries.length > 0) {
            const valuesParams = missingEntries.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(", ");
            const insertParams = [];
            for (const [slug, name] of missingEntries) {
                insertParams.push(name, slug);
            }

            const insertRes = await client.query(
                `INSERT INTO interests (name, slug) VALUES ${valuesParams} 
                 ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name 
                 RETURNING interest_id`,
                insertParams
            );
            finalInterestIds.push(...insertRes.rows.map(r => r.interest_id));
        }

        // Deduplicate final IDs
        finalInterestIds = [...new Set(finalInterestIds)];

        // 4. Batch mapping assignment into user_interests (replace previous user_interests)
        await client.query(`DELETE FROM user_interests WHERE user_id = $1`, [userId]);

        if (finalInterestIds.length > 0) {
            const values = finalInterestIds.map((_, i) => `($1, $${i + 2}, 'onboarding', 5.0)`).join(", ");
            await client.query(
                `INSERT INTO user_interests (user_id, interest_id, source, score)
                 VALUES ${values}
                 ON CONFLICT (user_id, interest_id) DO UPDATE SET 
                    score = LEAST(user_interests.score + EXCLUDED.score, 100.0),
                    updated_at = NOW()`,
                [userId, ...finalInterestIds]
            );

            // Increment usage count for interests natively
            await client.query(
                `UPDATE interests 
                 SET usage_count = usage_count + 1 
                 WHERE interest_id = ANY($1::uuid[])`,
                [finalInterestIds]
            );
        }

        // Update onboarding_step in users table
        await client.query(
            `UPDATE users 
             SET onboarding_step = $1, 
                 updated_at = NOW() 
             WHERE user_id = $2`,
            [ONBOARDING_STEPS.COMPLETE, userId]
        );

        await client.query('COMMIT');

        return res.status(200).json({
            success: true,
            message: "Interests saved successfully",
            data: {
                selected_count: finalInterestIds.length,
                next_step: ONBOARDING_STEPS.COMPLETE
            }
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Save interests error:", err);
        return res.status(500).json({ success: false, message: "Internal server error" });
    } finally {
        client.release();
    }
};

exports.saveSkills = async (req, res) => {
    const { skills } = req.body;

    if (!Array.isArray(skills) || skills.length === 0) {
        return res.status(400).json({ success: false, message: "Skills must be a non-empty array" });
    }

    const skillList = [...new Set(
        skills.filter(s => typeof s === "string")
            .map(s => s.trim().toLowerCase().replace(/\s+/g, " ").split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" "))
            .filter(Boolean)
    )];

    if (skillList.length < 3 || skillList.length > 7) {
        return res.status(400).json({ success: false, message: "Please select between 3 and 7 valid unique skills" });
    }

    const client = await getClient();
    try {
        await client.query("BEGIN");

        const profileId = await getProfileId(req.user?.sub);
        if (!profileId) throw new Error("PROFILE_NOT_FOUND");

        // 1. Fetch existing skills using single query
        const normalizedInput = skillList.map(s => s.toLowerCase());
        const skillData = await client.query(
            `SELECT skill_id, name FROM skills WHERE LOWER(name) = ANY($1::text[])`,
            [normalizedInput]
        );

        let finalSkillIds = skillData.rows.map(r => r.skill_id);
        const existingNames = new Set(skillData.rows.map(r => r.name.toLowerCase()));

        // 2. Identify missing skills
        const missingSkills = skillList.filter(name => !existingNames.has(name.toLowerCase()));

        // 3. Bulk insert missing skills (dynamically creating them)
        if (missingSkills.length > 0) {
            const valuesParams = missingSkills.map((_, i) => `($${i + 1})`).join(", ");
            const insertResult = await client.query(
                `INSERT INTO skills (name) VALUES ${valuesParams} RETURNING skill_id`,
                missingSkills
            );
            finalSkillIds.push(...insertResult.rows.map(r => r.skill_id));
        }

        // 4. Batch mapping assignment into user_skills
        if (finalSkillIds.length > 0) {
            const values = finalSkillIds.map((_, i) => `($1, $${i + 2})`).join(",");
            await client.query(
                `INSERT INTO user_skills (profile_id, skill_id) VALUES ${values} ON CONFLICT DO NOTHING`,
                [profileId, ...finalSkillIds]
            );
        }

        await client.query(
            `UPDATE users SET onboarding_step = $1, updated_at = NOW() WHERE user_id = $2`,
            [ONBOARDING_STEPS.INTERESTS, req.user?.sub]
        );

        await client.query("COMMIT");

        res.status(201).json({
            success: true,
            message: "Skills updated successfully",
            data: { next_step: ONBOARDING_STEPS.INTERESTS }
        });
    } catch (err) {
        await client.query("ROLLBACK");
        if (err.message === "PROFILE_NOT_FOUND") return res.status(404).json({ success: false, message: "Profile not found" });
        console.error("Add skills error:", err);
        res.status(500).json({ success: false, message: "Internal server error" });
    } finally {
        client.release();
    }
};

exports.completeOnboarding = async (req, res) => {
    const userId = req.user?.sub;

    try {
        // Validate user existence and fetch role from user_roles
        const userRes = await pool.query(
            `SELECT u.user_id, r.role_name as role 
             FROM users u 
             LEFT JOIN user_roles ur ON u.user_id = ur.user_id 
             LEFT JOIN roles r ON ur.role_id = r.role_id 
             WHERE u.user_id = $1`,
            [userId]
        );

        if (userRes.rowCount === 0) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        if (userRes.rows[0].is_onboarding_complete) {
            return res.status(400).json({ success: false, error: "Already completed" });
        }

        // Mark onboarding as complete

        const result = await pool.query(
            `UPDATE users 
             SET is_onboarding_complete = TRUE, 
                 onboarding_step = NULL, 
                 updated_at = NOW() 
             WHERE user_id = $1
             RETURNING *`,
            [userId]
        );

        console.log(`[Onboarding] ✅ Completed successfully for user: ${userId}`);

        const { signAccessToken } = require("../../core/utils/jwt");
        const newAccessToken = signAccessToken({
            sub: userId,
            sid: req.user?.sid,
            roles: req.user?.roles || [],
            onboarding_complete: true,
        });

        return res.status(200).json({
            success: true,
            message: "Onboarding completed successfully",
            accessToken: newAccessToken,
            data: result.rows[0]
        });
    } catch (err) {
        console.error("Complete onboarding error:", err);
        return res.status(500).json({ success: false, message: "Internal server error" });
    }
};

// TODO: Modular Profile and Location Update APIs

exports.updateProfile = async (req, res) => {
    const userId = req.user?.sub;
    let { account_name, full_name, avatar_url, dob } = req.body;

    if (req.file) {
        avatar_url = req.file.path.replace(/\\/g, "/");
    }

    // Validate account_name if present
    if (account_name !== undefined && (!account_name || String(account_name).trim() === "")) {
        return res.status(400).json({ success: false, message: "Account name cannot be empty" });
    }

    if (dob !== undefined && (!dob || String(dob).trim() === "")) {
        return res.status(400).json({ success: false, message: "Date of birth is required" });
    }

    try {
        const result = await pool.query(
            `UPDATE users
             SET account_name = COALESCE($1, account_name),
                 full_name = COALESCE($2, full_name),
                 avatar_url = COALESCE($3, avatar_url),
                 dob = COALESCE($4, dob),
                 updated_at = NOW()
             WHERE user_id = $5
             RETURNING *`,
            [
                account_name !== undefined ? account_name : null,
                full_name !== undefined ? full_name : null,
                avatar_url !== undefined ? avatar_url : null,
                dob !== undefined ? dob : null,
                userId
            ]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        await pool.query(
            `UPDATE users SET onboarding_step = $1 WHERE user_id = $2`,
            [ONBOARDING_STEPS.LOCATION, userId]
        );

        return res.status(200).json({
            success: true,
            message: "Profile updated successfully",
            data: { ...result.rows[0], next_step: ONBOARDING_STEPS.LOCATION }
        });

    } catch (err) {
        console.error("Update profile error:", err);
        if (err.code === '23505') {
            return res.status(409).json({ success: false, message: "Account name already taken" });
        }
        return res.status(500).json({ success: false, message: "Internal server error" });
    }
};

exports.updateLocation = async (req, res) => {
    const userId = req.user?.sub;
    const { location, country, state, city, formattedAddress, latitude, longitude, placeId } = req.body;

    // New Google Places mode
    const ALLOWED_COUNTRIES = ["India", "United Arab Emirates", "Japan"];
    if (!ALLOWED_COUNTRIES.includes(country)) {
        return res.status(400).json({
            success: false, message: "Location must be in India, UAE, or Japan",
            code: "INVALID_LOCATION_COUNTRY"
        });
    }

    try {
        await pool.query(
            `UPDATE users
             SET location           = $1,
                 location_formatted = $1,
                 location_country   = $2,
                 location_state     = $3,
                 location_city      = $4,
                 location_lat       = $5,
                 location_lng       = $6,
                 location_place_id  = $7,
                 updated_at         = NOW()
             WHERE user_id = $8`,
            [formattedAddress, country, state || null, city,
                latitude || null, longitude || null, placeId, userId]
        );

        await pool.query(`UPDATE users SET onboarding_step = $1 WHERE user_id = $2`, [ONBOARDING_STEPS.ROLE, userId]);

        const crypto = require("crypto");
        console.log(JSON.stringify({
            event: "location_saved",
            country: country,
            has_coordinates: !!(latitude && longitude),
            user_id_hash: crypto.createHash("sha256").update(userId).digest("hex").slice(0, 8),
        }));

        return res.json({
            success: true,
            message: "Location updated",
            data: { location_formatted: formattedAddress, location_country: country, location_city: city, next_step: ONBOARDING_STEPS.COMPLETE }
        });
    } catch (err) {
        console.error("Update location error:", err);
        return res.status(500).json({ success: false, message: "Internal server error" });
    }
};

exports.checkAccountName = async (req, res) => {
    const { account_name } = req.query;
    const userId = req.user?.sub;

    try {
        const result = await pool.query(
            "SELECT 1 FROM users WHERE lower(account_name) = lower($1) AND user_id != $2",
            [account_name, userId]
        );

        const available = result.rowCount === 0;
        return res.json({ available });
    } catch (err) {
        console.error("Check account name error:", err);
        return res.status(500).json({ message: "Internal server error" });
    }
};

const getProfileId = async (userId) => {
    const result = await pool.query(`SELECT profile_id FROM profiles WHERE user_id = $1`, [userId]);
    return result.rows[0]?.profile_id || null;
};

/**
 * Handle resume upload, pass to AI for parsing, and return structured data.
 */
exports.parseResumeUpload = async (req, res) => {
    try {
        const userId = req.user?.sub;
        if (!req.file) {
            return res.status(400).json({ success: false, message: "No resume file uploaded." });
        }

        // We receive the file buffer from multer (memoryStorage expected)
        const fileBuffer = req.file.buffer;
        const mimeType = req.file.mimetype;

        // Optionally, ensure it's a PDF or DOCX
        const allowedMimes = ["application/pdf"];
        if (!allowedMimes.includes(mimeType)) {
            return res.status(415).json({ success: false, message: "Unsupported file type. Please upload a PDF." });
        }

        if (req.file.size > 5 * 1024 * 1024) {
            return res.status(413).json({ success: false, message: "File is too large (max 5MB)." });
        }

        const sourceIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

        // Upload to Cloudinary concurrently while parsing with AI
        const uploadToCloudinary = () => {
            return new Promise((resolve, reject) => {
                const stream = cloudinary.uploader.upload_stream(
                    { folder: "resumes", resource_type: "raw", public_id: `resume_${userId}_${Date.now()}.pdf` },
                    (error, result) => {
                        if (error) reject(error);
                        else resolve(result);
                    }
                );
                const { Readable } = require('stream');
                Readable.from(fileBuffer).pipe(stream);
            });
        };

        const [parsedData, cloudinaryResult] = await Promise.all([
            aiService.parseResume({
                fileBuffer,
                mimeType,
                userId,
                sourceIp
            }),
            uploadToCloudinary().catch(e => {
                console.error("Cloudinary upload failed:", e);
                return null;
            })
        ]);

        if (cloudinaryResult) {
            // Save to DB
            try {
                await pool.query(
                    `INSERT INTO user_resumes (user_id, file_name, file_url, file_type, file_size)
                     VALUES ($1, $2, $3, $4, $5)`,
                    [userId, req.file.originalname, cloudinaryResult.secure_url, mimeType, req.file.size]
                );
            } catch (dbErr) {
                console.error("Failed to save resume URL to DB:", dbErr);
            }
        }

        // Strip bracketed text and enforce maximum 14 skills to comply with onboarding schema validation
        if (parsedData && Array.isArray(parsedData.skills)) {
            parsedData.skills = parsedData.skills
                .map(skill => skill.replace(/\s*[([].*?[)\]]/g, '').trim())
                .filter(Boolean)
                .slice(0, 14);
        }

        const cleanIsoDate = (dateStr) => {
            if (!dateStr || typeof dateStr !== 'string') return null;
            let date = dateStr.trim();
            if (date.toLowerCase() === 'present' || date.toLowerCase() === 'current') return 'Present';
            if (date.includes("T") && date.endsWith("Z")) {
                date = date.split("T")[0];
            }
            // Scenario 4: Default bare year to January 1st
            if (date.match(/^\d{4}$/)) {
                date = `${date}-01-01`;
            } else if (date.match(/^\d{4}-\d{2}$/)) {
                date = `${date}-01`;
            } else if (date.match(/^\d{2}\/\d{4}$/)) {
                const [m, y] = date.split('/');
                date = `${y}-${m}-01`;
            }
            return date;
        };

        const processDates = (item) => {
            let start = cleanIsoDate(item.startDate);
            let end = cleanIsoDate(item.endDate);

            // AI parser puts single graduation/end years into endDate and leaves startDate null.
            // If startDate is present but endDate is null, it accurately indicates an ongoing role.
            // No manual date shifting (old Scenario 2) is needed anymore.

            // Truncate description to 1500 characters
            let description = item.description;
            if (description && description.length > 1500) {
                description = description.substring(0, 1497) + "...";
            }

            return { ...item, startDate: start, endDate: end, description };
        };

        if (parsedData) {
            // Scenario 3: Remove .filter() to allow missing dates
            if (Array.isArray(parsedData.workExperience)) {
                parsedData.workExperience = parsedData.workExperience.map(processDates);
            }
            if (Array.isArray(parsedData.education)) {
                parsedData.education = parsedData.education.map(processDates);
            }
        }

        return res.status(200).json({
            success: true,
            data: parsedData,
            message: "Resume parsed successfully."
        });
    } catch (err) {
        console.error("Resume parse error:", err);

        // Return the actual error message if it comes from the Gemini API (like 404 Model Not Found)
        if (err.status === 404 || err.status === 400 || err.status === 401) {
            return res.status(err.status).json({ success: false, message: `AI Service Error: ${err.message}` });
        }

        if (err.statusCode === 503 || err.statusCode === 502) {
            return res.status(err.statusCode).json({ success: false, message: err.message });
        }

        return res.status(422).json({ success: false, message: "Failed to parse resume reliably." });
    }
};

const MASTER_STATUS_OPTIONS = [
    { id: "employed", label: "Employed" },
    { id: "self_employed", label: "Self-employed" },
    { id: "student", label: "Student" },
    { id: "fresher", label: "Fresher" },
    { id: "intern", label: "Intern" },
    { id: "unemployed", label: "Currently not working" }
];

const MASTER_INDUSTRIES = [
    "Accounting", "Airlines/Aviation", "Alternative Dispute Resolution", "Alternative Medicine",
    "Animation", "Apparel & Fashion", "Architecture & Planning", "Arts & Crafts",
    "Automotive", "Aviation & Aerospace", "Banking", "Biotechnology",
    "Broadcast Media", "Building Materials", "Business Supplies & Equipment",
    "Capital Markets", "Chemicals", "Civic & Social Organization", "Civil Engineering",
    "Commercial Real Estate", "Computer & Network Security", "Computer Games",
    "Computer Hardware", "Computer Networking", "Computer Software", "Construction",
    "Consumer Electronics", "Consumer Goods", "Consumer Services", "Cosmetics",
    "Dairy", "Defense & Space", "Design", "E-Learning", "Education Management",
    "Electrical/Electronic Manufacturing", "Entertainment", "Environmental Services",
    "Events Services", "Executive Office", "Facilities Services", "Farming",
    "Financial Services", "Fine Art", "Fishery", "Food & Beverages",
    "Food Production", "Fund-Raising", "Furniture", "Gambling & Casinos",
    "Glass, Ceramics & Concrete", "Government Administration", "Government Relations",
    "Graphic Design", "Health, Wellness & Fitness", "Higher Education",
    "Hospital & Health Care", "Hospitality", "Human Resources", "Import & Export",
    "Individual & Family Services", "Industrial Automation", "Information Services",
    "Information Technology & Services", "Insurance", "International Affairs",
    "International Trade & Development", "Internet", "Investment Banking",
    "Investment Management", "Judiciary", "Law Enforcement", "Law Practice",
    "Legal Services", "Legislative Offices", "Leisure, Travel & Tourism",
    "Libraries", "Logistics & Supply Chain", "Luxury Goods & Jewelry",
    "Machinery", "Management Consulting", "Maritime", "Market Research",
    "Marketing & Advertising", "Mechanical or Industrial Engineering", "Media Production",
    "Medical Devices", "Medical Practice", "Mental Health Care", "Military",
    "Mining & Metals", "Motion Pictures & Film", "Museums & Institutions",
    "Music", "Nanotechnology", "Newspapers", "Non-Profit Organization Management",
    "Oil & Energy", "Online Media", "Outsourcing/Offshoring", "Package/Freight Delivery",
    "Packaging & Containers", "Paper & Forest Products", "Performing Arts",
    "Pharmaceuticals", "Philanthropy", "Photography", "Plastics",
    "Political Organization", "Primary/Secondary Education", "Printing",
    "Professional Training & Coaching", "Program Development", "Public Policy",
    "Public Relations & Communications", "Public Safety", "Publishing",
    "Railroad Manufacture", "Ranching", "Real Estate", "Recreational Facilities & Services",
    "Religious Institutions", "Renewables & Environment", "Research",
    "Restaurants", "Retail", "Security & Investigations", "Semiconductors",
    "Shipbuilding", "Sporting Goods", "Sports", "Staffing & Recruiting",
    "Supermarkets", "Telecommunications", "Textiles", "Think Tanks",
    "Tobacco", "Translation & Localization", "Transportation/Trucking/Railroad",
    "Utilities", "Venture Capital & Private Equity", "Veterinary",
    "Warehousing", "Wholesale", "Wine & Spirits", "Wireless", "Writing & Editing"
];

exports.getOnboardingOptions = async (req, res) => {
    const { slug } = req.params;
    const { q = "" } = req.query;
    const query = q.toLowerCase().trim();

    try {
        if (slug === "status") {
            const filtered = query
                ? MASTER_STATUS_OPTIONS.filter(o => o.label.toLowerCase().includes(query))
                : MASTER_STATUS_OPTIONS;
            return res.status(200).json({ success: true, data: filtered });
        }

        if (slug === "industries" || slug === "industry") {
            try {
                // 1. Query the clean industries_master table for official industries
                const masterRes = await pool.query(
                    `SELECT industry_name AS label 
                     FROM industries_master 
                     WHERE industry_name ILIKE $1 
                     ORDER BY industry_name ASC LIMIT 50`,
                    [`%${query}%`]
                );
                
                // If the DB returned results, return them!
                if (masterRes.rows.length > 0) {
                    const formatted = masterRes.rows.map(r => ({ id: r.label, label: r.label }));
                    return res.status(200).json({ success: true, data: formatted });
                }
                
                // If DB query worked but returned 0 results, fall through to fallback below...
            } catch (dbErr) {
                console.error("Database error fetching industries, using fallback:", dbErr);
                // Fall through to hardcoded list...
            }

            // 2. THE FALLBACK: Hardcoded MASTER_INDUSTRIES array
            const formattedFallback = MASTER_INDUSTRIES
                .filter(name => !query || name.toLowerCase().includes(query))
                .slice(0, 50)
                .map(name => ({ id: name, label: name }));

            return res.status(200).json({ success: true, data: formattedFallback });
        }

        return res.status(400).json({ success: false, message: `Invalid options slug: ${slug}` });
    } catch (err) {
        console.error("Get onboarding options error:", err);
        return res.status(500).json({ success: false, message: "Failed to fetch options" });
    }
};

exports.saveSituation = async (req, res) => {
    const userId = req.user?.sub;
    const { status, industry, location, placeId, formattedAddress, country, state, city, latitude, longitude } = req.body;

    if (!userId) {
        return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const locFormatted = formattedAddress || (typeof location === 'string' ? location : location?.formattedAddress);
    const locCountry = country || (typeof location === 'object' ? location?.country : null);
    const locState = state || (typeof location === 'object' ? location?.state : null);
    const locCity = city || (typeof location === 'object' ? location?.city : null);
    const locLat = latitude !== undefined ? latitude : (typeof location === 'object' ? location?.latitude : null);
    const locLng = longitude !== undefined ? longitude : (typeof location === 'object' ? location?.longitude : null);
    const locPlaceId = placeId || (typeof location === 'object' ? location?.placeId : null);

    if (!locFormatted || String(locFormatted).trim() === "") {
        return res.status(400).json({ success: false, message: "Location is required" });
    }

    const ALLOWED_COUNTRIES = ["India", "United Arab Emirates", "Japan"];
    if (locCountry && !ALLOWED_COUNTRIES.includes(locCountry)) {
        return res.status(400).json({
            success: false,
            message: "Location must be in India, UAE, or Japan",
            code: "INVALID_LOCATION_COUNTRY"
        });
    }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // 1. Assign role
        const roleName = status.toLowerCase().trim();
        const roleRes = await client.query("SELECT role_id FROM roles WHERE LOWER(role_name) = $1", [roleName]);
        let roleId;
        if (roleRes.rows.length > 0) {
            roleId = roleRes.rows[0].role_id;
        } else {
            const newRole = await client.query(
                "INSERT INTO roles (role_name) VALUES ($1) ON CONFLICT (role_name) DO UPDATE SET role_name = EXCLUDED.role_name RETURNING role_id",
                [roleName]
            );
            roleId = newRole.rows[0].role_id;
        }

        // Delete any existing user role before inserting new role to prevent multiple active roles
        await client.query(
            "DELETE FROM user_roles WHERE user_id = $1",
            [userId]
        );

        await client.query(
            "INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)",
            [userId, roleId]
        );

        // 2. Determine next step
        const nextStep = roleName === "unemployed" ? ONBOARDING_STEPS.INTERESTS : ONBOARDING_STEPS.DETAILS;

        // 3. Update users table with location & onboarding_step
        await client.query(
            `UPDATE users
             SET location           = COALESCE($1, location),
                 location_formatted = COALESCE($1, location_formatted),
                 location_country   = COALESCE($2, location_country),
                 location_state     = COALESCE($3, location_state),
                 location_city      = COALESCE($4, location_city),
                 location_lat       = COALESCE($5, location_lat),
                 location_lng       = COALESCE($6, location_lng),
                 location_place_id  = COALESCE($7, location_place_id),
                 onboarding_step    = $8,
                 updated_at         = NOW()
             WHERE user_id = $9`,
            [
                locFormatted,
                locCountry,
                locState,
                locCity,
                locLat,
                locLng,
                locPlaceId,
                nextStep,
                userId
            ]
        );

        // 4. Update profiles working_industry if provided
        if (industry !== undefined) {
            const cleanIndustry = industry ? String(industry).trim() : null;
            await client.query(
                `INSERT INTO profiles (user_id, working_industry, updated_at)
                 VALUES ($1, $2, NOW())
                 ON CONFLICT (user_id)
                 DO UPDATE SET working_industry = $2, updated_at = NOW()`,
                [userId, cleanIndustry]
            );
        }

        await client.query("COMMIT");

        return res.status(200).json({
            success: true,
            message: "Situation and location updated successfully",
            data: {
                status: roleName,
                industry: industry || null,
                location_formatted: locFormatted,
                location_country: locCountry,
                location_city: locCity,
                next_step: nextStep
            }
        });
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Save situation error:", err);
        return res.status(500).json({ success: false, message: "Failed to save situation and location" });
    } finally {
        client.release();
    }
};

