const pool = require("../db/pool");
const { checkBlockStatus } = require("../utils/blockCheck");

exports.getProfile = async (req, res) => {
  let userId = req.params.id === "me" ? req.user.sub : req.params.id;
  // Check if userId is a valid UUID
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // If not "me" and not valid UUID, return 400 or 404 immediately (since we reverted username support)
  if (userId !== "me" && !uuidRegex.test(userId)) {
    return res.status(400).json({ message: "Invalid user ID" });
  }

  // Block Code Check
  if (req.user && userId !== req.user.sub) {
    const isBlocked = await checkBlockStatus(req.user.sub, userId);
    if (isBlocked) {
      return res.status(404).json({ message: "User not found" });
    }
  }

  try {
    let userResult = await pool.query(
      `
          SELECT u.user_id, u.full_name, u.headline, u.avatar_url, u.cover_image_url, u.location, u.about_text, u.email, u.mobile_number, u.account_name, u.created_at,
                 p.profile_id, p.open_to, p.availability, p.work_preference, p.profile_views_count, p.search_appearances_count
          FROM users u
          LEFT JOIN profiles p ON u.user_id = p.user_id
          WHERE u.user_id = $1
          `,
      [userId]
    );

    if (!userResult.rowCount) {
      return res.status(404).json({ message: "User not found" });
    }

    const u = userResult.rows[0];
    const profileId = u.profile_id;

    // Update userId to the actual UUID found, so subsequent queries work
    userId = u.user_id;


    const experiences = profileId
      ? await pool.query(
        `SELECT * FROM experiences WHERE profile_id = $1 ORDER BY start_date DESC`,
        [profileId]
      )
      : { rows: [] };


    const educations = profileId
      ? await pool.query(
        `SELECT * FROM educations WHERE profile_id = $1 ORDER BY start_date DESC`,
        [profileId]
      )
      : { rows: [] };


    const skills = profileId
      ? await pool.query(
        `
          SELECT s.skill_id, s.name
          FROM user_skills us
          JOIN skills s ON us.skill_id = s.skill_id
          WHERE us.profile_id = $1
          `,
        [profileId]
      )
      : { rows: [] };


    // Updated query to include role details + visibility + priority
    const companyRoles = await pool.query(
      `
      SELECT 
        c.company_id, 
        c.name, 
        c.slug, 
        c.logo_url, 
        cr.name as role,
        cm.is_primary_display,
        cm.is_role_visible,
        cr.priority
      FROM company_members cm
      JOIN companies c ON cm.company_id = c.company_id
      JOIN company_roles cr ON cm.role_id = cr.role_id
      WHERE cm.user_id = $1
      ORDER BY cm.is_primary_display DESC, cr.priority DESC, c.name ASC
      `,
      [userId]
    );


    // Get counts
    const countsResult = await pool.query(
      `
      SELECT 
        (SELECT COUNT(*) FROM followers WHERE following_id = $1) as followers_count,
        (SELECT COUNT(*) FROM followers WHERE follower_id = $1) as following_count,
        (SELECT COUNT(*) FROM connections WHERE user_id = $1) as connections_count
      `,
      [userId]
    );

    const counts = countsResult.rows[0];

    const resumeResult = await pool.query(
      `SELECT file_name, file_url FROM user_resumes WHERE user_id = $1 ORDER BY uploaded_at DESC LIMIT 1`,
      [userId]
    );
    const resume = resumeResult.rows[0] ? {
      originalName: resumeResult.rows[0].file_name,
      url: resumeResult.rows[0].file_url
    } : null;


    const latestEducation = educations.rows[0]
      ? {
        school: educations.rows[0].school_name,
        degree: educations.rows[0].degree,
      }
      : null;


    let isFollowing = false;
    let isFollowedBy = false;
    let connectionRequestStatus = null;
    let connectionRequestId = null;
    let connectionRequestSender = null;

    if (req.user && req.user.sub && req.user.sub !== u.user_id) {
      const viewerId = req.user.sub;
      const targetId = u.user_id;

      // Check Following (Viewer -> Target)
      const followCheck = await pool.query(
        "SELECT 1 FROM followers WHERE follower_id = $1 AND following_id = $2",
        [viewerId, targetId]
      );
      isFollowing = followCheck.rowCount > 0;

      // Check Followed By (Target -> Viewer)
      const followedByCheck = await pool.query(
        "SELECT 1 FROM followers WHERE follower_id = $1 AND following_id = $2",
        [targetId, viewerId]
      );
      isFollowedBy = followedByCheck.rowCount > 0;

      // Check Connection Request
      const requestCheck = await pool.query(
        `SELECT request_id, sender_id, status 
             FROM connection_requests 
             WHERE (sender_id = $1 AND receiver_id = $2) 
                OR (sender_id = $2 AND receiver_id = $1)`,
        [viewerId, targetId]
      );

      if (requestCheck.rowCount > 0) {
        const reqRow = requestCheck.rows[0];
        connectionRequestStatus = reqRow.status;
        connectionRequestId = reqRow.request_id;
        connectionRequestSender = reqRow.sender_id === viewerId ? 'me' : 'them';
      }
    }

    res.json({
      user: {
        id: u.user_id,
        name: u.full_name,
        headline: u.headline,
        avatar: u.avatar_url,
        cover_image: u.cover_image_url,
        location: u.location,
        about: u.about_text,
        email: u.email,
        mobile_number: u.mobile_number,
        followers_count: parseInt(counts.followers_count),
        following_count: parseInt(counts.following_count),
        connections_count: parseInt(counts.connections_count),
        open_to: u.open_to,
        availability: u.availability,
        work_preference: u.work_preference,
        latest_education: latestEducation,
        is_following: isFollowing,
        is_followed_by: isFollowedBy,
        connection_request_status: connectionRequestStatus,
        connection_request_id: connectionRequestId,
        connection_request_sender: connectionRequestSender,
        created_at: u.created_at,
      },
      experiences: experiences.rows,
      educations: educations.rows,
      skills: skills.rows,
      company_roles: companyRoles.rows,
      resume: resume
    });
  } catch (err) {
    console.error("Get profile error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

exports.updateProfile = async (req, res) => {
  const userId = req.user.sub;

  const {
    full_name,
    headline,
    job_title,
    company_name,
    school,
    degree,
    location,
    about_text,
    mobile_number
  } = req.body;


  if (full_name && full_name.trim().length < 3) {
    return res.status(400).json({ message: "Full name must be at least 3 characters" });
  }

  if (headline && headline.length > 120) {
    return res.status(400).json({ message: "Headline cannot exceed 120 characters" });
  }

  if (job_title && job_title.length > 80) {
    return res.status(400).json({ message: "Job title cannot exceed 80 characters" });
  }

  if (company_name && company_name.length > 80) {
    return res.status(400).json({ message: "Company name cannot exceed 80 characters" });
  }

  if (school && school.length > 100) {
    return res.status(400).json({ message: "School cannot exceed 100 characters" });
  }

  if (degree && degree.length > 100) {
    return res.status(400).json({ message: "Degree cannot exceed 100 characters" });
  }

  if (location && location.length > 150) {
    return res.status(400).json({ message: "Location cannot exceed 150 characters" });
  }

  if (about_text && about_text.length > 500) {
    return res.status(400).json({ message: "About section cannot exceed 500 characters" });
  }




  try {
    await pool.query("BEGIN");

    await pool.query(
      `
      UPDATE users
      SET 
        full_name    = COALESCE($1, full_name),
        headline     = COALESCE($2, headline),
        job_title    = COALESCE($3, job_title),
        company_name = COALESCE($4, company_name),
        school       = COALESCE($5, school),
        degree       = COALESCE($6, degree),
        location     = COALESCE($7, location),
        about_text   = COALESCE($8, about_text),

        mobile_number = COALESCE($9, mobile_number),
        updated_at   = now()
      WHERE user_id = $10
      `,
      [
        full_name,
        headline,
        job_title,
        company_name,
        school,
        degree,
        location,
        about_text,
        mobile_number,
        userId
      ]
    );

    await pool.query("COMMIT");

    res.json({ message: "Profile updated successfully" });

  } catch (err) {
    await pool.query("ROLLBACK");
    console.error("Update profile error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

exports.getMyProfile = async (req, res) => {
  req.params.id = 'me';
  return exports.getProfile(req, res);
}

exports.uploadOrReplaceAvatar = async (req, res) => {
  try {
    const userId = req.user.sub;

    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded" });
    }

    // Use Cloudinary URL
    const avatarUrl = req.file.path || req.file.secure_url;

    await pool.query(
      "UPDATE users SET avatar_url = $1 WHERE user_id = $2",
      [avatarUrl, userId]
    );


    res.json({ message: "Profile picture updated successfully", avatarUrl });
  } catch (err) {
    console.error("Avatar upload error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

exports.getAvatar = async (req, res) => {
  try {
    const userId = req.user.sub;

    const result = await pool.query(
      "SELECT avatar_url FROM users WHERE user_id = $1",
      [userId]
    );

    if (!result.rows[0] || !result.rows[0].avatar_url) {
      return res.status(404).json({ message: "No profile picture found" });
    }


    res.json({ avatarUrl: result.rows[0].avatar_url });
  } catch (err) {
    console.error("Get avatar error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

exports.deleteAvatar = async (req, res) => {
  try {
    const userId = req.user.sub;

    await pool.query(
      "UPDATE users SET avatar_url = NULL WHERE user_id = $1",
      [userId]
    );

    res.json({ message: "Profile picture deleted successfully" });
  } catch (err) {
    console.error("Delete avatar error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

exports.uploadOrReplaceCoverPhoto = async (req, res) => {
  try {
    const userId = req.user.sub;

    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded" });
    }

    const coverUrl = req.file.path || req.file.secure_url;

    await pool.query(
      "UPDATE users SET cover_image_url = $1 WHERE user_id = $2",
      [coverUrl, userId]
    );


    res.json({ message: "Cover photo updated successfully", coverUrl });
  } catch (err) {
    console.error("Cover upload error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

exports.deleteCoverPhoto = async (req, res) => {
  try {
    const userId = req.user.sub;

    await pool.query(
      "UPDATE users SET cover_image_url = NULL WHERE user_id = $1",
      [userId]
    );

    res.json({ message: "Cover photo deleted successfully" });
  } catch (err) {
    console.error("Delete cover error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

// GET /profile/identity
exports.getIdentity = async (req, res) => {
  const userId = req.user.sub;
  try {
    const result = await pool.query(
      `SELECT open_to, availability, work_preference 
       FROM profiles 
       WHERE user_id = $1`,
      [userId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Profile not found" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Get identity error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

// PUT /profile/identity
exports.updateIdentity = async (req, res) => {
  const userId = req.user.sub;
  const { open_to, availability, work_preference } = req.body;

  const allowedOpenTo = ["Full-time", "Freelance", "Mentorship", "Consulting"];
  const allowedAvailability = ["Immediate", "30 Days", "Casual Networking"];
  const allowedWorkPreference = ["Remote", "Hybrid", "Onsite"];

  if (!allowedOpenTo.includes(open_to) ||
    !allowedAvailability.includes(availability) ||
    !allowedWorkPreference.includes(work_preference)) {
    return res.status(400).json({ message: "Invalid identity values" });
  }

  try {
    const result = await pool.query(
      `UPDATE profiles
       SET open_to = $1, availability = $2, work_preference = $3, updated_at = now()
       WHERE user_id = $4
       RETURNING *`,
      [open_to, availability, work_preference, userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Profile not found" });
    }

    res.json({ message: "Professional identity updated successfully", identity: result.rows[0] });
  } catch (err) {
    console.error("Update identity error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};
// --- Upload or Replace Resume ---
exports.uploadOrReplaceResume = async (req, res) => {
  const userId = req.user.sub;
  const file = req.file;

  if (!file) {
    return res.status(400).json({ message: "Resume file is required" });
  }

  try {
    await pool.query(
      `DELETE FROM user_resumes WHERE user_id = $1`,
      [userId]
    );
    const result = await pool.query(
      `
      INSERT INTO user_resumes
        (user_id, file_name, file_url, file_type, file_size)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
      `,
      [
        userId,
        file.originalname,
        file.path,
        file.mimetype,
        file.size
      ]
    );

    res.status(201).json({
      message: "Resume uploaded successfully",
      resume: result.rows[0]
    });

  } catch (err) {
    console.error("Upload/Replace resume error:", err);
    res.status(500).json({ message: "Failed to upload resume" });
  }
};

// --- Get Resume ---
exports.getResume = async (req, res) => {
  const userId = req.user.sub;

  try {
    const result = await pool.query(
      `SELECT * FROM user_resumes WHERE user_id = $1`,
      [userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "No resume found" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("Get resume error:", err);
    res.status(500).json({ message: "Failed to fetch resume" });
  }
};

// --- Delete Resume ---
exports.deleteResume = async (req, res) => {
  const userId = req.user.sub;

  try {
    const result = await pool.query(
      `DELETE FROM user_resumes WHERE user_id = $1 RETURNING *`,
      [userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "No resume found to delete" });
    }

    res.json({ message: "Resume deleted successfully", resume: result.rows[0] });
  } catch (err) {
    console.error("Delete resume error:", err);
    res.status(500).json({ message: "Failed to delete resume" });
  }
};



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

    const profile = await pool.query(
      `SELECT * FROM users WHERE user_id = $1`,
      [profileId]
    );




    res.status(201).json({
      message: "Education added successfully",
      education: result.rows[0],
      profile: profile.rows[0],
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
exports.addSkills = async (req, res) => {
  const userId = req.user.sub;
  const { name } = req.body;

  // 1. Validation
  if (!Array.isArray(name) || name.length === 0) {
    return res.status(400).json({
      message: "Name must be a non-empty array",
    });
  }

  // 2. Normalize & clean skills
  const skillList = [...new Set(
    name
      .filter(s => typeof s === "string")
      .map(s =>
        s
          .trim()
          .toLowerCase()
          .replace(/\s+/g, " ")
          .split(" ")
          .map(w => w.charAt(0).toUpperCase() + w.slice(1))
          .join(" ")
      )
      .filter(Boolean)
  )];

  if (!skillList.length) {
    return res.status(400).json({
      message: "No valid skills provided",
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // 3. Get profile
    const { rows } = await client.query(
      `SELECT profile_id FROM profiles WHERE user_id = $1`,
      [userId]
    );

    if (!rows.length) {
      throw new Error("PROFILE_NOT_FOUND");
    }

    const profileId = rows[0].profile_id;

    // 4. Insert skills in batch
    const insertSkillsQuery = `
      INSERT INTO skills (name)
      SELECT UNNEST($1::text[])
      ON CONFLICT (lower(name)) DO NOTHING
      RETURNING skill_id, name
    `;

    await client.query(insertSkillsQuery, [skillList]);

    // 5. Fetch all skills (new + existing)
    // Use case-insensitive matching to find existing skills that might differ in case
    const { rows: skills } = await client.query(
      `SELECT skill_id, name 
       FROM skills 
       WHERE lower(name) IN (SELECT lower(unnest($1::text[])))`,
      [skillList]
    );

    // 6. Map user_skills
    const values = skills
      .map(
        (s, i) =>
          `($1, $${i + 2})`
      )
      .join(",");

    await client.query(
      `
      INSERT INTO user_skills (profile_id, skill_id)
      VALUES ${values}
      ON CONFLICT DO NOTHING
      `,
      [profileId, ...skills.map(s => s.skill_id)]
    );

    await client.query("COMMIT");


    res.status(201).json({
      message: "Skills added successfully",
      skills,
    });

  } catch (err) {
    await client.query("ROLLBACK");

    if (err.message === "PROFILE_NOT_FOUND") {
      return res.status(404).json({
        message: "Profile not found",
      });
    }

    console.error("Add skills error:", err);
    res.status(500).json({
      message: "Internal server error",
    });

  } finally {
    client.release();
  }
};

// Update skill
exports.updateSkill = async (req, res) => {
  const userId = req.user.sub; // Logged-in user
  const skillId = req.params.id; // Skill ID from URL
  const { name } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ message: "Skill name is required" });
  }

  const newSkillName = name.trim();

  const client = await pool.connect(); // Use a client for transaction
  try {
    await client.query('BEGIN');

    // 1️⃣ Get profile_id of logged-in user
    const profileResult = await client.query(
      `SELECT profile_id FROM profiles WHERE user_id = $1`,
      [userId]
    );

    if (profileResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: "Profile not found" });
    }

    const profileId = profileResult.rows[0].profile_id;

    // 2️⃣ Ensure the skill exists and is linked to this profile
    const userSkillCheck = await client.query(
      `SELECT * FROM user_skills WHERE profile_id = $1 AND skill_id = $2`,
      [profileId, skillId]
    );

    if (userSkillCheck.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        message: "Skill not found or not authorized to update",
      });
    }

    // 3️⃣ Check if the new skill name already exists (case-insensitive)
    const skillExists = await client.query(
      `SELECT skill_id, name FROM skills WHERE LOWER(name) = LOWER($1)`,
      [newSkillName]
    );

    let finalSkillId;
    let finalSkillName;

    if (skillExists.rowCount > 0) {
      // Skill already exists → link to this skill
      finalSkillId = skillExists.rows[0].skill_id;
      finalSkillName = skillExists.rows[0].name;

      // Update user mapping
      await client.query(
        `UPDATE user_skills SET skill_id = $1 WHERE profile_id = $2 AND skill_id = $3`,
        [finalSkillId, profileId, skillId]
      );
    } else {
      // Skill doesn't exist → create a new skill
      const newSkill = await client.query(
        `INSERT INTO skills (name) VALUES ($1) RETURNING skill_id, name`,
        [newSkillName]
      );

      finalSkillId = newSkill.rows[0].skill_id;
      finalSkillName = newSkill.rows[0].name;

      // Update user mapping to point to new skill
      await client.query(
        `UPDATE user_skills SET skill_id = $1 WHERE profile_id = $2 AND skill_id = $3`,
        [finalSkillId, profileId, skillId]
      );
    }

    await client.query('COMMIT');

    res.json({
      message: "Skill updated successfully",
      skill: { skill_id: finalSkillId, name: finalSkillName },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error("Update skill error:", err);
    res.status(500).json({ message: "Internal server error" });
  } finally {
    client.release();
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