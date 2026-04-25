/**
 * Onboarding Controller
 * Scaffolding for multi-step onboarding flow.
 */
const pool = require("../../core/db/pool");

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
            `INSERT INTO user_roles (user_id, role_id)
             VALUES ($1, $2)
             ON CONFLICT DO NOTHING`,
            [userId, roleId]
        );

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
    const { role, school_name, school_org_id, degree, field_of_study, title, company_name } = req.body;

    const allowedRoles = ["student", "fresher", "intern", "self_employed", "employed", "unemployed"];
    if (!allowedRoles.includes(role)) {
        return res.status(400).json({ success: false, message: "Invalid role" });
    }

    const client = await getClient();
    try {
        await client.query('BEGIN');

        const profileId = await getProfileId(userId);
        if (!profileId) throw new Error("PROFILE_NOT_FOUND");

        if (["student", "fresher", "intern"].includes(role)) {
            await client.query(
                `INSERT INTO educations (profile_id, school_name, school_org_id, degree, field_of_study)
                 VALUES ($1, $2, $3, $4, $5)`,
                [profileId, school_name, school_org_id || null, degree, field_of_study || null]
            );
        } else if (["self_employed", "employed"].includes(role)) {
            await client.query(
                `INSERT INTO experiences (profile_id, title, company_name)
                 VALUES ($1, $2, $3)`,
                [profileId, title, company_name]
            );
        }

        await client.query(
            `UPDATE users SET onboarding_step = $1, updated_at = NOW() WHERE user_id = $2`,
            [ONBOARDING_STEPS.INTERESTS, userId]
        );

        await client.query('COMMIT');

        return res.status(200).json({
            success: true,
            message: "Details saved successfully",
            data: { next_step: ONBOARDING_STEPS.INTERESTS }
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
    const searchPattern = q.trim() ? `%${q.trim()}%` : null;

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
    const searchPattern = q.trim() ? `%${q.trim()}%` : null;

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

        // 1. Fetch existing interests using slug (fixes divergent formatting bugs)
        const interestData = await client.query(
            `SELECT interest_id, slug FROM interests WHERE slug = ANY($1::text[])`,
            [deduplicatedSlugs]
        );

        let finalInterestIds = interestData.rows.map(r => r.interest_id);
        const existingSlugs = new Set(interestData.rows.map(r => r.slug));

        // 2. Identify missing interests
        const missingEntries = Array.from(uniqueMap.entries()).filter(([slug]) => !existingSlugs.has(slug));

        // 3. Bulk insert missing interests safely
        if (missingEntries.length > 0) {
            const valuesParams = missingEntries.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(", ");
            const insertParams = [];
            for (const [slug, name] of missingEntries) {
                insertParams.push(name, slug);
            }
            
            await client.query(
                `INSERT INTO interests (name, slug) VALUES ${valuesParams} ON CONFLICT DO NOTHING`,
                insertParams
            );

            // Re-fetch to get IDs of newly inserted, handling concurrent inserts gracefully
            const missingSlugs = missingEntries.map(([slug]) => slug);
            const newInterestData = await client.query(
                `SELECT interest_id FROM interests WHERE slug = ANY($1::text[])`,
                [missingSlugs]
            );
            finalInterestIds.push(...newInterestData.rows.map(r => r.interest_id));
        }

        // 4. Batch mapping assignment into user_interests
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
            [ONBOARDING_STEPS.SKILLS, userId]
        );

        await client.query('COMMIT');

        return res.status(200).json({
            success: true,
            message: "Interests saved successfully",
            data: { 
                selected_count: finalInterestIds.length,
                next_step: ONBOARDING_STEPS.SKILLS
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
            [ONBOARDING_STEPS.COMPLETE, req.user?.sub]
        );

        await client.query("COMMIT");

        res.status(201).json({
            success: true,
            message: "Skills updated successfully",
            data: { next_step: ONBOARDING_STEPS.COMPLETE }
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
        // Validate user exists before completing
        const userRes = await pool.query(`SELECT user_id, is_onboarding_complete FROM users WHERE user_id = $1`, [userId]);
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
    let { account_name, full_name, avatar_url } = req.body;

    if (req.files && req.files.length > 0) {
        avatar_url = req.files[0].path.replace(/\\/g, "/");
    }

    // Validate account_name if present
    if (account_name !== undefined && (!account_name || String(account_name).trim() === "")) {
        return res.status(400).json({ success: false, message: "Account name cannot be empty" });
    }

    try {
        const result = await pool.query(
            `UPDATE users
             SET account_name = COALESCE($1, account_name),
                 full_name = COALESCE($2, full_name),
                 avatar_url = COALESCE($3, avatar_url),
                 updated_at = NOW()
             WHERE user_id = $4
             RETURNING *`,
            [
                account_name !== undefined ? account_name : null,
                full_name !== undefined ? full_name : null,
                avatar_url !== undefined ? avatar_url : null,
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
    const { location_id, location } = req.body;

    // Validate location_id and location if present
    if (location_id !== undefined && (!location_id || String(location_id).trim() === "")) {
        return res.status(400).json({ success: false, message: "Valid location_id is required" });
    }
    if (location !== undefined && (!location || String(location).trim() === "")) {
        return res.status(400).json({ success: false, message: "Valid location is required" });
    }

    try {
        const result = await pool.query(
            `UPDATE users
             SET location_id = COALESCE($1, location_id),
                 location = COALESCE($2, location),
                 updated_at = NOW()
             WHERE user_id = $3
             RETURNING *`,
            [
                location_id !== undefined ? location_id : null,
                location !== undefined ? location : null,
                userId
            ]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        await pool.query(
            `UPDATE users SET onboarding_step = $1 WHERE user_id = $2`,
            [ONBOARDING_STEPS.ROLE, userId]
        );

        return res.status(200).json({
            success: true,
            message: "Location updated successfully",
            data: { ...result.rows[0], next_step: ONBOARDING_STEPS.COMPLETE }
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
