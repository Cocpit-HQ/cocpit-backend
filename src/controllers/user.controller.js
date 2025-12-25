const pool = require("../db/pool");

exports.getProfile = async (req, res) => {
  const userId = req.params.id === 'me' ? req.user.sub : req.params.id;

  try {
    // 1. Get User & Profile Data
    const userResult = await pool.query(
      `
      SELECT u.user_id, u.full_name, u.headline, u.avatar_url, u.location, u.about_text, u.email,
             p.profile_id, p.open_to, p.availability, p.work_preference, p.profile_views_count, p.search_appearances_count
      FROM users u
      LEFT JOIN profiles p ON u.user_id = p.user_id
      WHERE u.user_id = $1
      `,
      [userId]
    );

    if (userResult.rowCount === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const user = userResult.rows[0];
    const profileId = user.profile_id;

    if (!profileId) {
        // Should not happen if registered correctly, but handle it
        return res.status(200).json({ user, experiences: [], educations: [], skills: [] });
    }

    // 2. Get Experiences
    const experiencesResult = await pool.query(
      `SELECT * FROM experiences WHERE profile_id = $1 ORDER BY start_date DESC`,
      [profileId]
    );

    // 3. Get Educations
    const educationsResult = await pool.query(
      `SELECT * FROM educations WHERE profile_id = $1 ORDER BY start_date DESC`,
      [profileId]
    );

    // 4. Get Skills
    const skillsResult = await pool.query(
      `
      SELECT s.skill_id, s.name
      FROM user_skills us
      JOIN skills s ON us.skill_id = s.skill_id
      WHERE us.profile_id = $1
      `,
      [profileId]
    );

    res.json({
      user,
      experiences: experiencesResult.rows,
      educations: educationsResult.rows,
      skills: skillsResult.rows,
    });
  } catch (err) {
    console.error("Get profile error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

exports.updateProfile = async (req, res) => {
  const userId = req.user.sub;
  const {
    full_name, headline, location, about_text, // User table
    open_to, availability, work_preference // Profile table
  } = req.body;

  try {
    // Start transaction
    await pool.query('BEGIN');

    // Update User
    if (full_name || headline || location || about_text) {
        await pool.query(
            `
            UPDATE users
            SET full_name = COALESCE($1, full_name),
                headline = COALESCE($2, headline),
                location = COALESCE($3, location),
                about_text = COALESCE($4, about_text),
                updated_at = now()
            WHERE user_id = $5
            `,
            [full_name, headline, location, about_text, userId]
        );
    }

    // Update Profile
    if (open_to || availability || work_preference) {
        await pool.query(
            `
            UPDATE profiles
            SET open_to = COALESCE($1, open_to),
                availability = COALESCE($2, availability),
                work_preference = COALESCE($3, work_preference),
                updated_at = now()
            WHERE user_id = $4
            `,
            [open_to, availability, work_preference, userId]
        );
    }

    await pool.query('COMMIT');
    res.json({ message: "Profile updated successfully" });
  } catch (err) {
    await pool.query('ROLLBACK');
    console.error("Update profile error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

// --- Experiences ---

exports.addExperience = async (req, res) => {
  const userId = req.user.sub;
  const { title, company_name, location, start_date, end_date, is_current, description } = req.body;

  try {
    const profileResult = await pool.query(`SELECT profile_id FROM profiles WHERE user_id = $1`, [userId]);
    const profileId = profileResult.rows[0].profile_id;

    const result = await pool.query(
      `
      INSERT INTO experiences (profile_id, title, company_name, location, start_date, end_date, is_current, description)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
      `,
      [profileId, title, company_name, location, start_date, end_date, is_current, description]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("Add experience error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

// --- Educations ---

exports.addEducation = async (req, res) => {
  const userId = req.user.sub;
  const { school_name, degree, field_of_study, start_date, end_date, description } = req.body;

  try {
    const profileResult = await pool.query(`SELECT profile_id FROM profiles WHERE user_id = $1`, [userId]);
    const profileId = profileResult.rows[0].profile_id;

    const result = await pool.query(
      `
      INSERT INTO educations (profile_id, school_name, degree, field_of_study, start_date, end_date, description)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
      `,
      [profileId, school_name, degree, field_of_study, start_date, end_date, description]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("Add education error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

// --- Skills ---

exports.addSkill = async (req, res) => {
    const userId = req.user.sub;
    const { name } = req.body; // Skill name

    try {
        const profileResult = await pool.query(`SELECT profile_id FROM profiles WHERE user_id = $1`, [userId]);
        const profileId = profileResult.rows[0].profile_id;

        // Check if skill exists globally, if not create it
        // This is a "get or create" logic
        let skillId;
        const skillCheck = await pool.query(`SELECT skill_id FROM skills WHERE name = $1`, [name]);

        if (skillCheck.rowCount > 0) {
            skillId = skillCheck.rows[0].skill_id;
        } else {
            const newSkill = await pool.query(`INSERT INTO skills (name) VALUES ($1) RETURNING skill_id`, [name]);
            skillId = newSkill.rows[0].skill_id;
        }

        // Link to profile
        await pool.query(
            `INSERT INTO user_skills (profile_id, skill_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [profileId, skillId]
        );

        res.status(201).json({ message: "Skill added", skillId, name });
    } catch (err) {
        console.error("Add skill error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};
