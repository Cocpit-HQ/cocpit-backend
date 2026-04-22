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
    const { role, school_name, degree, title, company_name } = req.body;

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
                `INSERT INTO educations (profile_id, school_name, degree)
                 VALUES ($1, $2, $3)`,
                [profileId, school_name, degree]
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

exports.saveInterests = async (req, res) => {
    const userId = req.user?.sub;
    const { interests } = req.body;

    const client = await pool.connect();
    try {
        if (!interests || !Array.isArray(interests) || interests.length < 3 || interests.length > 7) {
            return res.status(400).json({ success: false, message: "Please select between 3 and 7 interests" });
        }

        const validInterests = [...new Set(interests.filter(i => typeof i === "string" && i.trim().length > 0).map(i => i.trim()))];
        if (validInterests.length < 3 || validInterests.length > 7) {
            return res.status(400).json({ success: false, message: "Please select between 3 and 7 valid unique interests" });
        }

        await client.query('BEGIN');

        // 1. Fetch existing interests using single query
        const normalizedInput = validInterests.map(i => i.toLowerCase());
        const interestData = await client.query(
            `SELECT interest_id, name FROM interests WHERE LOWER(name) = ANY($1::text[])`,
            [normalizedInput]
        );

        let finalInterestIds = interestData.rows.map(r => r.interest_id);
        const existingNames = new Set(interestData.rows.map(r => r.name.toLowerCase()));

        // 2. Identify missing interests
        const missingInterests = validInterests.filter(name => !existingNames.has(name.toLowerCase()));

        // 3. Bulk insert missing interests (dynamically creating them)
        if (missingInterests.length > 0) {
            const valuesParams = missingInterests.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(", ");
            const insertParams = [];
            for (const name of missingInterests) {
                const slug = name.toLowerCase().trim().replace(/\s+/g, '-');
                insertParams.push(name, slug);
            }
            
            const insertResult = await client.query(
                `INSERT INTO interests (name, slug) VALUES ${valuesParams} RETURNING interest_id`,
                insertParams
            );
            finalInterestIds.push(...insertResult.rows.map(r => r.interest_id));
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
                selected_count: interestData.rowCount,
                interests: interestData.rows.map(r => r.name),
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
    const { name } = req.body;

    if (!Array.isArray(name) || name.length === 0) {
        return res.status(400).json({ success: false, message: "Name must be a non-empty array" });
    }

    const skillList = [...new Set(
        name.filter(s => typeof s === "string")
            .map(s => s.trim().toLowerCase().replace(/\s+/g, " ").split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" "))
            .filter(Boolean)
    )];

    if (!skillList.length) return res.status(400).json({ success: false, message: "No valid skills provided" });

    const client = await getClient();
    try {
        await client.query("BEGIN");

        const profileId = await getProfileId(req.user?.sub);
        if (!profileId) throw new Error("PROFILE_NOT_FOUND");

        await client.query(`INSERT INTO skills (name) SELECT UNNEST($1::text[]) ON CONFLICT 
            (lower(name)) DO NOTHING RETURNING skill_id, name`, [skillList]);

        const { rows: skills } = await client.query(
            `SELECT skill_id, name FROM skills WHERE lower(name) IN (SELECT lower(s) FROM UNNEST($1::text[]) AS s)`,
            [skillList]
        );

        if (skills.length > 0) {
            const values = skills.map((s, i) => `($1, $${i + 2})`).join(",");
            await client.query(
                `INSERT INTO user_skills (profile_id, skill_id) VALUES ${values} ON CONFLICT DO NOTHING`,
                [profileId, ...skills.map(s => s.skill_id)]
            );
        }

        await client.query(
            `UPDATE users SET onboarding_step = $1, updated_at = NOW() WHERE user_id = $2`,
            [ONBOARDING_STEPS.PROFILE, req.user?.sub]
        );

        await client.query("COMMIT");

        res.status(201).json({
            success: true,
            message: "Skills updated successfully",
            data: { next_step: ONBOARDING_STEPS.PROFILE }
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
        // Validate all required fields are present
        const userRes = await pool.query(`SELECT role FROM users WHERE user_id = $1`, [userId]);
        if (userRes.rowCount === 0) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        const role = userRes.rows[0].role;
        // Proceeding to complete
        // Update: isOnboardingComplete = true, onboardingStep = NULL (or final state)

        const result = await pool.query(
            `UPDATE users 
             SET is_onboarding_complete = TRUE, 
                 onboarding_step = NULL, 
                 updated_at = NOW() 
             WHERE user_id = $1
             RETURNING *`,
            [userId]
        );

        return res.status(200).json({
            success: true,
            message: "Onboarding completed successfully",
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
            [ONBOARDING_STEPS.COMPLETE, userId]
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

    try {
        const result = await pool.query(
            "SELECT 1 FROM users WHERE lower(account_name) = lower($1)",
            [account_name]
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
