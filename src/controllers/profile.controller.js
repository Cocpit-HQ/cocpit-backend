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
exports.getMyProfile = async (req, res) => {
  req.params.id = 'me';
  return exports.getProfile(req, res);
}

// --- Experiences ---

exports.addExperience = async (req, res) => {
  const userId = req.user.sub;
  const {
    title,
    company_name,
    location,
    start_date,
    end_date,
    is_current,
    description,
  } = req.body;

  try {
    // 1. Get user's profile_id
    const profileResult = await pool.query(
      `SELECT profile_id FROM profiles WHERE user_id = $1`,
      [userId]
    );

    // ✅ SAFETY CHECK (important)
    if (profileResult.rowCount === 0) {
      return res.status(404).json({ message: "Profile not found" });
    }

    const profileId = profileResult.rows[0].profile_id;

    // 2. Insert experience
    const result = await pool.query(
      `
      INSERT INTO experiences 
        (profile_id, title, company_name, location, start_date, end_date, is_current, description)
      VALUES 
        ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
      `,
      [
        profileId,
        title,
        company_name,
        location,
        start_date,
        end_date,
        is_current ?? false,
        description,
      ]
    );

    res.status(201).json({
      message: "Experience added successfully",
      experience: result.rows[0],
    });
  } catch (err) {
    console.error("Add experience error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

exports.updateExperience = async (req, res) => {
  const userId = req.user.sub;        // Logged-in user
  const experienceId = req.params.id; // Experience ID to update
  const {
    title,
    company_name,
    location,
    start_date,
    end_date,
    is_current,
    description
  } = req.body;

  try {
    // 1️⃣ Get the profile_id for the logged-in user
    const profileResult = await pool.query(
      `SELECT profile_id FROM profiles WHERE user_id = $1`,
      [userId]
    );

    if (profileResult.rowCount === 0) {
      return res.status(404).json({ message: "Profile not found" });
    }

    const profileId = profileResult.rows[0].profile_id;

    // 2️⃣ Ensure the experience belongs to this profile
    const experienceResult = await pool.query(
      `SELECT * FROM experiences WHERE experience_id = $1 AND profile_id = $2`,
      [experienceId, profileId]
    );

    if (experienceResult.rowCount === 0) {
      return res.status(404).json({ message: "Experience not found or not authorized" });
    }

    // 3️⃣ Build dynamic SET clause for partial updates
    const fields = [];
    const values = [];
    let idx = 1;

    if (title !== undefined) fields.push(`title = $${idx++}`), values.push(title);
    if (company_name !== undefined) fields.push(`company_name = $${idx++}`), values.push(company_name);
    if (location !== undefined) fields.push(`location = $${idx++}`), values.push(location);
    if (start_date !== undefined) fields.push(`start_date = $${idx++}`), values.push(start_date);
    if (end_date !== undefined) fields.push(`end_date = $${idx++}`), values.push(end_date);
    if (is_current !== undefined) fields.push(`is_current = $${idx++}`), values.push(is_current);
    if (description !== undefined) fields.push(`description = $${idx++}`), values.push(description);

    if (fields.length === 0) {
      return res.status(400).json({ message: "No fields provided to update" });
    }

    // 4️⃣ Add WHERE clause values
    values.push(experienceId); // $n
    values.push(profileId);    // $n+1

    // 5️⃣ Execute the update
    const updateQuery = `
      UPDATE experiences
      SET ${fields.join(", ")}
      WHERE experience_id = $${idx++} AND profile_id = $${idx}
      RETURNING *
    `;

    const updatedResult = await pool.query(updateQuery, values);

    res.json({
      message: "Experience updated successfully",
      experience: updatedResult.rows[0],
    });

  } catch (err) {
    console.error("Update experience error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

exports.deleteExperience = async (req, res) => {
  const userId = req.user.sub;
  const experienceId = req.params.id;

  try {
    // 1. Get profile_id of current user
    const profileResult = await pool.query(
      `SELECT profile_id FROM profiles WHERE user_id = $1`,
      [userId]
    );

    if (profileResult.rowCount === 0) {
      return res.status(404).json({ message: "Profile not found" });
    }

    const profileId = profileResult.rows[0].profile_id;

    // 2. Delete experience if it belongs to user's profile
    const result = await pool.query(
      `DELETE FROM experiences WHERE experience_id = $1 AND profile_id = $2 RETURNING *`,
      [experienceId, profileId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Experience not found" });
    }

    res.json({ message: "Experience deleted successfully" });
  } catch (err) {
    console.error("Delete experience error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

// --- Educations ---

exports.addEducation = async (req, res) => {
  const userId = req.user.sub;
  const {
    school_name,
    degree,
    field_of_study,
    start_date,
    end_date,
    description,
  } = req.body;

  try {
    // 1. Get user's profile_id
    const profileResult = await pool.query(
      `SELECT profile_id FROM profiles WHERE user_id = $1`,
      [userId]
    );

    // ✅ SAFETY CHECK
    if (profileResult.rowCount === 0) {
      return res.status(404).json({ message: "Profile not found" });
    }

    const profileId = profileResult.rows[0].profile_id;

    // 2. Insert education
    const result = await pool.query(
      `
      INSERT INTO educations 
        (profile_id, school_name, degree, field_of_study, start_date, end_date, description)
      VALUES 
        ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
      `,
      [
        profileId,
        school_name,
        degree,
        field_of_study,
        start_date,
        end_date,
        description,
      ]
    );

    res.status(201).json({
      message: "Education added successfully",
      education: result.rows[0],
    });
  } catch (err) {
    console.error("Add education error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};
// Update education by education_id (only own profile)
exports.updateEducation = async (req, res) => {
  const userId = req.user.sub;
  const educationId = req.params.id;
  const {
    school_name,
    degree,
    field_of_study,
    start_date,
    end_date,
    description,
  } = req.body;

  try {
    // 1️⃣ Get profile_id
    const profileResult = await pool.query(
      `SELECT profile_id FROM profiles WHERE user_id = $1`,
      [userId]
    );

    if (profileResult.rowCount === 0) {
      return res.status(404).json({ message: "Profile not found" });
    }

    const profileId = profileResult.rows[0].profile_id;

    // 2️⃣ Update only fields provided
    const fields = [];
    const values = [];
    let idx = 1;

    if (school_name !== undefined) fields.push(`school_name = $${idx++}`), values.push(school_name);
    if (degree !== undefined) fields.push(`degree = $${idx++}`), values.push(degree);
    if (field_of_study !== undefined) fields.push(`field_of_study = $${idx++}`), values.push(field_of_study);
    if (start_date !== undefined) fields.push(`start_date = $${idx++}`), values.push(start_date);
    if (end_date !== undefined) fields.push(`end_date = $${idx++}`), values.push(end_date);
    if (description !== undefined) fields.push(`description = $${idx++}`), values.push(description);

    if (fields.length === 0) {
      return res.status(400).json({ message: "No fields provided to update" });
    }

    values.push(educationId);
    values.push(profileId);

    const updateQuery = `
      UPDATE educations
      SET ${fields.join(", ")}
      WHERE education_id = $${idx++} AND profile_id = $${idx}
      RETURNING *
    `;

    const updatedResult = await pool.query(updateQuery, values);

    if (updatedResult.rowCount === 0) {
      return res.status(404).json({
        message: "Education not found or not authorized to update",
      });
    }

    res.json({
      message: "Education updated successfully",
      education: updatedResult.rows[0],
    });

  } catch (err) {
    console.error("Update education error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};


exports.deleteEducation = async (req, res) => {
  const userId = req.user.sub;           // logged-in user
  const educationId = req.params.id;     // education_id from URL

  try {
    // 1. Get user's profile_id (to ensure ownership)
    const profileResult = await pool.query(
      `SELECT profile_id FROM profiles WHERE user_id = $1`,
      [userId]
    );

    if (profileResult.rowCount === 0) {
      return res.status(404).json({ message: "Profile not found" });
    }

    const profileId = profileResult.rows[0].profile_id;

    // 2. Delete education only if it belongs to this user's profile
    const deleteResult = await pool.query(
      `
      DELETE FROM educations
      WHERE education_id = $1 AND profile_id = $2
      RETURNING *
      `,
      [educationId, profileId]
    );

    if (deleteResult.rowCount === 0) {
      return res.status(404).json({
        message: "Education not found or not authorized to delete",
      });
    }

    res.json({
      message: "Education deleted successfully",
      education: deleteResult.rows[0],
    });
  } catch (err) {
    console.error("Delete education error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};
// --- Skills ---
exports.addSkill = async (req, res) => {
  const userId = req.user.sub;
  const { name } = req.body; // skill name

  if (!name) {
    return res.status(400).json({ message: "Skill name is required" });
  }

  try {
    // 1. Get profile_id
    const profileResult = await pool.query(
      `SELECT profile_id FROM profiles WHERE user_id = $1`,
      [userId]
    );

    if (profileResult.rowCount === 0) {
      return res.status(404).json({ message: "Profile not found" });
    }

    const profileId = profileResult.rows[0].profile_id;

    // 2. Get or create skill
    let skillId;
    const skillCheck = await pool.query(
      `SELECT skill_id FROM skills WHERE name = $1`,
      [name.trim()]
    );

    if (skillCheck.rowCount > 0) {
      skillId = skillCheck.rows[0].skill_id;
    } else {
      const newSkill = await pool.query(
        `INSERT INTO skills (name) VALUES ($1) RETURNING skill_id`,
        [name.trim()]
      );
      skillId = newSkill.rows[0].skill_id;
    }

    // 3. Link skill to profile (avoid duplicates)
    const linkResult = await pool.query(
      `
      INSERT INTO user_skills (profile_id, skill_id)
      VALUES ($1, $2)
      ON CONFLICT DO NOTHING
      RETURNING *
      `,
      [profileId, skillId]
    );

    if (linkResult.rowCount === 0) {
      return res.status(409).json({ message: "Skill already added" });
    }

    res.status(201).json({
      message: "Skill added successfully",
      skill: {
        skill_id: skillId,
        name: name.trim(),
      },
    });
  } catch (err) {
    console.error("Add skill error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};
// Update skill
exports.updateSkill = async (req, res) => {
  const userId = req.user.sub;    // Logged-in user
  const skillId = req.params.id;  // Skill ID from URL
  const { name } = req.body;      // New skill name

  if (!name) {
    return res.status(400).json({ message: "Skill name is required" });
  }

  try {
    // 1️⃣ Get profile_id of logged-in user
    const profileResult = await pool.query(
      `SELECT profile_id FROM profiles WHERE user_id = $1`,
      [userId]
    );

    if (profileResult.rowCount === 0) {
      return res.status(404).json({ message: "Profile not found" });
    }

    const profileId = profileResult.rows[0].profile_id;

    // 2️⃣ Ensure the skill exists and is linked to this profile
    const userSkillCheck = await pool.query(
      `SELECT * FROM user_skills WHERE profile_id = $1 AND skill_id = $2`,
      [profileId, skillId]
    );

    if (userSkillCheck.rowCount === 0) {
      return res.status(404).json({
        message: "Skill not found or not authorized to update",
      });
    }

    // 3️⃣ Check if the new skill name already exists in skills table
    const skillExists = await pool.query(
      `SELECT skill_id FROM skills WHERE name = $1`,
      [name.trim()]
    );

    let finalSkillId;
    if (skillExists.rowCount > 0) {
      // Skill with new name exists, just link to profile
      finalSkillId = skillExists.rows[0].skill_id;

      // Update mapping to new skill_id
      await pool.query(
        `UPDATE user_skills SET skill_id = $1 WHERE profile_id = $2 AND skill_id = $3`,
        [finalSkillId, profileId, skillId]
      );
    } else {
      // Skill name doesn't exist → update the name in skills table
      const updatedSkill = await pool.query(
        `UPDATE skills SET name = $1 WHERE skill_id = $2 RETURNING *`,
        [name.trim(), skillId]
      );
      finalSkillId = updatedSkill.rows[0].skill_id;
    }

    res.json({
      message: "Skill updated successfully",
      skill: { skill_id: finalSkillId, name: name.trim() },
    });

  } catch (err) {
    console.error("Update skill error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};


exports.deleteSkill = async (req, res) => {
  const userId = req.user.sub;        // logged-in user
  const skillId = req.params.id;      // skill_id from URL

  try {
    // 1. Get user's profile_id
    const profileResult = await pool.query(
      `SELECT profile_id FROM profiles WHERE user_id = $1`,
      [userId]
    );

    if (profileResult.rowCount === 0) {
      return res.status(404).json({ message: "Profile not found" });
    }

    const profileId = profileResult.rows[0].profile_id;

    // 2. Remove skill mapping from user_skills table
    const deleteResult = await pool.query(
      `
      DELETE FROM user_skills
      WHERE profile_id = $1 AND skill_id = $2
      RETURNING *
      `,
      [profileId, skillId]
    );

    if (deleteResult.rowCount === 0) {
      return res.status(404).json({
        message: "Skill not found or not authorized to delete",
      });
    }

    res.json({
      message: "Skill removed successfully",
      skillId,
    });
  } catch (err) {
    console.error("Delete skill error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

