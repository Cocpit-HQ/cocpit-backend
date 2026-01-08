const pool = require("../db/pool");

/**
 * GET /api/users/search
 * Purpose: Real-time user discovery
 */
exports.searchUsers = async (req, res) => {
  const { q, accountType } = req.query;
  const currentUserId = req.user.sub;

  if (!q || typeof q !== "string" || q.trim().length === 0) {
    return res.status(400).json({ message: "Search query 'q' is required" });
  }

  const searchTerm = q.trim().replace(/^['"]|['"]$/g, '');

  try {
    // Construct the query dynamically based on optional filters
    let queryText = `
      SELECT
        u.user_id AS id,
        u.full_name,
        u.headline,
        u.avatar_url,
        p.account_type
      FROM users u
      LEFT JOIN profiles p ON u.user_id = p.user_id
      WHERE u.user_id != $1
    `;

    const queryParams = [currentUserId];
    let paramIndex = 2;

    // Add search condition (ILIKE for partial match, or trigram similarity)
    // Using ILIKE with wildcards for simple "contains" logic which benefits from GIN trgm index
    // OR we can use similarity(u.full_name, $2) > 0.3 for fuzzy matching.
    // The prompt requested "ILIKE + trigram similarity".
    // We'll use ILIKE for the filter and strict matching, ordered by similarity.
    queryText += ` AND (u.full_name ILIKE $${paramIndex})`;
    queryParams.push(`%${searchTerm}%`);
    paramIndex++;

    // Optional accountType filter
    if (accountType) {
      queryText += ` AND p.account_type = $${paramIndex}`;
      queryParams.push(accountType);
      paramIndex++;
    }

    // Order by similarity (closest match first)
    // We calculate similarity on the fly for ordering.
    // Note: To use SIMILARITY() in ORDER BY, pg_trgm must be enabled.
    queryText += `
      ORDER BY SIMILARITY(u.full_name, $${paramIndex}) DESC
      LIMIT 15
    `;
    // Pass the raw search term again for the similarity function
    queryParams.push(searchTerm);

    const result = await pool.query(queryText, queryParams);

    return res.status(200).json(result.rows);
  } catch (err) {
    console.error("Search users error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/**
 * GET /api/users/:id
 * Purpose: Public profile viewing
 */
exports.getUserProfile = async (req, res) => {
  const { id } = req.params;

  // Basic validation for UUID
  const uuidRegex =
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  if (!uuidRegex.test(id)) {
    return res.status(400).json({ message: "Invalid user ID format" });
  }

  try {
    // 1. Fetch User & Profile Data
    const userQuery = `
      SELECT
        u.user_id AS id,
        u.full_name,
        u.headline,
        u.avatar_url,
        u.location,
        u.about_text,
        u.created_at,
        p.account_type,
        p.open_to,
        p.availability,
        p.work_preference
      FROM users u
      LEFT JOIN profiles p ON u.user_id = p.user_id
      WHERE u.user_id = $1
    `;
    const userResult = await pool.query(userQuery, [id]);

    if (userResult.rowCount === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const user = userResult.rows[0];

    // 2. Fetch Experiences
    const experiencesQuery = `
      SELECT
        experience_id, title, company_name, location, start_date, end_date, is_current, description
      FROM experiences
      WHERE profile_id = (SELECT profile_id FROM profiles WHERE user_id = $1)
      ORDER BY start_date DESC
    `;
    const experiencesResult = await pool.query(experiencesQuery, [id]);

    // 3. Fetch Educations
    const educationsQuery = `
      SELECT
        education_id, school_name, degree, field_of_study, start_date, end_date, description
      FROM educations
      WHERE profile_id = (SELECT profile_id FROM profiles WHERE user_id = $1)
      ORDER BY start_date DESC
    `;
    const educationsResult = await pool.query(educationsQuery, [id]);

    // 4. Fetch Skills
    const skillsQuery = `
      SELECT s.name
      FROM user_skills us
      JOIN skills s ON us.skill_id = s.skill_id
      WHERE us.profile_id = (SELECT profile_id FROM profiles WHERE user_id = $1)
    `;
    const skillsResult = await pool.query(skillsQuery, [id]);

    // Assemble response
    const responseData = {
      ...user,
      experiences: experiencesResult.rows,
      educations: educationsResult.rows,
      skills: skillsResult.rows.map((row) => row.name),
    };

    return res.status(200).json(responseData);
  } catch (err) {
    console.error("Get user profile error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getPublicProfilePosts = async (req, res) => {
  const { id } = req.params;
  const { category } = req.body;

  const uuidRegex =
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  if (!uuidRegex.test(id)) {
    return res.status(400).json({ message: "Invalid user ID format" });
  }

  try {
    let categoryId = null;
    let result = null;
    if (!category.trim()) {
      return res.status(400).json({ message: "Category is required" });
    }
    else {
      const catRes = await pool.query(`SELECT category_id FROM post_categories WHERE name = $1`, [category.trim()]);
      if (catRes.rowCount > 0) {
        categoryId = catRes.rows[0].category_id;
      } else {
        return res.status(400).json({ message: "Invalid category" });
      }
    }

    if (category.trim() === 'All') {
      result = await pool.query(
        `select p.post_id,
          u.full_name,
          u.headline,
          u.avatar_url,
          p.title,
          p.category_id,
          p.content,
          p.created_at 
          from posts p join users u on u.user_id = p.author_id
          where p.author_id = $1
          order by p.created_at desc`,
        [id]
      )
    } else {
      result = await pool.query(
        `select p.post_id,
          u.full_name,
          u.headline,
          u.avatar_url,
          p.title,
          p.category_id,
          p.content,
          p.created_at 
          from posts p join users u on u.user_id = p.author_id
          where p.author_id = $1 AND (p.category_id = $2 )
          order by p.created_at desc`,
        [id, categoryId]
      )
    }

    res.status(200).json({
      category: category,
      posts: result.rows
    });
  } catch (err) {
    console.error("Get public profile posts error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }

}
/*
Manual Testing Notes:

1. Search Users:
   GET /api/users/search?q=john
   Headers: Authorization: Bearer <access_token>

   Expected:
   [
     {
       "id": "uuid...",
       "full_name": "John Doe",
       "headline": "Software Engineer",
       "avatar_url": "http://...",
       "account_type": "Employee"
     },
     ...
   ]

2. Get User Profile:
   GET /api/users/<uuid>
   Headers: Authorization: Bearer <access_token>

   Expected:
   {
     "id": "uuid...",
     "full_name": "Jane Smith",
     "headline": "Product Manager",
     ...
     "experiences": [...],
     "educations": [...],
     "skills": ["JavaScript", "Leadership"]
   }
*/
