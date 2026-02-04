const pool = require("../db/pool");
const current_user = require("../controllers/profile.controller");

/**
 * GET /api/users/search
 * Purpose: Real-time user discovery and mention autocomplete
 */
exports.searchUsers = async (req, res) => {
  const { q, accountType } = req.query;
  const currentUserId = req.user.sub;

  if (!q || typeof q !== "string" || q.trim().length === 0) {
    return res.status(400).json({ message: "Search query 'q' is required" });
  }

  const searchTerm = q.trim().replace(/^['\"]|['\"]$/g, '');

  try {
    // Construct the query dynamically based on optional filters
    let queryText = `
      SELECT
        u.user_id AS id,
        u.full_name,
        u.account_name,
        u.headline,
        u.avatar_url,
        p.account_type
      FROM users u
      LEFT JOIN profiles p ON u.user_id = p.user_id
      WHERE u.user_id != $1
    `;

    const queryParams = [currentUserId];
    let paramIndex = 2;

    // Add search condition - search by both full_name and account_name
    queryText += ` AND (u.full_name ILIKE $${paramIndex} OR u.account_name ILIKE $${paramIndex})`;
    queryParams.push(`%${searchTerm}%`);
    paramIndex++;

    // Optional accountType filter
    if (accountType) {
      queryText += ` AND p.account_type = $${paramIndex}`;
      queryParams.push(accountType);
      paramIndex++;
    }

    // Order by similarity (closest match first)
    // Prioritize account_name exact matches, then similarity
    queryText += `
      ORDER BY 
        CASE WHEN u.account_name ILIKE $${paramIndex} THEN 0 ELSE 1 END,
        SIMILARITY(u.full_name, $${paramIndex + 1}) DESC
      LIMIT 10
    `;
    // Pass the search term for exact match check and similarity
    queryParams.push(`${searchTerm}`, searchTerm);

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

  let targetUserId = id;

  if (!uuidRegex.test(id)) {
    // If not a UUID, try to resolve as account_name
    try {
      const resolveResult = await pool.query(
        "SELECT user_id FROM users WHERE account_name = $1",
        [id]
      );
      if (resolveResult.rowCount === 0) {
        return res.status(404).json({ message: "User handle not found" });
      }
      targetUserId = resolveResult.rows[0].user_id;
    } catch (err) {
      console.error("Handle resolution error:", err);
      return res.status(500).json({ message: "Internal server error during handle resolution" });
    }
  }

  try {
    // --- View Counting Logic ---
    if (targetUserId !== currentUserId) {
      const viewCheck = await pool.query(
        `SELECT view_id FROM profile_views 
         WHERE viewer_id = $1 AND profile_owner_id = $2 
         AND viewed_at > NOW() - INTERVAL '24 hours'`,
        [currentUserId, targetUserId]
      );

      if (viewCheck.rowCount === 0) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(
            `INSERT INTO profile_views (viewer_id, profile_owner_id) VALUES ($1, $2)`,
            [currentUserId, targetUserId]
          );
          await client.query(
            `UPDATE profiles SET profile_views_count = COALESCE(profile_views_count, 0) + 1 WHERE user_id = $1`,
            [targetUserId]
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
    const userResult = await pool.query(userQuery, [targetUserId]);

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
    const experiencesResult = await pool.query(experiencesQuery, [targetUserId]);

    // 3. Fetch Educations
    const educationsQuery = `
      SELECT
        education_id, school_name, degree, field_of_study, start_date, end_date, description
      FROM educations
      WHERE profile_id = (SELECT profile_id FROM profiles WHERE user_id = $1)
      ORDER BY start_date DESC
    `;
    const educationsResult = await pool.query(educationsQuery, [targetUserId]);

    // 4. Fetch Skills
    const skillsQuery = `
      SELECT s.name
      FROM user_skills us
      JOIN skills s ON us.skill_id = s.skill_id
      WHERE us.profile_id = (SELECT profile_id FROM profiles WHERE user_id = $1)
    `;
    const skillsResult = await pool.query(skillsQuery, [targetUserId]);

    // 5. Check if I am following them
    // $1 = profileUser (them), $2 = currentUser (me)
    const isFollowingQuery = `
      SELECT 1 
      FROM followers 
      WHERE follower_id = $2 AND following_id = $1
    `;
    const isFollowingResult = await pool.query(isFollowingQuery, [targetUserId, currentUserId]);


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

  let targetUserId = userId;

  if (!uuidRegex.test(userId)) {
    // If not a UUID, try to resolve as account_name
    try {
      const resolveResult = await pool.query(
        "SELECT user_id FROM users WHERE account_name = $1",
        [userId]
      );
      if (resolveResult.rowCount === 0) {
        return res.status(404).json({ message: "User handle not found" });
      }
      targetUserId = resolveResult.rows[0].user_id;
    } catch (err) {
      console.error("Handle resolution error in posts:", err);
      return res.status(500).json({ message: "Internal server error during handle resolution" });
    }
  }

  try {
    const params = [targetUserId];
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

    const userParamIdx = params.length + 1; // Index for current user (will be pushed later)

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

        COALESCE(
          (SELECT json_agg(json_build_object('url', pm.url, 'media_type', pm.media_type)) 
           FROM post_media pm WHERE pm.post_id = p.post_id),
          '[]'::json
        ) AS media,

        (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.post_id)::int AS like_count,
        (SELECT COUNT(*) FROM post_comments pc WHERE pc.post_id = p.post_id)::int AS comment_count,

        EXISTS(SELECT 1 FROM post_likes pl WHERE pl.post_id = p.post_id AND pl.user_id = $${userParamIdx}) AS is_liked,

        (
          SELECT json_build_object(
            'poll_id', pp.poll_id,
            'duration', COALESCE(pp.duration, '1 day'),
            'total_votes', (SELECT COUNT(*) FROM poll_votes pv WHERE pv.poll_id = pp.poll_id)::int,
            'user_vote', (SELECT pv_u.option_id FROM poll_votes pv_u WHERE pv_u.poll_id = pp.poll_id AND pv_u.voter_id = $${userParamIdx}),
            'is_active', (pp.created_at + COALESCE(pp.duration, '1 day')::interval > NOW()),
            'options', COALESCE(
              (SELECT json_agg(json_build_object('option_id', po.option_id, 'option_text', po.option_text, 'vote_count', (SELECT COUNT(*) FROM poll_votes pv WHERE pv.option_id = po.option_id))) FROM poll_options po WHERE po.poll_id = pp.poll_id),
              '[]'::json
            )
          )
          FROM post_polls pp WHERE pp.post_id = p.post_id
        ) AS poll,

        --Shared Post Data
        CASE 
          WHEN p.shared_post_id IS NULL THEN NULL
          WHEN sp.post_id IS NULL THEN 
            json_build_object('is_accessible', false, 'reason', 'deleted')
          WHEN (
            --1. Private: Author only
            (sp.visibility = 'private' AND sp.author_id = $${userParamIdx})
            OR
            --2. Public + Personal: Connections only
            (sp.visibility = 'public' AND sp_cat.name = 'Personal' AND (
              sp.author_id = $${userParamIdx}
              OR EXISTS(
                  SELECT 1 FROM followers f1 
                  JOIN followers f2 ON f1.follower_id = f2.following_id AND f1.following_id = f2.follower_id 
                  WHERE f1.follower_id = $${userParamIdx} AND f1.following_id = sp.author_id
              )
            ))
            OR
            --3. Public + Other: Everyone
            (sp.visibility = 'public' AND (sp_cat.name != 'Personal' OR sp_cat.name IS NULL))
          ) THEN
            json_build_object(
              'is_accessible', true,
              'post_id', sp.post_id,
              'content', sp.content,
              'created_at', sp.created_at,
              'author', json_build_object(
                'user_id', sp_u.user_id,
                'full_name', sp_u.full_name,
                'avatar_url', sp_u.avatar_url
              ),
              'media', COALESCE((SELECT json_agg(json_build_object('url', pm.url, 'media_type', pm.media_type)) FROM post_media pm WHERE pm.post_id = sp.post_id), '[]'::json),
              'like_count', (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = sp.post_id)::int,
              'comment_count', (SELECT COUNT(*) FROM post_comments pc WHERE pc.post_id = sp.post_id)::int,
              'is_liked', EXISTS(SELECT 1 FROM post_likes pl WHERE pl.post_id = sp.post_id AND pl.user_id = $${userParamIdx}),
              'poll', (
                SELECT json_build_object(
                  'poll_id', pp.poll_id,
                  'duration', COALESCE(pp.duration, '1 day'),
                  'total_votes', (SELECT COUNT(*) FROM poll_votes pv WHERE pv.poll_id = pp.poll_id)::int,
                  'user_vote', (SELECT pv_u.option_id FROM poll_votes pv_u WHERE pv_u.poll_id = pp.poll_id AND pv_u.voter_id = $${userParamIdx}),
                  'is_active', (pp.created_at + COALESCE(pp.duration, '1 day')::interval > NOW()),
                  'options', COALESCE(
                    (SELECT json_agg(json_build_object('option_id', po.option_id, 'option_text', po.option_text, 'vote_count', (SELECT COUNT(*) FROM poll_votes pv WHERE pv.option_id = po.option_id))) FROM poll_options po WHERE po.poll_id = pp.poll_id),
                    '[]'::json
                  )
                )
                FROM post_polls pp WHERE pp.post_id = sp.post_id
              )
            )
          --Failure Analysis
          WHEN sp.visibility = 'private' THEN json_build_object(
            'is_accessible', false,
            'reason', 'private',
            'author', json_build_object(
              'user_id', sp_u.user_id,
              'full_name', sp_u.full_name,
              'avatar_url', sp_u.avatar_url
            )
          )
          WHEN (sp.visibility = 'public' AND sp_cat.name = 'Personal') THEN json_build_object(
            'is_accessible', false,
            'reason', 'personal_connection',
            'author', json_build_object(
              'user_id', sp_u.user_id,
              'full_name', sp_u.full_name,
              'avatar_url', sp_u.avatar_url
            )
          )
          ELSE
            json_build_object('is_accessible', false, 'reason', 'unknown')
        END AS shared_post

      FROM posts p
      JOIN users u ON u.user_id = p.author_id
      LEFT JOIN post_categories pc ON pc.category_id = p.category_id
      LEFT JOIN posts sp ON p.shared_post_id = sp.post_id
      LEFT JOIN users sp_u ON sp.author_id = sp_u.user_id
      LEFT JOIN post_categories sp_cat ON sp.category_id = sp_cat.category_id

      ${whereClause}
      
      -- Privacy Escalation: Hide reposts if original post's privacy tightened
      AND (
          p.shared_post_id IS NULL 
          OR sp.post_id IS NULL -- Still show if deleted (but with 'deleted' reason above)
          OR (
              -- Accessible if:
              -- 1. Original is Public + Not personal
              (sp.visibility = 'public' AND (sp_cat.name != 'Personal' OR sp_cat.name IS NULL))
              -- 2. Original is Public + Personal and connected
              OR (sp.visibility = 'public' AND sp_cat.name = 'Personal' AND (
                  sp.author_id = $${userParamIdx}
                  OR EXISTS(
                      SELECT 1 FROM followers f1 
                      JOIN followers f2 ON f1.follower_id = f2.following_id AND f1.following_id = f2.follower_id 
                      WHERE f1.follower_id = $${userParamIdx} AND f1.following_id = sp.author_id
                  )
              ))
              -- 3. Original is Private and viewer is author
              OR (sp.visibility = 'private' AND sp.author_id = $${userParamIdx})
          )
      )

      ORDER BY p.created_at DESC, p.post_id DESC
      LIMIT $${idx};
    `;

    // Add current user ID to params for is_liked check and user_vote check
    params.push(req.user.sub);

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