/**
 * Onboarding Controller
 * Scaffolding for multi-step onboarding flow.
 */
const pool = require("../../core/db/pool");

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

    try {
        const query = `
            WITH role_data AS (
                SELECT role_id 
                FROM roles 
                WHERE role_name = $1
            ),
            updated AS (
                UPDATE user_roles ur
                SET role_id = rd.role_id,
                    assigned_at = NOW()
                FROM role_data rd
                WHERE ur.user_id = $2
                RETURNING ur.*
            )
            INSERT INTO user_roles (user_id, role_id)
            SELECT $2, role_id FROM role_data
            WHERE NOT EXISTS (SELECT 1 FROM updated)
            RETURNING *;
        `;

        await pool.query(query, [role, userId]);

        // ✅ If no error → success
        return res.status(200).json({
            success: true,
            message: "Role assigned/updated successfully"
        });

    } catch (err) {
        console.error("Save role error:", err);

        return res.status(500).json({
            success: false,
            message: "Failed to assign/update role"
        });
    }
};
exports.saveDetails = async (req, res) => {
    const userId = req.user?.sub;
    const { role, school_name, degree, title, company_name, headline } = req.body;

    const allowedRoles = ["student", "working", "freelancer", "not_working"];
    if (!allowedRoles.includes(role)) {
        return res.status(400).json({ success: false, message: "Invalid role" });
    }

    const client = await getClient();
    try {
        await client.query('BEGIN');

        const profileId = await getProfileId(userId);
        if (!profileId) throw new Error("PROFILE_NOT_FOUND");

        if (role === 'student' || role === 'not_working') {
            await client.query(
                `INSERT INTO educations (profile_id, school_name, degree)
                 VALUES ($1, $2, $3)`,
                [profileId, school_name, degree]
            );
        } else if (role === 'working') {
            await client.query(
                `INSERT INTO experiences (profile_id, title, company_name)
                 VALUES ($1, $2, $3)`,
                [profileId, title, company_name]
            );
        } else if (role === 'freelancer') {
            await client.query(
                `UPDATE users 
                 SET headline = $1 
                 WHERE user_id = $2`,
                [headline, userId]
            );
        }

        await client.query('COMMIT');

        return res.status(200).json({
            success: true,
            message: "Details saved successfully"
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
        // Validate min 3
        if (!interests || interests.length < 3) {
            return res.status(400).json({ success: false, message: "Minimum 3 interests required" });
        }

        await client.query('BEGIN');

        // 1. Resolve interest IDs from curated list (names or slugs)
        const interestData = await client.query(
            `SELECT interest_id, name FROM interests 
             WHERE (LOWER(name) = ANY(SELECT LOWER(u) FROM UNNEST($1::text[]) u)
             OR slug = ANY($1::text[]))
             AND is_active = TRUE`,
            [interests]
        );

        if (interestData.rowCount < interests.length) {
            await client.query('ROLLBACK');
            return res.status(400).json({ 
                success: false, 
                message: "Some selected interests are invalid or not found in our curated list." 
            });
        }

        const interestIds = interestData.rows.map(r => r.interest_id);

        // 2. Capped Upsert into user_interests (Preserving 'onboarding' as primary source)
        for (const interestId of interestIds) {
            await client.query(
                `INSERT INTO user_interests (user_id, interest_id, source, score)
                 VALUES ($1, $2, 'onboarding', 5.0)
                 ON CONFLICT (user_id, interest_id) 
                 DO UPDATE SET 
                    score = LEAST(user_interests.score + EXCLUDED.score, 100.0),
                    updated_at = NOW()`,
                [userId, interestId]
            );
        }

        // 3. Increment usage count for interests
        await client.query(
            `UPDATE interests 
             SET usage_count = usage_count + 1 
             WHERE interest_id = ANY($1::uuid[])`,
            [interestIds]
        );

        // 4. Update onboarding_step in users table
        await client.query(
            `UPDATE users 
             SET onboarding_step = 'SKILLS', 
                 updated_at = NOW() 
             WHERE user_id = $1`,
            [userId]
        );

        await client.query('COMMIT');

        return res.status(200).json({
            success: true,
            message: "Interests saved successfully",
            data: { 
                selected_count: interestData.rowCount,
                interests: interestData.rows.map(r => r.name)
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

        await client.query("COMMIT");

        res.status(201).json({
            success: true,
            message: "Skills updated successfully",
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

        return res.status(200).json({
            success: true,
            message: "Profile updated successfully",
            data: result.rows[0]
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

        return res.status(200).json({
            success: true,
            message: "Location updated successfully",
            data: result.rows[0]
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
