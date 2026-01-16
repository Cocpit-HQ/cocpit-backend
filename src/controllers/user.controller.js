const pool = require("../db/pool");
const current_user = require("../controllers/profile.controller")
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
  const currentUserId = req.user.sub;

  if (id === currentUserId) {
    return current_user.getMyProfile(req, res);
  }


  // Basic validation for UUID
  const uuidRegex =
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  if (!uuidRegex.test(id)) {
    return res.status(400).json({ message: "Invalid user ID format" });
  }

  try {
    // --- View Counting Logic ---
    if (id !== currentUserId) {
      const viewCheck = await pool.query(
        `SELECT view_id FROM profile_views 
         WHERE viewer_id = $1 AND profile_owner_id = $2 
         AND viewed_at > NOW() - INTERVAL '24 hours'`,
        [currentUserId, id]
      );

      if (viewCheck.rowCount === 0) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(
            `INSERT INTO profile_views (viewer_id, profile_owner_id) VALUES ($1, $2)`,
            [currentUserId, id]
          );
          await client.query(
            `UPDATE profiles SET profile_views_count = COALESCE(profile_views_count, 0) + 1 WHERE user_id = $1`,
            [id]
          );
          await client.query('COMMIT');
        } catch (e) {
          await client.query('ROLLBACK');
          console.error("View count update failed", e);
        } finally {
          client.release();
        }
      }
    }
    // ---------------------------

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

    // 5. Check if I am following them
    // $1 = profileUser (them), $2 = currentUser (me)
    const isFollowingQuery = `
      SELECT 1 
      FROM followers 
      WHERE follower_id = $2 AND following_id = $1
    `;
    const isFollowingResult = await pool.query(isFollowingQuery, [id, currentUserId]);


    // Assemble response
    const responseData = {
      ...user,
      experiences: experiencesResult.rows,
      educations: educationsResult.rows,
      skills: skillsResult.rows.map((row) => row.name),
      is_following: isFollowingResult.rowCount > 0, // ✅ Fixed logic and field name
    };

    return res.status(200).json(responseData);
  } catch (err) {
    console.error("Get user profile error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getPublicProfilePosts = async (req, res) => {
  const { id: userId } = req.params;
  const {
    category,
    cursorCreatedAt,
    cursorPostId,
    limit = 10,
  } = req.query;

  // ✅ Validate UUID
  const uuidRegex =
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

  if (!uuidRegex.test(userId)) {
    return res.status(400).json({ message: "Invalid user ID format" });
  }

  try {
    const params = [userId];
    let idx = 2;
    let whereClause = `WHERE p.author_id = $1
  AND p.visibility = 'public'
`;

    // ✅ Category filter (skip "All")
    if (category && category !== "All") {
      whereClause += ` AND pc.name = $${idx}`;
      params.push(category);
      idx++;
    }

    // ✅ Cursor-based pagination (stable ordering)
    if (cursorCreatedAt && cursorPostId) {
      whereClause += `
        AND (p.created_at, p.post_id) < ($${idx}, $${idx + 1})
      `;
      params.push(cursorCreatedAt, cursorPostId);
      idx += 2;
    }

    // ✅ LIMIT
    params.push(limit);

    const query = `
      SELECT
        p.post_id,
        p.content,
        p.created_at,
        p.visibility,

        u.user_id AS author_id,
        u.full_name AS author_name,
        u.avatar_url AS author_avatar,

        pc.name AS category_name,

        COALESCE(pm.media, '[]'::json) AS media,
        COALESCE(lc.like_count, 0) AS like_count,
        COALESCE(cc.comment_count, 0) AS comment_count,

        pp.poll

      FROM posts p
      JOIN users u ON u.user_id = p.author_id
      LEFT JOIN post_categories pc ON pc.category_id = p.category_id

      -- MEDIA
      LEFT JOIN (
        SELECT
          pm.post_id,
          json_agg(
            json_build_object(
              'media_id', pm.media_id,
              'url', pm.url,
              'media_type', pm.media_type,
              'aspect_ratio', pm.aspect_ratio
            )
          ) AS media
        FROM post_media pm
        GROUP BY pm.post_id
      ) pm ON pm.post_id = p.post_id

      -- LIKE COUNT
      LEFT JOIN (
        SELECT post_id, COUNT(*) AS like_count
        FROM post_likes
        GROUP BY post_id
      ) lc ON lc.post_id = p.post_id

      -- COMMENT COUNT
      LEFT JOIN (
        SELECT post_id, COUNT(*) AS comment_count
        FROM post_comments
        GROUP BY post_id
      ) cc ON cc.post_id = p.post_id

      -- POLL
      LEFT JOIN (
        SELECT
          pp.post_id,
          json_build_object(
            'poll_id', pp.poll_id,
            'duration', pp.duration,
            'total_votes', COALESCE(pv.total_votes, 0),
            'options', COALESCE(po.options, '[]'::json)
          ) AS poll
        FROM post_polls pp

        LEFT JOIN (
          SELECT
            t.poll_id,
            json_agg(
              json_build_object(
                'option_id', t.option_id,
                'option_text', t.option_text,
                'vote_count', t.vote_count
              )
            ) AS options
          FROM (
            SELECT
              po.option_id,
              po.poll_id,
              po.option_text,
              COUNT(pv.vote_id) AS vote_count
            FROM poll_options po
            LEFT JOIN poll_votes pv ON pv.option_id = po.option_id
            GROUP BY po.option_id, po.poll_id, po.option_text
          ) t
          GROUP BY t.poll_id
        ) po ON po.poll_id = pp.poll_id

        LEFT JOIN (
          SELECT poll_id, COUNT(*) AS total_votes
          FROM poll_votes
          GROUP BY poll_id
        ) pv ON pv.poll_id = pp.poll_id
      ) pp ON pp.post_id = p.post_id

      ${whereClause}
      ORDER BY p.created_at DESC, p.post_id DESC
      LIMIT $${idx};
    `;

    const { rows } = await pool.query(query, params);
    const last = rows[rows.length - 1];

    res.json({
      posts: rows,
      nextCursor: last
        ? {
          cursorCreatedAt: last.created_at,
          cursorPostId: last.post_id,
        }
        : null,
    });
  } catch (err) {
    console.error("Get public profile posts error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};