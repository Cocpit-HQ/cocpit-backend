const pool = require("../db/pool");
const AppError = require("../utils/AppError");
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
    const queryParams = [currentUserId];
    const likeTerm = `%${searchTerm}%`;
    queryParams.push(likeTerm); // $2

    let userAccountFilter = "";
    if (accountType) {
      queryParams.push(accountType); // $3
      userAccountFilter = `AND p.account_type = $3`;
    }

    // Similarity param (raw term)
    queryParams.push(searchTerm);
    const simParamIdx = queryParams.length; // $3 or $4

    const queryText = `
      SELECT * FROM (
        (
          SELECT
            u.user_id AS id,
            u.full_name,
            u.account_name,
            u.headline,
            u.avatar_url,
            p.account_type,
            'USER'::text as type,
            NULL::text as slug
          FROM users u
          LEFT JOIN profiles p ON u.user_id = p.user_id
          WHERE u.user_id != $1
          AND (u.full_name ILIKE $2 OR u.account_name ILIKE $2)
          ${userAccountFilter}
          AND NOT EXISTS (
            SELECT 1 FROM blocks b 
            WHERE (b.blocker_id = $1 AND b.blocked_id = u.user_id)
               OR (b.blocker_id = u.user_id AND b.blocked_id = $1)
          )
        )
        UNION ALL
        (
          SELECT
            c.company_id AS id,
            c.name AS full_name,
            c.slug AS account_name,
            c.industry AS headline,
            c.logo_url AS avatar_url,
            NULL::text AS account_type,
            'COMPANY'::text as type,
            c.slug as slug
          FROM companies c
          WHERE c.is_deleted = FALSE
          AND (c.name ILIKE $2 OR c.slug ILIKE $2)
        )
      ) AS combined_results
      ORDER BY 
        CASE WHEN account_name ILIKE $2 THEN 0 ELSE 1 END,
        SIMILARITY(full_name, $${simParamIdx}) DESC
      LIMIT 10
    `;

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

  // Import block check util if not already imported (it's not)
  const { checkBlockStatus } = require("../utils/blockCheck");

  // ... existing code ...

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

  // --- Block Check Implementation ---
  if (targetUserId !== currentUserId) {
    const isBlocked = await checkBlockStatus(currentUserId, targetUserId);
    if (isBlocked) {
      return res.status(404).json({ message: "User not found" });
    }
  }
  // ----------------------------------


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
        u.full_name AS name,
        u.headline,
        u.avatar_url AS avatar,
        u.location,
        u.about_text AS about,
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

    // 6. Fetch Company Roles (Public View - Only Visible Roles)
    const companyRoles = await pool.query(
      `
      SELECT 
        c.company_id, 
        c.name, 
        c.slug, 
        c.logo_url, 
        cr.name as role,
        cm.is_primary_display
      FROM company_members cm
      JOIN companies c ON cm.company_id = c.company_id
      JOIN company_roles cr ON cm.role_id = cr.role_id
      WHERE cm.user_id = $1 
      AND cm.is_role_visible = TRUE
      ORDER BY cm.is_primary_display DESC, cr.priority DESC, c.name ASC
      `,
      [targetUserId]
    );


    // Assemble response
    const responseData = {
      user: user,
      experiences: experiencesResult.rows,
      educations: educationsResult.rows,
      skills: skillsResult.rows.map((row) => row.name),
      is_following: isFollowingResult.rowCount > 0,
      company_roles: companyRoles.rows,
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

  // --- Block Check Implementation ---
  const currentUserId = req.user.sub;
  if (targetUserId !== currentUserId) {
    const { checkBlockStatus } = require("../utils/blockCheck"); // Ensure import scope
    const isBlocked = await checkBlockStatus(currentUserId, targetUserId);
    if (isBlocked) {
      return res.status(404).json({ message: "User not found" });
    }
  }
  // ----------------------------------


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

    // ✅ Strict Block Logic for Shared Posts (dependant on userParamIdx which is derived from params.length + 1)
    // We can't interpolate userParamIdx here because it's calculated afterwards.
    // BUT, we know userParamIdx will be the LAST parameter pushed (req.user.sub).
    // So usually it is params.length + 1 (after limit).
    // Let's use a placeholder or interpolation.
    // Actually, userParamIdx is calculated at line 313.
    // Accessing it inside whereClause string is fine because whereClause is interpolated into query string at line 435.
    // So we just need to ensure we use the variable `${userParamIdx}` in the string literal, but `userParamIdx` isn't defined yet!
    // Ah, wait. `whereClause` is a string accumulating parts.
    // If I add it *before* `userParamIdx` is defined, I can't use `userParamIdx`.
    // OPTION: Add it to the query string *literally* at line 436, using `${userParamIdx}` which IS defined there.

    // Changing approach: I will modify the query string directly at line 437.


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
      
      -- Strict Block Logic: Exclude reposts if original author is blocked
      AND (
          p.shared_post_id IS NULL 
          OR NOT EXISTS (
              SELECT 1 FROM blocks b 
              WHERE (b.blocker_id = $${userParamIdx} AND b.blocked_id = sp.author_id)
                 OR (b.blocker_id = sp.author_id AND b.blocked_id = $${userParamIdx})
          )
      )

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

/**
 * DELETE /api/users/account
 * Purpose: Permanent account deletion
 */
exports.deleteAccount = async (req, res) => {
  const userId = req.user.sub;
  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ message: "Password is required for account deletion" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Verify password
    const userRes = await client.query(
      "SELECT password_hash FROM users WHERE user_id = $1",
      [userId]
    );

    if (userRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "User not found" });
    }

    const { comparePassword } = require("../utils/password");
    const isValid = await comparePassword(password, userRes.rows[0].password_hash);

    if (!isValid) {
      await client.query("ROLLBACK");
      return res.status(401).json({ message: "Invalid password" });
    }

    // 2. Handle Group Admin Transfer
    // Find groups where this user is admin
    const adminGroups = await client.query(
      "SELECT conversation_id FROM conversations WHERE admin_id = $1 AND is_group = true",
      [userId]
    );

    for (const group of adminGroups.rows) {
      const groupId = group.conversation_id;

      // Find the next eligible admin (oldest member who isn't the current user)
      const nextAdminRes = await client.query(
        `SELECT user_id FROM conversation_participants 
         WHERE conversation_id = $1 AND user_id != $2 AND left_at IS NULL
         ORDER BY joined_at ASC LIMIT 1`,
        [groupId, userId]
      );

      if (nextAdminRes.rowCount > 0) {
        const nextAdminId = nextAdminRes.rows[0].user_id;
        await client.query(
          "UPDATE conversations SET admin_id = $1 WHERE conversation_id = $2",
          [nextAdminId, groupId]
        );
      } else {
        // No other members, set admin to null
        await client.query(
          "UPDATE conversations SET admin_id = NULL WHERE conversation_id = $1",
          [groupId]
        );
      }
    }

    // 3. Check for Orphaned Companies (Sole Owner)
    // Find all companies where this user is OWNER
    const ownedCompanies = await client.query(
      `SELECT company_id, name FROM company_members WHERE user_id = $1 AND role = 'OWNER'`,
      [userId]
    );

    for (const company of ownedCompanies.rows) {
      // Check if there are ANY other owners for this company
      const otherOwners = await client.query(
        `SELECT 1 FROM company_members 
         WHERE company_id = $1 AND role = 'OWNER' AND user_id != $2`,
        [company.company_id, userId]
      );

      if (otherOwners.rowCount === 0) {
        throw new AppError(`You are the sole owner of "${company.name}". Please transfer ownership or delete the company before deleting your account.`, 400);
      }
    }

    // 4. Delete user record (Cascades handled by DB)
    await client.query("DELETE FROM users WHERE user_id = $1", [userId]);

    await client.query("COMMIT");

    // 4. Clear cookies
    res.clearCookie("refreshToken", {
      httpOnly: true,
      secure: true,
      sameSite: "None",
      path: "/",
    });

    return res.status(200).json({ message: "Account deleted successfully" });
  } catch (err) {
    if (client) await client.query("ROLLBACK");
    console.error("Account deletion error:", err);
    return res.status(500).json({ message: "Internal server error during account deletion" });
  } finally {
    if (client) client.release();
  }
};

/**
 * GET /api/users/suggested
 * Purpose: Provide user recommendations for new accounts or discovery
 */
exports.getSuggestedUsers = async (req, res) => {
  const currentUserId = req.user.sub;

  try {
    const query = `
      SELECT 
        u.user_id AS id,
        u.full_name,
        u.account_name,
        u.avatar_url,
        u.headline,
        p.account_type,
        (SELECT COUNT(*) FROM followers WHERE following_id = u.user_id) as followers_count
      FROM users u
      LEFT JOIN profiles p ON u.user_id = p.user_id
      WHERE u.user_id != $1
      AND NOT EXISTS (
        SELECT 1 FROM followers WHERE follower_id = $1 AND following_id = u.user_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM blocks b 
        WHERE (b.blocker_id = $1 AND b.blocked_id = u.user_id)
           OR (b.blocker_id = u.user_id AND b.blocked_id = $1)
      )
      ORDER BY followers_count DESC, u.created_at DESC
      LIMIT 15
    `;

    const result = await pool.query(query, [currentUserId]);
    res.status(200).json(result.rows);
  } catch (err) {
    console.error("Get suggested users error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};