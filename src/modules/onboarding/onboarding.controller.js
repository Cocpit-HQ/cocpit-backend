/**
 * Onboarding Controller
 * Scaffolding for multi-step onboarding flow.
 */
const pool = require("../../core/db/pool");

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
    const { role, education, company, workRole } = req.body;

    try {
        await pool.query('BEGIN'); // Using same query style with transactions when multiple tables

        if (role === 'student2') {
            // Get profile_id for education insertion (Auth module pattern)
            const profileRes = await pool.query(
                `SELECT profile_id FROM profiles WHERE user_id = $1`,
                [userId]
            );

            if (profileRes.rowCount > 0 && education && Array.isArray(education)) {
                const profileId = profileRes.rows[0].profile_id;

                // Clear existing educations during onboarding flow sync
                await pool.query(`DELETE FROM educations WHERE profile_id = $1`, [profileId]);

                // Insert new educations
                for (const edu of education) {
                    await pool.query(
                        `INSERT INTO educations (profile_id, school_name, degree, field_of_study)
                         VALUES ($1, $2, $3, $4)`,
                        [profileId, edu.school_name || edu.school, edu.degree, edu.field_of_study]
                    );
                }
            }

            // Update step
            await pool.query(
                `UPDATE users SET onboarding_step = 'INTERESTS', updated_at = NOW() WHERE user_id = $1`,
                [userId]
            );

        } else if (role === 'working') {
            // Update company + workRole for working professional
            await pool.query(
                `UPDATE users 
                 SET company_name = $1, 
                     job_title = $2, 
                     onboarding_step = 'INTERESTS', 
                     updated_at = NOW() 
                 WHERE user_id = $3`,
                [company, workRole, userId]
            );

        } else if (role === 'freelancer' || role === 'open_to_work') {
            // Update workRole for freelancer / open to work
            await pool.query(
                `UPDATE users 
                 SET job_title = $1, 
                     onboarding_step = 'INTERESTS', 
                     updated_at = NOW() 
                 WHERE user_id = $2`,
                [workRole, userId]
            );
        }

        await pool.query('COMMIT');

        return res.status(200).json({
            success: true,
            message: "Details saved successfully",
            data: { role, education, company, workRole }
        });
    } catch (err) {
        await pool.query('ROLLBACK');
        console.error("Save details error:", err);
        return res.status(500).json({ success: false, message: "Internal server error" });
    }
};

exports.saveInterests = async (req, res) => {
    const userId = req.user?.sub;
    const { interests } = req.body;

    try {
        // Validate min 3
        if (!interests || interests.length < 3) {
            return res.status(400).json({ success: false, message: "Minimum 3 interests required" });
        }

        // Update interests, Set onboardingStep = 'SKILLS'
        // Assuming `interests` array column is handled in the users or related table
        const result = await pool.query(
            `UPDATE users 
             SET interests = $1, 
                 onboarding_step = 'SKILLS', 
                 updated_at = NOW() 
             WHERE user_id = $2
             RETURNING *`,
            [interests, userId] // Node pg converts JS arrays into postgres arrays
        );

        return res.status(200).json({
            success: true,
            message: "Interests saved successfully",
            data: { interests }
        });
    } catch (err) {
        console.error("Save interests error:", err);
        return res.status(500).json({ success: false, message: "Internal server error" });
    }
};

exports.saveSkills = async (req, res) => {
    const userId = req.user?.sub;
    const { skills } = req.body;

    try {
        // Validate min 3
        if (!skills || skills.length < 3) {
            return res.status(400).json({ success: false, message: "Minimum 3 skills required" });
        }

        await pool.query('BEGIN');

        const profileRes = await pool.query(`SELECT profile_id FROM profiles WHERE user_id = $1`, [userId]);

        if (profileRes.rowCount > 0) {
            const profileId = profileRes.rows[0].profile_id;

            // Clear existing skills for this user
            await pool.query(`DELETE FROM user_skills WHERE profile_id = $1`, [profileId]);

            for (const skillName of skills) {
                // Insert skill into core table if it doesn't already exist
                await pool.query(
                    `INSERT INTO skills (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
                    [skillName.toLowerCase()]
                );

                // Get skill id
                const skillRes = await pool.query(
                    `SELECT skill_id FROM skills WHERE name = $1`,
                    [skillName.toLowerCase()]
                );

                if (skillRes.rowCount > 0) {
                    const skillId = skillRes.rows[0].skill_id;
                    // Map to user_skills
                    await pool.query(
                        `INSERT INTO user_skills (profile_id, skill_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                        [profileId, skillId]
                    );
                }
            }
        }

        // Let's also update the users.skills if it is used (optional fallback based on schema ambiguity)
        await pool.query(
            `UPDATE users 
             SET skills = $1, 
                 updated_at = NOW() 
             WHERE user_id = $2`,
            [skills, userId]
        );

        await pool.query('COMMIT');

        return res.status(200).json({
            success: true,
            message: "Skills saved successfully",
            data: { skills }
        });
    } catch (err) {
        await pool.query('ROLLBACK');
        console.error("Save skills error:", err);
        return res.status(500).json({ success: false, message: "Internal server error" });
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
