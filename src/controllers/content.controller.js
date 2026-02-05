const { ur, vi } = require("zod/locales");
const pool = require("../db/pool");
const socketService = require("../services/socket.service");
const { checkBlockStatus } = require("../utils/blockCheck");

// --- Feed / Posts ---
exports.getPublicFeed = async (req, res) => {
    const { cursorCreatedAt, cursorPostId } = req.query;
    const limit = 10;

    try {
        const params = [];
        let cursorCondition = "";

        // 1. Cursor Handling
        if (cursorCreatedAt && cursorPostId) {
            params.push(cursorCreatedAt, cursorPostId);
            // Since this is first, we know indices are $1 and $2
            cursorCondition = `AND (p.created_at, p.post_id) < ($${params.length - 1}, $${params.length})`;
        }

        // 2. Limit
        params.push(limit);
        const limitParamIdx = params.length;

        // 3. User ID (needed for subqueries)
        const userId = req.user ? req.user.sub : null;

        params.push(userId);
        const userParamIdx = params.length;

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

            (pl_me.post_id IS NOT NULL) AS is_liked,

            (
                SELECT json_build_object(
                    'poll_id', pp.poll_id,
                    'options', (
                        SELECT json_agg(json_build_object('option_id', po.option_id, 'option_text', po.option_text, 'vote_count', (SELECT COUNT(*) FROM poll_votes pv WHERE pv.option_id = po.option_id)))
                        FROM poll_options po WHERE po.poll_id = pp.poll_id
                    ),
                    'total_votes', (SELECT COUNT(*) FROM poll_votes pv WHERE pv.poll_id = pp.poll_id),
                    'duration', COALESCE(pp.duration, '1 day'),
                    'user_vote', (SELECT pv_u.option_id FROM poll_votes pv_u WHERE pv_u.poll_id = pp.poll_id AND pv_u.voter_id = $${userParamIdx}),
                    'is_active', (pp.created_at + COALESCE(pp.duration, '1 day')::interval > NOW())
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

        -- Like Check Join
        LEFT JOIN post_likes pl_me ON pl_me.post_id = p.post_id AND pl_me.user_id = $${userParamIdx}

        --Shared Post Joins
        LEFT JOIN posts sp ON p.shared_post_id = sp.post_id
        LEFT JOIN users sp_u ON sp.author_id = sp_u.user_id
        LEFT JOIN post_categories sp_cat ON sp.category_id = sp_cat.category_id

        WHERE p.visibility = 'public'
        AND NOT EXISTS (
            SELECT 1 FROM blocks b 
            WHERE (b.blocker_id = $${userParamIdx} AND b.blocked_id = p.author_id)
               OR (b.blocker_id = p.author_id AND b.blocked_id = $${userParamIdx})
        )
        -- STRICT REPOST BLOCKING: Exclude repost if original author is blocked
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
        ${cursorCondition}

        ORDER BY p.created_at DESC, p.post_id DESC
        LIMIT $${limitParamIdx}
        `;

        const { rows } = await pool.query(query, params);

        const last = rows[rows.length - 1];

        res.json({
            posts: rows,
            nextCursor: last
                ? {
                    cursorCreatedAt: last.created_at,
                    cursorPostId: last.post_id
                }
                : null
        });

    } catch (err) {
        console.error("Get feed error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.getMyPosts = async (req, res) => {
    const userId = req.user.sub;
    const {
        category,
        cursorCreatedAt,
        cursorPostId,
        limit = 10,
    } = req.query;

    try {
        const params = [userId];
        let idx = 2;
        let whereClause = `WHERE p.author_id = $1`;

        // ✅ Category filter (skip if "All")
        if (category && category !== "All") {
            whereClause += ` AND pc.name = $${idx} `;
            params.push(category);
            idx++;
        }

        // ✅ Cursor-based pagination (stable)
        if (cursorCreatedAt && cursorPostId) {
            whereClause += `
        AND(p.created_at, p.post_id) < ($${idx}, $${idx + 1})
        `;
            params.push(cursorCreatedAt, cursorPostId);
            idx += 2;
        }

        // ✅ Strict Block Logic for Shared Posts
        whereClause += `
        AND (
            p.shared_post_id IS NULL 
            OR NOT EXISTS (
                SELECT 1 FROM blocks b 
                WHERE (b.blocker_id = $1 AND b.blocked_id = sp.author_id)
                   OR (b.blocker_id = sp.author_id AND b.blocked_id = $1)
            )
        )
        `;

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

                            COALESCE(pm.media, '[]':: json) AS media,
                                COALESCE(lc.like_count, 0) AS like_count,
                                    EXISTS(SELECT 1 FROM post_likes pl WHERE pl.post_id = p.post_id AND pl.user_id = $1) AS is_liked,
                                        COALESCE(cc.comment_count, 0) AS comment_count,

                                            pp.poll,

                                             --Shared Post Data
                                            CASE 
                                                WHEN p.shared_post_id IS NULL THEN NULL
                                                WHEN sp.post_id IS NULL THEN 
                                                    json_build_object('is_accessible', false, 'reason', 'deleted')
                                                WHEN (
                                                    -- 1. Private: Author only
                                                    (sp.visibility = 'private' AND sp.author_id = $1)
                                                    OR
                                                    -- 2. Public + Personal: Connections only
                                                    (sp.visibility = 'public' AND sp_cat.name = 'Personal' AND (
                                                        sp.author_id = $1
                                                        OR EXISTS (
                                                            SELECT 1 FROM followers f1 
                                                            JOIN followers f2 ON f1.follower_id = f2.following_id AND f1.following_id = f2.follower_id 
                                                            WHERE f1.follower_id = $1 AND f1.following_id = sp.author_id
                                                        )
                                                    ))
                                                    OR
                                                    -- 3. Public + Other: Everyone
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
                                                        'media', COALESCE(sp_media.media, '[]'::json),
                                                        'like_count', (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = sp.post_id)::int,
                                                        'comment_count', (SELECT COUNT(*) FROM post_comments pc WHERE pc.post_id = sp.post_id)::int,
                                                        'is_liked', EXISTS(SELECT 1 FROM post_likes pl WHERE pl.post_id = sp.post_id AND pl.user_id = $1)
                                                    )
                                                -- Failure Analysis
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

        --Shared Post Joins
      LEFT JOIN posts sp ON p.shared_post_id = sp.post_id
      LEFT JOIN users sp_u ON sp.author_id = sp_u.user_id
      LEFT JOIN post_categories sp_cat ON sp.category_id = sp_cat.category_id
      LEFT JOIN(
            SELECT post_id, json_agg(json_build_object('url', url, 'media_type', media_type)) as media
          FROM post_media
          GROUP BY post_id
        ) sp_media ON sp.post_id = sp_media.post_id

        -- ✅ MEDIA
      LEFT JOIN(
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

        -- ✅ LIKE COUNT
      LEFT JOIN(
            SELECT post_id, COUNT(*) AS like_count
        FROM post_likes
        GROUP BY post_id
        ) lc ON lc.post_id = p.post_id

        -- ✅ COMMENT COUNT
      LEFT JOIN(
            SELECT post_id, COUNT(*) AS comment_count
        FROM post_comments
        GROUP BY post_id
        ) cc ON cc.post_id = p.post_id

        -- ✅ POLL
      LEFT JOIN(
            SELECT
          pp.post_id,
            json_build_object(
                'poll_id', pp.poll_id,
                'duration', COALESCE(pp.duration, '1 day'),
                'total_votes', COALESCE(pv.total_votes, 0),
                'user_vote', (SELECT pv_u.option_id FROM poll_votes pv_u WHERE pv_u.poll_id = pp.poll_id AND pv_u.voter_id = $1),
            'options', COALESCE(po.options, '[]':: json),
            'is_active', (pp.created_at + COALESCE(pp.duration, '1 day'):: interval > NOW())
          ) AS poll
        FROM post_polls pp

        LEFT JOIN(
                SELECT
            t.poll_id,
                json_agg(
                    json_build_object(
                        'option_id', t.option_id,
                        'option_text', t.option_text,
                        'vote_count', t.vote_count
                    )
                ) AS options
          FROM(
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

        LEFT JOIN(
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
        console.error("Get user posts error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

//   const userId = req.user.sub;
//   const { category, cursorCreatedAt, cursorPostId } = req.query;
//   const limit = 10;

//   try {
//     const params = [userId];
//     let cursorCondition = "";
//     let idx = 2;

//     let query = `
//       SELECT
//         p.post_id,
//         p.content,
//         p.created_at,
//         p.visibility,

//         u.user_id AS author_id,
//         u.full_name AS author_name,
//         COALESCE(u.avatar_url, 'https://default-avatar.png') AS author_avatar,

//         pc.name AS category_name,

//         COALESCE(pm.media, '[]') AS media,

//         COALESCE(lc.like_count, 0)::int AS like_count,
//         COALESCE(cc.comment_count, 0)::int AS comment_count,

//         pp.poll
//       FROM posts p
//       JOIN users u ON u.user_id = p.author_id
//       LEFT JOIN post_categories pc ON pc.category_id = p.category_id

//       LEFT JOIN (
//         SELECT post_id, json_agg(pm.* ORDER BY pm.created_at) AS media
//         FROM post_media pm
//         GROUP BY post_id
//       ) pm ON pm.post_id = p.post_id

//       LEFT JOIN (
//         SELECT post_id, COUNT(*) AS like_count
//         FROM post_likes
//         GROUP BY post_id
//       ) lc ON lc.post_id = p.post_id

//       LEFT JOIN (
//         SELECT post_id, COUNT(*) AS comment_count
//         FROM post_comments
//         GROUP BY post_id
//       ) cc ON cc.post_id = p.post_id

//       LEFT JOIN (
//         SELECT
//           pp.post_id,
//           json_build_object(
//             'poll_id', pp.poll_id,
//             'duration', COALESCE(pp.duration, '1 day'),
//             'total_votes', COALESCE(pv.total_votes, 0),
//             'options', COALESCE(po.options, '[]')
//           ) AS poll
//         FROM post_polls pp
//         LEFT JOIN (
//           SELECT poll_id,
//                  json_agg(
//                    json_build_object(
//                      'option_id', option_id,
//                      'option_text', option_text,
//                      'vote_count', vote_count
//                    )
//                  ) AS options
//           FROM (
//             SELECT po.option_id, po.poll_id, po.option_text,
//                    COUNT(pv.vote_id) AS vote_count
//             FROM poll_options po
//             LEFT JOIN poll_votes pv ON pv.option_id = po.option_id
//             GROUP BY po.option_id
//           ) t
//           GROUP BY poll_id
//         ) po ON po.poll_id = pp.poll_id
//         LEFT JOIN (
//           SELECT poll_id, COUNT(*) AS total_votes
//           FROM poll_votes
//           GROUP BY poll_id
//         ) pv ON pv.poll_id = pp.poll_id
//       ) pp ON pp.post_id = p.post_id

//       WHERE p.author_id = $1
//     `;

//     if (category) {
//       query += ` AND pc.name = $${idx}`;
//       params.push(category);
//       idx++;
//     }

//     if (cursorCreatedAt && cursorPostId) {
//       query += ` AND (p.created_at, p.post_id) < ($${idx}, $${idx + 1})`;
//       params.push(cursorCreatedAt, cursorPostId);
//       idx += 2;
//     }

//     query += ` ORDER BY p.created_at DESC, p.post_id DESC LIMIT $${idx}`;
//     params.push(limit);

//     const { rows } = await pool.query(query, params);
//     const last = rows[rows.length - 1];

//     res.json({
//       posts: rows,
//       nextCursor: last
//         ? { cursorCreatedAt: last.created_at, cursorPostId: last.post_id }
//         : null,
//     });

//   } catch (err) {
//     console.error("Get my posts error:", err);
//     res.status(500).json({ message: "Internal server error" });
//   }
// };

//--- POST INTEGRATION ---
exports.createPost = async (req, res) => {
    const userId = req.user.sub;
    let { content, category, visibility, media_urls, post_type, title, poll_options, poll_duration } = req.body; // category is name, media_urls is array

    try {
        // 0. If reposting, check if original is Personal or already reposted
        if (req.body.shared_post_id) {
            // Check if Personal
            const originalPostCheck = await pool.query(
                `SELECT pc.name FROM posts p 
                 LEFT JOIN post_categories pc ON p.category_id = pc.category_id 
                 WHERE p.post_id = $1`,
                [req.body.shared_post_id]
            );
            if (originalPostCheck.rowCount > 0 && originalPostCheck.rows[0].name === 'Personal') {
                return res.status(403).json({ message: "Personal posts cannot be reposted." });
            }

            // Check for Duplicate
            const duplicateCheck = await pool.query(
                `SELECT post_id FROM posts WHERE author_id = $1 AND shared_post_id = $2`,
                [userId, req.body.shared_post_id]
            );
            if (duplicateCheck.rowCount > 0) {
                return res.status(409).json({ message: "You have already shared this post." });
            }
        }

        // 1. Get Category ID
        let categoryId = null;
        if (!category) {
            return res.status(400).json({ message: "Category is required" });
        }
        else {
            const catRes = await pool.query(`SELECT category_id FROM post_categories WHERE name = $1`, [category]);
            if (catRes.rowCount > 0) {
                categoryId = catRes.rows[0].category_id;
            } else {
                return res.status(400).json({ message: "Invalid category" });
            }
        }

        // 2. Insert Post
        const postResult = await pool.query(
            ` INSERT INTO posts (author_id, category_id, content, visibility,post_type,title, shared_post_id)
      VALUES ($1, $2, $3, $4,$5,$6, $7)
      RETURNING post_id, created_at
      `, [userId, categoryId, content, visibility || 'public', post_type, title, req.body.shared_post_id || null]
        );

        const postId = postResult.rows[0].post_id;
        let pollId;
        if (post_type === 'poll' && poll_options) {
            const pollRes = await pool.query(
                `INSERT INTO post_polls (post_id, duration) VALUES ($1, $2) RETURNING poll_id`,
                [postId, poll_duration || '1 days'] // e.g., '1 day', '1 week'
            );

            pollId = pollRes.rows[0].poll_id;

            // Insert each option and collect them
            const insertedOptions = [];
            for (const opt of poll_options) {
                const optRes = await pool.query(
                    `INSERT INTO poll_options (poll_id, option_text) VALUES ($1, $2) RETURNING option_id, option_text`,
                    [pollId, opt]
                );
                insertedOptions.push(optRes.rows[0]);
            }
            poll_options = insertedOptions; // Replace string array with object array
        }

        let type;
        // 3. Insert Media
        if (media_urls && Array.isArray(media_urls)) {
            for (const url of media_urls) {
                type = url.toLowerCase().match(/\.(mp4|webm|mov)$/) ? 'video' : 'image';
                await pool.query(`INSERT INTO post_media (post_id, url, media_type) VALUES ($1, $2, $3)`, [postId, url, type]);
            }
        }

        // 4. Handle Repost Notification
        if (req.body.shared_post_id) {
            const originalPostRes = await pool.query(`SELECT author_id FROM posts WHERE post_id = $1`, [req.body.shared_post_id]);
            if (originalPostRes.rowCount > 0) {
                const originalAuthorId = originalPostRes.rows[0].author_id;

                // Don't notify if reposting own post
                if (originalAuthorId !== userId) {
                    // Get reposter details for notification
                    const reposterRes = await pool.query(`SELECT full_name, avatar_url FROM users WHERE user_id = $1`, [userId]);
                    const reposter = reposterRes.rows[0];

                    const notificationText = `${reposter.full_name} reposted your post`;

                    // Insert notification
                    await pool.query(
                        `INSERT INTO notifications (user_id, sender_id, type, text, reference_id) 
                          VALUES ($1, $2, $3, $4, $5)`,
                        [originalAuthorId, userId, "repost", notificationText, postId] // reference_id is the NEW post
                    );

                    // Emit socket event
                    socketService.notifyUser(originalAuthorId, "notification", {
                        type: "repost",
                        text: notificationText,
                        from: userId,
                        senderName: reposter.full_name,
                        senderAvatar: reposter.avatar_url,
                        referenceId: postId,
                        time: "Just now"
                    });
                }
            }
        }

        res.status(201).json({
            message: "Post created", postId,
            "title": title,
            "content": content,
            "category": category,
            "visibility": visibility,
            "post_type": post_type,
            "media_urls": media_urls,
            "media_type": type,
            poll: {
                poll_id: pollId,
                duration: poll_duration,
                is_active: true,
                options: poll_options // Now contains objects with option_id
            }
        });
    } catch (err) {
        console.error("Create post error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.getPostById = async (req, res) => {
    const postId = req.params.id;
    const userId = req.user ? req.user.sub : null;

    try {
        const query = `SELECT 
    p.*, 
    u.full_name AS author_name,
    u.avatar_url AS author_avatar,
    c.name AS category_name,
    c.name AS category_name,

    -- Like Count
    COALESCE(lc.like_count, 0)::int AS like_count,

    -- Comment Count
    (SELECT COUNT(*) FROM post_comments pc WHERE pc.post_id = p.post_id)::int AS comment_count,

    -- Is Liked (Fix for stale state)
    COALESCE(il.is_liked, false) AS is_liked,

    -- Media (array)
    COALESCE(
        (
            SELECT json_agg(
                json_build_object(
                    'media_id', pm.media_id,
                    'url', pm.url,
                    'media_type', pm.media_type
                )
            )
            FROM post_media pm
            WHERE pm.post_id = p.post_id
        ),
        '[]'::json
    ) AS media,

    -- Poll (object or null)
    (
        SELECT json_build_object(
            'poll_id', pp.poll_id,
            'duration', COALESCE(pp.duration, '1 day'),
            'total_votes', (SELECT COUNT(*) FROM poll_votes pv WHERE pv.poll_id = pp.poll_id)::int,
            'user_vote', (SELECT pv_u.option_id FROM poll_votes pv_u WHERE pv_u.poll_id = pp.poll_id AND pv_u.voter_id = $2),
            'is_active', (pp.created_at + COALESCE(pp.duration, '1 day')::interval > NOW()),
            'options',
            COALESCE(
                (
                    SELECT json_agg(
                        json_build_object(
                            'option_id', po.option_id,
                            'option_text', po.option_text,
                            'vote_count', (SELECT COUNT(*) FROM poll_votes pv WHERE pv.option_id = po.option_id)
                        )
                    )
                    FROM poll_options po
                    WHERE po.poll_id = pp.poll_id
                ),
                '[]'::json
            )
        )
        FROM post_polls pp
        WHERE pp.post_id = p.post_id
    ) AS poll,

    -- Shared Post Data
    CASE 
        WHEN p.shared_post_id IS NULL THEN NULL
        WHEN sp.post_id IS NULL THEN 
            json_build_object('is_accessible', false, 'reason', 'deleted')
        WHEN (
            -- 1. Private: Author only
            (sp.visibility = 'private' AND sp.author_id = $2)
            OR
            -- 2. Public + Personal: Connections only
            (sp.visibility = 'public' AND sp_cat.name = 'Personal' AND (
                sp.author_id = $2
                OR EXISTS (
                    SELECT 1 FROM followers f1 
                    JOIN followers f2 ON f1.follower_id = f2.following_id AND f1.following_id = f2.follower_id 
                    WHERE f1.follower_id = $2 AND f1.following_id = sp.author_id
                )
            ))
            OR
            -- 3. Public + Other: Everyone
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
                'media', COALESCE(sp_media.media, '[]'::json),
                'like_count', (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = sp.post_id)::int,
                'comment_count', (SELECT COUNT(*) FROM post_comments pc WHERE pc.post_id = sp.post_id)::int,
                'is_liked', EXISTS(SELECT 1 FROM post_likes pl WHERE pl.post_id = sp.post_id AND pl.user_id = $2),
                'poll', (
                    SELECT json_build_object(
                        'poll_id', pp.poll_id,
                        'duration', COALESCE(pp.duration, '1 day'),
                        'total_votes', (SELECT COUNT(*) FROM poll_votes pv WHERE pv.poll_id = pp.poll_id)::int,
                        'user_vote', (SELECT pv_u.option_id FROM poll_votes pv_u WHERE pv_u.poll_id = pp.poll_id AND pv_u.voter_id = $2),
                        'is_active', (pp.created_at + COALESCE(pp.duration, '1 day')::interval > NOW()),
                        'options',
                        COALESCE(
                            (
                                SELECT json_agg(
                                    json_build_object(
                                        'option_id', po.option_id,
                                        'option_text', po.option_text,
                                        'vote_count', (SELECT COUNT(*) FROM poll_votes pv WHERE pv.option_id = po.option_id)
                                    )
                                )
                                FROM poll_options po
                                WHERE po.poll_id = pp.poll_id
                            ),
                            '[]'::json
                        )
                    )
                    FROM post_polls pp
                    WHERE pp.post_id = sp.post_id
                )
            )
        -- Failure Analysis
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
LEFT JOIN post_categories c ON p.category_id = c.category_id

-- Shared Post Joins
LEFT JOIN posts sp ON p.shared_post_id = sp.post_id
LEFT JOIN users sp_u ON sp.author_id = sp_u.user_id
LEFT JOIN post_categories sp_cat ON sp.category_id = sp_cat.category_id
LEFT JOIN (
    SELECT post_id, json_agg(json_build_object('url', url, 'media_type', media_type)) as media
    FROM post_media
    GROUP BY post_id
) sp_media ON sp.post_id = sp_media.post_id

LEFT JOIN (
    SELECT post_id, COUNT(*) AS like_count
    FROM post_likes
    GROUP BY post_id
) lc ON lc.post_id = p.post_id
LEFT JOIN (
    SELECT post_id, true AS is_liked
    FROM post_likes
    WHERE user_id = $2
) il ON il.post_id = p.post_id
WHERE p.post_id = $1;
`

        const result = await pool.query(query, [postId, userId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ message: "Post not found" });
        }

        // STRICT BLOCK CHECK
        const post = result.rows[0];
        if (userId && post.author_id !== userId) {
            const isBlocked = await checkBlockStatus(userId, post.author_id);
            if (isBlocked) {
                return res.status(404).json({ message: "Post not found" });
            }
        }

        res.status(200).json(result.rows[0]);
    } catch (err) {
        console.error("Get post error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.updatePostById = async (req, res) => {
    const postId = req.params.id;
    const userId = req.user.sub;
    const { content, category, visibility, media_urls, post_type, title } = req.body;

    if (!postId || !userId) {
        return res.status(400).json({ message: "postId and userId are required" });
    }

    const client = await pool.connect(); // Use transaction for media consistency
    try {
        await client.query('BEGIN');

        // 1. Safety check for polls
        if (post_type === 'poll') {
            await client.query('ROLLBACK');
            return res.status(401).json({ message: "You cannot edit a poll once created" });
        }

        // 2. Resolve category ID
        const updates = [];
        const values = [];
        let index = 1;

        // title
        if (title !== undefined) {
            updates.push(`title = $${index++}`);
            values.push(title);
        }

        // content
        if (content !== undefined) {
            updates.push(`content = $${index++}`);
            values.push(content);
        }

        // visibility
        if (visibility !== undefined) {
            // Repost privacy lock logic
            const currentPostRes = await client.query('SELECT shared_post_id FROM posts WHERE post_id = $1', [postId]);
            const sharedPostId = currentPostRes.rows[0]?.shared_post_id;

            if (sharedPostId && visibility === 'public') {
                const originalPostRes = await client.query(`
                    SELECT p.visibility, c.name as category_name 
                    FROM posts p 
                    LEFT JOIN post_categories c ON p.category_id = c.category_id 
                    WHERE p.post_id = $1
                `, [sharedPostId]);

                if (originalPostRes.rows.length > 0) {
                    const original = originalPostRes.rows[0];
                    if (original.visibility === 'private' || original.category_name === 'Personal') {
                        await client.query('ROLLBACK');
                        return res.status(403).json({
                            message: "You cannot make this repost public because the original post is private or restricted."
                        });
                    }
                }
            }

            updates.push(`visibility = $${index++}`);
            values.push(visibility);
        }

        // category
        let categoryId;
        if (category !== undefined) {
            const catRes = await client.query(
                `SELECT category_id FROM post_categories WHERE name = $1`,
                [category]
            );
            categoryId = catRes.rows[0]?.category_id;
            if (catRes.rows.length > 0) {
                updates.push(`category_id = $${index++}`);
                values.push(catRes.rows[0].category_id);
            }
        }

        if (updates.length === 0 && !media_urls) {
            return res.status(400).json({ message: "No fields provided to update" });
        }

        // 3. Update main post content
        if (updates.length > 0) {
            // Add the ID and UserID to the values array
            values.push(postId);
            const postIndex = values.length; // The index of postId
            values.push(userId);
            const userIndex = values.length; // The index of userId

            const updateQuery = `
        UPDATE posts
        SET ${updates.join(", ")}, updated_at = NOW()
        WHERE post_id = $${postIndex} AND author_id = $${userIndex}
    `;
            const postUpdate = await client.query(updateQuery, values);

            if (postUpdate.rowCount === 0) {
                await client.query("ROLLBACK");
                return res.status(404).json({ message: "Post not found or unauthorized" });
            }
        }


        let type;
        // 4. Update Media: The "Sync" approach
        if (Array.isArray(media_urls)) {
            await client.query(`DELETE FROM post_media WHERE post_id = $1`, [postId]);

            for (const url of media_urls) {
                const type = url.match(/\.(mp4|webm|mov)$/i) ? "video" : "image";
                await client.query(
                    `INSERT INTO post_media (post_id, url, media_type)
       VALUES ($1, $2, $3)`,
                    [postId, url, type]
                );
            }
        }


        await client.query('COMMIT');


        const query = `
SELECT 
    p.*, 
    c.name AS category_name,
    -- Media Subquery
    COALESCE(
        (SELECT json_agg(json_build_object(
            'media_id', pm.media_id,
            'url', pm.url,
            'media_type', pm.media_type
        )) FROM post_media pm WHERE pm.post_id = p.post_id),
        '[]'::json
    ) AS media,
    -- Corrected Poll Subquery
    (SELECT json_build_object(
        'poll_id', pp.poll_id,
        'duration', COALESCE(pp.duration, '1 day'),
        'options', COALESCE(
            (SELECT json_agg(opt) FROM (
                SELECT 
                    po.option_id, 
                    po.option_text, 
                    COUNT(pv.vote_id) as vote_count
                FROM poll_options po
                LEFT JOIN poll_votes pv ON po.option_id = pv.option_id
                WHERE po.poll_id = pp.poll_id
                GROUP BY po.option_id
            ) opt),
            '[]'::json
        )
    ) FROM post_polls pp WHERE pp.post_id = p.post_id) AS poll
FROM posts p
LEFT JOIN post_categories c ON p.category_id = c.category_id
WHERE p.post_id = $1;
`;

        const result = await pool.query(query, [postId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ message: "Post not found" });
        }

        res.status(200).json(result.rows[0]);

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Update post error:", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

exports.deletePost = async (req, res) => {
    const postId = req.params.id;
    const userId = req.user.sub;

    if (!postId || !userId) {
        return res.status(400).json({ message: "postId and userId are required" });
    }
    try {
        const post = await pool.query(
            `delete from posts where post_id = $1 and author_id = $2 RETURNING post_id`,
            [postId, userId]
        );
        if (post.rowCount === 0) {
            return res.status(404).json({ message: "Post not found", postId, userId });
        }

        res.status(200).json({ message: "Post deleted", deletedPostId: postId });
    } catch (err) {
        console.error("Delete post error:", err)
        res.status(500).json({ message: "Internal server error" })
    }

}

// --- POLL INTERACTION ---
exports.voteInPoll = async (req, res) => {
    const voterId = req.user.sub;
    const { id: postId } = req.params;
    const { option_id } = req.body;

    try {
        // 1. Check if poll exists and if it's still active using DB logic


        const pollRes = await pool.query(
            `SELECT pp.poll_id, 
             (pp.created_at + COALESCE(pp.duration, '1 day')::interval > NOW()) as is_active 
             FROM post_polls pp 
             WHERE pp.post_id = $1`,
            [postId]
        );

        if (pollRes.rowCount === 0) return res.status(404).json({ message: "Poll not found" });

        const { poll_id, is_active } = pollRes.rows[0];

        // 2. Prevent voting if poll has expired
        if (!is_active) {
            return res.status(403).json({ message: "This poll has ended and no longer accepts votes." });
        }

        await pool.query(
            `INSERT INTO poll_votes (voter_id, poll_id, option_id) 
             VALUES ($1, $2, $3) 
             ON CONFLICT (voter_id, poll_id) 
             DO UPDATE SET option_id = $3`,
            [voterId, poll_id, option_id]
        );

        res.status(200).json({ message: "Vote recorded successfully" });

    } catch (err) {
        console.error("Vote error:", err);
        return res.status(500).json({ message: "Internal server error" });
    }
}

exports.removeVote = async (req, res) => {
    const voterId = req.user.sub;
    const { id: postId } = req.params;

    try {
        const pollRes = await pool.query(
            `SELECT poll_id, (created_at + COALESCE(duration, '1 day')::interval > NOW()) as is_active 
             FROM post_polls WHERE post_id = $1`,
            [postId]
        );

        if (pollRes.rowCount === 0) return res.status(404).json({ message: "Poll not found" });
        const { poll_id, is_active } = pollRes.rows[0];

        if (!is_active) {
            return res.status(403).json({ message: "Cannot change votes on an ended poll" });
        }

        await pool.query(
            `DELETE FROM poll_votes WHERE voter_id = $1 AND poll_id = $2`,
            [voterId, poll_id]
        );

        res.status(200).json({ message: "Vote removed successfully" });
    } catch (err) {
        console.error("Remove vote error:", err);
        return res.status(500).json({ message: "Internal server error" });
    }
};

// --- SOCIAL ENGAGEMENT ---
exports.toggleLike = async (req, res) => {
    const userId = req.user.sub;
    const postId = req.params.id;

    try {
        // 1️⃣ Check if already liked
        const alreadyLiked = await pool.query(
            "SELECT 1 FROM post_likes WHERE post_id = $1 AND user_id = $2",
            [postId, userId]
        );

        let liked;

        if (alreadyLiked.rowCount > 0) {
            // 2️⃣ Unlike
            await pool.query(
                "DELETE FROM post_likes WHERE post_id = $1 AND user_id = $2",
                [postId, userId]
            );
            liked = false;
        } else {
            // 3️⃣ Like
            await pool.query(
                "INSERT INTO post_likes (post_id, user_id) VALUES ($1, $2)",
                [postId, userId]
            );
            liked = true;

            // 🔔 Notify Author
            // Fetch post author
            const postRes = await pool.query("SELECT author_id FROM posts WHERE post_id = $1", [postId]);
            if (postRes.rowCount > 0) {
                const authorId = postRes.rows[0].author_id;
                if (authorId !== userId) {
                    const userRes = await pool.query("SELECT full_name, avatar_url FROM users WHERE user_id = $1", [userId]);
                    const liker = userRes.rows[0];

                    // Emit real-time
                    socketService.notifyUser(authorId, "notification", {
                        type: "like",
                        senderName: liker.full_name,
                        senderAvatar: liker.avatar_url,
                        postId
                    });

                    // Persist notification
                    await pool.query(
                        `INSERT INTO notifications (user_id, sender_id, type, text, reference_id) 
                         VALUES ($1, $2, $3, $4, $5)`,
                        [authorId, userId, "like", `${liker.full_name} liked your post`, postId]
                    );
                }
            }
        }

        // 4️⃣ Get UPDATED count
        const countResult = await pool.query(
            "SELECT COUNT(*) FROM post_likes WHERE post_id = $1",
            [postId]
        );

        const likeCount = Number(countResult.rows[0].count);

        return res.status(200).json({
            postId,
            liked,
            likeCount
        });

    } catch (err) {
        console.error("Toggle like error:", err);
        return res.status(500).json({ message: "Internal server error" });
    }
};

exports.addComment = async (req, res) => {
    const userId = req.user.sub;
    const postId = req.params.id;
    const { content, parent_id } = req.body; // Added parent_id

    if (!postId || !userId || !content || !content.trim()) {
        console.error('[addComment] Missing required fields', { postId, userId, hasContent: !!content });
        return res.status(400).json({ message: "all fields are required" })
    }

    if (content.length > 1000) {
        console.error('[addComment] Comment too long', { length: content.length });
        return res.status(400).json({ message: "Comment too long (max 1000 characters)" })
    }

    try {
        const post = await pool.query(`select post_id, author_id from posts where post_id = $1`, [postId])

        if (post.rowCount === 0) {
            return res.status(404).json({ message: "Post not found" })
        }

        const postAuthorId = post.rows[0].author_id;

        // Block Check: Post Author
        const isBlockedByPostAuthor = await checkBlockStatus(postAuthorId, userId);
        const hasBlockedPostAuthor = await checkBlockStatus(userId, postAuthorId);

        if (isBlockedByPostAuthor || hasBlockedPostAuthor) {
            return res.status(403).json({ message: "You cannot comment on this post" });
        }

        let insertParentId = parent_id || null;

        // Validate parent_id if provided
        if (parent_id) {
            const parentComment = await pool.query(
                `SELECT comment_id, post_id, parent_id FROM post_comments WHERE comment_id = $1`,
                [parent_id]
            );

            if (parentComment.rowCount === 0) {
                return res.status(404).json({ message: "Parent comment not found" });
            }

            if (parentComment.rows[0].post_id.toString() !== postId.toString()) {
                return res.status(400).json({ message: "Parent comment belongs to different post" });
            }

            // Block Check: Parent Comment Author
            const parentAuthorRes = await pool.query(`SELECT author_id FROM post_comments WHERE comment_id = $1`, [parent_id]);
            if (parentAuthorRes.rowCount > 0) {
                const parentAuthorId = parentAuthorRes.rows[0].author_id;
                const isBlockedByParentHandler = await checkBlockStatus(parentAuthorId, userId);
                const hasBlockedParentHandler = await checkBlockStatus(userId, parentAuthorId);

                if (isBlockedByParentHandler || hasBlockedParentHandler) {
                    return res.status(403).json({ message: "You cannot reply to this comment" });
                }
            }

            // Always reply to the root comment of a thread (Instagram-style)
            insertParentId = parentComment.rows[0].parent_id || parent_id;
        }

        const result = await pool.query(
            `INSERT INTO post_comments (post_id, author_id, content, parent_id)
   VALUES ($1, $2, $3, $4)
   RETURNING comment_id, author_id, content, parent_id, created_at`,
            [postId, userId, content.trim(), insertParentId]
        );

        const newComment = result.rows[0];

        // --- NOTIFICATIONS & SOCKETS ---

        // const postAuthorId = post.rows[0].author_id; // Already declared above

        // Fetch current user details for notification text
        const actorRes = await pool.query(`SELECT full_name, avatar_url FROM users WHERE user_id = $1`, [userId]);
        const actor = actorRes.rows[0];

        // Regex for mentions: @Username (simple alphanumeric + underscore)
        // Adjust regex to match your frontend logic
        const mentionMatches = content.match(/@(\w+)/g);
        const mentionedUsernames = mentionMatches ? mentionMatches.map(m => m.substring(1)) : [];

        // Notify Post Owner
        if (postAuthorId !== userId) {
            const notificationText = `${actor.full_name} commented on your post`;
            await pool.query(
                `INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata) 
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [postAuthorId, userId, 'comment', notificationText, postId, JSON.stringify({ comment_id: newComment.comment_id })]
            );

            socketService.notifyUser(postAuthorId, "notification", {
                type: 'comment',
                text: notificationText,
                from: userId,
                senderName: actor.full_name,
                senderAvatar: actor.avatar_url,
                referenceId: postId,
                metadata: { comment_id: newComment.comment_id },
                time: "Just now"
            });
        }

        if (parent_id) {
            // Get parent comment author
            const parentAuthorRes = await pool.query(
                `SELECT author_id FROM post_comments WHERE comment_id = $1`,
                [parent_id]
            );

            if (parentAuthorRes.rowCount > 0) {
                const parentAuthorId = parentAuthorRes.rows[0].author_id;

                // Notify parent author (if not self and not post owner already notified)
                if (parentAuthorId !== userId && parentAuthorId !== postAuthorId) {
                    const replyText = `${actor.full_name} replied to your comment`;
                    await pool.query(
                        `INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata) 
                         VALUES ($1, $2, $3, $4, $5, $6)`,
                        [parentAuthorId, userId, 'reply', replyText, postId, JSON.stringify({ comment_id: newComment.comment_id, parent_id })]
                    );

                    socketService.notifyUser(parentAuthorId, "notification", {
                        type: 'reply',
                        text: replyText,
                        from: userId,
                        senderName: actor.full_name,
                        senderAvatar: actor.avatar_url,
                        referenceId: postId,
                        metadata: { comment_id: newComment.comment_id, parent_id },
                        time: "Just now"
                    });
                }
            }
        }

        if (mentionedUsernames.length > 0) {
            for (const handle of mentionedUsernames) {
                const userRes = await pool.query(`SELECT user_id FROM users WHERE LOWER(account_name) = LOWER($1)`, [handle]);
                if (userRes.rowCount > 0) {
                    const mentionedUserId = userRes.rows[0].user_id;

                    // Don't notify if self or post owner
                    if (mentionedUserId !== userId && mentionedUserId !== postAuthorId) {
                        const isBlockedByMentioned = await checkBlockStatus(mentionedUserId, userId);
                        const hasBlockedMentioned = await checkBlockStatus(userId, mentionedUserId);

                        if (isBlockedByMentioned || hasBlockedMentioned) {
                            continue;
                        }

                        const notifText = `${actor.full_name} mentioned you in a comment`;
                        await pool.query(
                            `INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata) 
                             VALUES ($1, $2, $3, $4, $5, $6)`,
                            [mentionedUserId, userId, 'mention', notifText, postId, JSON.stringify({ comment_id: newComment.comment_id })]
                        );

                        socketService.notifyUser(mentionedUserId, "notification", {
                            type: 'mention',
                            text: notifText,
                            from: userId,
                            senderName: actor.full_name,
                            senderAvatar: actor.avatar_url,
                            referenceId: postId,
                            metadata: { comment_id: newComment.comment_id },
                            time: "Just now"
                        });
                    }
                }
            }
        }

        return res.status(200).json({
            message: "comment added",
            comment: newComment
        })

    } catch (err) {
        console.error("Add comment error:", err);
        return res.status(500).json({ message: "Internal server error" })
    }
}

exports.updateComment = async (req, res) => {
    const userId = req.user.sub;
    const commentId = req.params.commentId;
    const { content } = req.body;

    if (!commentId) {
        return res.status(400).json({ message: "commentId is required" });
    }

    if (!content || !content.trim()) {
        return res.status(400).json({ message: "Content is required" });
    }

    if (content.length > 1000) {
        return res.status(400).json({ message: "Comment too long (max 1000 characters)" })
    }

    try {
        const result = await pool.query(
            `
      UPDATE post_comments
      SET content = $1
      WHERE comment_id = $2 AND author_id = $3
      RETURNING comment_id, content, created_at
      `,
            [content.trim(), commentId, userId]
        );

        if (result.rowCount === 0) {
            // Either comment doesn't exist OR user is not the author
            // Double check existence to give better error
            const check = await pool.query(`select * from post_comments where comment_id = $1`, [commentId])
            if (check.rowCount === 0) {
                return res.status(404).json({ message: "Comment not found" });
            }
            return res.status(403).json({ message: "Not authorized to edit this comment" });
        }

        return res.status(200).json({
            message: "Comment updated",
            comment: result.rows[0]
        });

    } catch (err) {
        console.error("Update comment error:", err);
        return res.status(500).json({ message: "Internal server error" });
    }
};

exports.deleteComment = async (req, res) => {
    const userId = req.user.sub;
    const commentId = req.params.commentId;

    if (!userId || !commentId) {
        return res.status(400).json({ message: "userId and commentId are required" });
    }

    try {
        const commentCheck = await pool.query(`SELECT * FROM post_comments WHERE comment_id = $1`, [commentId]);
        if (commentCheck.rowCount === 0) {
            return res.status(404).json({ message: "Comment not found" });
        }
        const comment = commentCheck.rows[0];

        const postCheck = await pool.query(`SELECT author_id FROM posts WHERE post_id = $1`, [comment.post_id]);
        let postOwnerId = postCheck.rowCount > 0 ? postCheck.rows[0].author_id : null;

        const canDelete = (String(comment.author_id) === String(userId)) || (String(postOwnerId) === String(userId));

        if (!canDelete) {
            return res.status(403).json({ message: "Not authorized to delete this comment" });
        }

        await pool.query(`DELETE FROM post_comments WHERE comment_id = $1`, [commentId]);

        res.status(200).json({ message: "Comment deleted", deletedCommentId: commentId });
    } catch (err) {
        console.error("Delete comment error:", err);
        return res.status(500).json({ message: "Internal server error" });
    }
};

exports.toggleCommentLike = async (req, res) => {
    const userId = req.user.sub;
    const { commentId } = req.params;

    if (!commentId || !userId) {
        return res.status(400).json({ message: "Comment ID and user ID are required" });
    }

    try {
        // Check if comment exists
        const commentCheck = await pool.query(
            `SELECT comment_id FROM post_comments WHERE comment_id = $1`,
            [commentId]
        );

        if (commentCheck.rowCount === 0) {
            return res.status(404).json({ message: "Comment not found" });
        }

        // Check if user already liked this comment
        const existingLike = await pool.query(
            `SELECT * FROM comment_likes WHERE user_id = $1 AND comment_id = $2`,
            [userId, commentId]
        );

        let liked;
        if (existingLike.rowCount > 0) {
            // Unlike: Remove the like
            await pool.query(
                `DELETE FROM comment_likes WHERE user_id = $1 AND comment_id = $2`,
                [userId, commentId]
            );
            liked = false;
        } else {
            // Like: Add the like
            await pool.query(
                `INSERT INTO comment_likes (user_id, comment_id) VALUES ($1, $2)`,
                [userId, commentId]
            );
            liked = true;
        }

        // Get updated like count
        const likeCountResult = await pool.query(
            `SELECT COUNT(*)::int as like_count FROM comment_likes WHERE comment_id = $1`,
            [commentId]
        );

        const likeCount = likeCountResult.rows[0].like_count;

        res.status(200).json({
            liked,
            likeCount,
            message: liked ? "Comment liked" : "Comment unliked"
        });
    } catch (err) {
        console.error("Toggle comment like error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

// Toggle pin on a comment (post owner only)
exports.toggleCommentPin = async (req, res) => {
    const userId = req.user.sub;
    const { commentId } = req.params;

    if (!commentId || !userId) {
        return res.status(400).json({ message: "Comment ID and user ID are required" });
    }

    try {
        // Get comment and verify it exists
        const commentResult = await pool.query(
            `SELECT c.comment_id, c.post_id, c.is_pinned, p.author_id as post_author_id
             FROM post_comments c
             JOIN posts p ON c.post_id = p.post_id
             WHERE c.comment_id = $1`,
            [commentId]
        );

        if (commentResult.rowCount === 0) {
            return res.status(404).json({ message: "Comment not found" });
        }

        const comment = commentResult.rows[0];

        // Verify user is the post owner
        if (comment.post_author_id.toString() !== userId.toString()) {
            return res.status(403).json({ message: "Only post owner can pin comments" });
        }

        let pinned;
        if (comment.is_pinned) {
            // Unpin: Remove pin
            await pool.query(
                `UPDATE post_comments 
                 SET is_pinned = false, pinned_at = NULL, pinned_by = NULL
                 WHERE comment_id = $1`,
                [commentId]
            );
            pinned = false;
        } else {
            // Pin: Add pin
            await pool.query(
                `UPDATE post_comments 
                 SET is_pinned = true, pinned_at = NOW(), pinned_by = $1
                 WHERE comment_id = $2`,
                [userId, commentId]
            );
            pinned = true;
        }

        res.status(200).json({
            pinned,
            message: pinned ? "Comment pinned" : "Comment unpinned"
        });
    } catch (err) {
        console.error("Toggle comment pin error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.getComments = async (req, res) => {
    const postId = req.params.id;
    const userId = req.user ? req.user.sub : null; // Optional auth

    if (!postId) {
        return res.status(400).json({ message: "postId is required" })
    }
    try {
        const post = await pool.query(`select post_id from posts where post_id = $1`, [postId])
        if (post.rowCount === 0) {
            return res.status(404).json({ message: "Post not found" })
        }
        const comments = await pool.query(
            `
      SELECT 
        c.comment_id,
        c.content,
        c.parent_id,
        c.created_at,
        c.is_pinned,
        c.pinned_at,
        c.pinned_by,
        u.user_id AS author_id,
        u.full_name,
        u.account_name,
        u.avatar_url,
        u.headline,
        COALESCE(
          (SELECT COUNT(*)::int FROM comment_likes cl WHERE cl.comment_id = c.comment_id),
          0
        ) AS like_count,
        COALESCE(
          (SELECT EXISTS(SELECT 1 FROM comment_likes cl WHERE cl.comment_id = c.comment_id AND cl.user_id = $2)),
          false
        ) AS is_liked
      FROM post_comments c
      JOIN users u ON c.author_id = u.user_id
      WHERE c.post_id = $1
      AND NOT EXISTS (
        SELECT 1 FROM blocks b 
        WHERE (b.blocker_id = $2 AND b.blocked_id = c.author_id) 
           OR (b.blocker_id = c.author_id AND b.blocked_id = $2)
      )
      ORDER BY 
        c.is_pinned DESC NULLS LAST,
        c.pinned_at DESC NULLS LAST,
        c.created_at DESC
      `,
            [postId, userId]
        );
        return res.status(200).json(comments.rows);
    } catch (err) {
        console.error("Get comments error:", err);
        return res.status(500).json({ message: "Internal server error" })
    }
}

//--- STORIES INTEGRATION ---
exports.getStories = async (req, res) => {
    const userId = req.user.sub;
    try {
        const result = await pool.query(
            `
            SELECT 
                s.*, 
                u.full_name AS author_name, 
                u.avatar_url AS author_avatar,
                -- 1. Check if the current user has viewed this story
                EXISTS (
                    SELECT 1 FROM story_views sv 
                    WHERE sv.story_id = s.story_id AND sv.viewer_id = $1
                ) AS has_viewed,
                -- 2. Check if the current user has liked this story
                EXISTS (
                    SELECT 1 FROM story_reactions sr 
                    WHERE sr.story_id = s.story_id AND sr.user_id = $1 AND sr.reaction_type = 'true'
                ) AS has_liked,
                -- 3. Identity flag for UI changes
                (s.author_id = $1) AS is_author,
                -- 4. Counts
                (SELECT COUNT(*) FROM story_views sv WHERE sv.story_id = s.story_id)::int AS view_count,
                (SELECT COUNT(*) FROM story_reactions sr WHERE sr.story_id = s.story_id AND sr.reaction_type = 'true')::int AS like_count
            FROM stories s
            JOIN users u ON s.author_id = u.user_id
            WHERE s.expires_at > now()
            ORDER BY s.created_at DESC
            `,
            [userId]
        );

        res.json(result.rows);
    } catch (err) {
        console.error("Get stories error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.getGroupedStories = async (req, res) => {
    const userId = req.user.sub;
    try {
        // 1. Fetch current user details (for empty state)
        const userRes = await pool.query(
            `SELECT user_id, full_name, avatar_url FROM users WHERE user_id = $1`,
            [userId]
        );
        const currentUser = userRes.rows[0];

        // 2. Fetch all active stories with author details
        const result = await pool.query(
            `
            SELECT 
                s.*, 
                u.full_name AS author_name, 
                u.avatar_url AS author_avatar,
                -- Shared Post Data
                -- Shared Post Data
                CASE 
                    WHEN s.shared_post_id IS NULL THEN NULL
                    WHEN (
                        -- 1. Private: Author only
                        (sp.visibility = 'private' AND sp.author_id = $1)
                        OR
                        -- 2. Public + Personal: Connections only
                        (sp.visibility = 'public' AND sp_cat.name = 'Personal' AND (
                            sp.author_id = $1
                            OR EXISTS (
                                SELECT 1 FROM followers f1 
                                JOIN followers f2 ON f1.follower_id = f2.following_id AND f1.following_id = f2.follower_id 
                                WHERE f1.follower_id = $1 AND f1.following_id = sp.author_id
                            )
                        ))
                        OR
                        -- 3. Public + Other: Everyone
                        (sp.visibility = 'public' AND (sp_cat.name != 'Personal' OR sp_cat.name IS NULL))
                    ) THEN
                        json_build_object(
                            'is_accessible', true,
                            'post_id', sp.post_id,
                            'content', sp.content,
                            'author', json_build_object(
                                'user_id', sp_u.user_id,
                                'full_name', sp_u.full_name,
                                'avatar_url', sp_u.avatar_url
                            ),
                            'media', (SELECT json_agg(json_build_object('url', url, 'media_type', media_type)) FROM post_media WHERE post_id = sp.post_id)
                        )
                    -- Failure Analysis
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
                END AS shared_post,
                s.story_metadata,

                -- Check if viewed/liked
                EXISTS (
                    SELECT 1 FROM story_views sv 
                    WHERE sv.story_id = s.story_id AND sv.viewer_id = $1
                ) AS has_viewed,
                EXISTS (
                    SELECT 1 FROM story_reactions sr 
                    WHERE sr.story_id = s.story_id AND sr.user_id = $1 AND sr.reaction_type = 'true'
                ) AS has_liked,
                (s.author_id = $1) AS is_author,
                -- Aggregate counts
                (SELECT COUNT(*) FROM story_views sv WHERE sv.story_id = s.story_id)::int AS view_count,
                (SELECT COUNT(*) FROM story_reactions sr WHERE sr.story_id = s.story_id AND sr.reaction_type = 'true')::int AS like_count
            FROM stories s
            JOIN users u ON s.author_id = u.user_id
            LEFT JOIN posts sp ON s.shared_post_id = sp.post_id
            LEFT JOIN users sp_u ON sp.author_id = sp_u.user_id
            LEFT JOIN post_categories sp_cat ON sp.category_id = sp_cat.category_id
            WHERE s.expires_at > now()
            AND NOT EXISTS (
                SELECT 1 FROM blocks b 
                WHERE (b.blocker_id = $1 AND b.blocked_id = s.author_id)
                   OR (b.blocker_id = s.author_id AND b.blocked_id = $1)
            )
            ORDER BY s.created_at ASC
            `,
            [userId]
        );

        const stories = result.rows;
        const groupsMap = new Map();

        // Initialize Current User Group always
        if (currentUser) {
            groupsMap.set(currentUser.user_id, {
                author: {
                    id: currentUser.user_id,
                    name: "You", // UI expects "You" or we can infer it
                    avatar: currentUser.avatar_url
                },
                is_current_user: true,
                latest_story_at: null, // Will update if stories exist
                stories: []
            });
        }

        // Group stories
        for (const story of stories) {
            const authorId = story.author_id;

            if (!groupsMap.has(authorId)) {
                groupsMap.set(authorId, {
                    author: {
                        id: authorId,
                        name: story.author_name,
                        avatar: story.author_avatar
                    },
                    is_current_user: authorId === userId,
                    latest_story_at: story.created_at,
                    stories: []
                });
            }

            const group = groupsMap.get(authorId);
            // Update latest_story_at if this story is newer
            // (Since we iterate, we can just keep checking or sort later. 
            // Query was ordered by created_at ASC, so last one is latest)
            group.latest_story_at = story.created_at;

            // Map story to simpler structure if needed, or keep raw
            group.stories.push({
                story_id: story.story_id,
                title: story.title,
                description: story.description,
                media_url: story.media_url,
                media_type: story.media_type,
                created_at: story.created_at,
                expires_at: story.expires_at,
                is_author: story.is_author,
                has_viewed: story.has_viewed,
                has_liked: story.has_liked,
                // Add counts if needed, query didn't fetch them in simple select but can add
                view_count: story.view_count || 0,
                like_count: story.like_count || 0,
                shared_post: story.shared_post,
                story_metadata: story.story_metadata
            });
        }

        // Convert to array
        const groups = Array.from(groupsMap.values());

        // Sort Groups
        groups.sort((a, b) => {
            // 1. Current user always first
            if (a.is_current_user) return -1;
            if (b.is_current_user) return 1;

            // 2. Latest story DESC
            if (a.latest_story_at && b.latest_story_at) {
                return new Date(b.latest_story_at) - new Date(a.latest_story_at);
            }
            return 0;
        });

        // Ensure current user name is correct if they have stories
        if (groups.length > 0 && groups[0].is_current_user) {
            groups[0].author.name = "You";
        }

        res.json(groups);

    } catch (err) {
        console.error("Get grouped stories error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.createStory = async (req, res) => {
    const userId = req.user.sub;
    const { title, media_url, description, media_type, public_id, media_status, shared_post_id, story_metadata } = req.body;

    try {
        let type = media_type || (media_url && media_url.toLowerCase().match(/\.(mp4|webm|mov)$/) ? 'video' : 'image');

        // Default status: 'ready' for images, 'processing' for videos unless specified
        let status = media_status || (type === 'video' ? 'processing' : 'ready');

        // If it's an image, it's always ready immediately
        if (type === 'image') status = 'ready';

        const result = await pool.query(
            `
            INSERT INTO stories (author_id, title, description, media_url, media_type, expires_at, media_status, cld_public_id, shared_post_id, story_metadata)
            VALUES ($1, $2, $3, $4, $5, now() + interval '24 hours', $6, $7, $8, $9)
            RETURNING story_id, created_at
            `,
            [userId, title, description, media_url, type, status, public_id, shared_post_id || null, story_metadata || {}]
        );

        const { story_id, created_at } = result.rows[0];

        res.status(201).json({
            message: "Story created",
            story_id: story_id,
            userId: userId,
            title: title,
            description: description,
            media_url: media_url,
            media_type: type,
            media_status: status,
            created_at: created_at,
            story_metadata: story_metadata || {}
        });
    } catch (err) {
        console.error("Create story error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.deleteStory = async (req, res) => {
    const storyId = req.params.id;
    const userId = req.user.sub;

    if (!storyId) {
        return res.status(400).json({ message: "storyId is required" });
    }

    try {
        const result = await pool.query(
            `DELETE FROM stories WHERE story_id = $1 AND author_id = $2 RETURNING story_id`,
            [storyId, userId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ message: "Story not found or unauthorized", storyId, userId });
        }

        res.status(200).json({ message: "Story deleted", deletedStoryId: storyId });
    } catch (err) {
        console.error("Delete story error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.viewStory = async (req, res) => {
    const story_id = req.params.id;
    const viewer_id = req.user.sub;

    try {
        const storyRes = await pool.query(
            `SELECT author_id FROM stories WHERE story_id = $1`, [story_id]
        );

        if (storyRes.rowCount === 0) {
            return res.status(404).json({ message: "Story not found" });
        }

        const author_id = storyRes.rows[0].author_id;

        // Only insert if the viewer is NOT the author
        if (viewer_id !== author_id) {
            await pool.query(
                `INSERT INTO story_views (story_id, viewer_id) 
                 VALUES ($1, $2)
                 ON CONFLICT (story_id, viewer_id) DO NOTHING`,
                [story_id, viewer_id]
            );
        }

        res.status(200).json({
            message: viewer_id === author_id ? "Author viewing (not counted)" : "View recorded",
            story_id: story_id
        });

    } catch (err) {
        console.error("View story error:", err);
        // We still send a 500 if the DB is actually down
        res.status(500).json({ message: "Internal server error" });
    }
};



exports.reactToStory = async (req, res) => {
    const userId = req.user.sub;
    const story_id = req.params.id;
    const { reaction } = req.body;

    try {
        const storyRes = await pool.query(`SELECT author_id, media_url FROM stories WHERE story_id = $1`, [story_id]);
        if (storyRes.rowCount === 0) return res.status(404).json({ message: "Story not found" });

        const { author_id, media_url } = storyRes.rows[0];
        let liked;
        if (author_id !== userId) {

            const alreadyLiked = await pool.query(`select * from story_reactions 
                where story_id = $1 and user_id = $2`, [story_id, userId])


            if (alreadyLiked.rowCount > 0) {
                // 2️⃣ Unlike
                await pool.query(
                    "DELETE FROM story_reactions WHERE story_id = $1 AND user_id = $2",
                    [story_id, userId]
                );
                liked = false;
            } else {
                // 3️⃣ Like
                await pool.query(
                    `INSERT INTO story_reactions (story_id, user_id, reaction_type)
             VALUES ($1, $2, $3)
             ON CONFLICT (story_id, user_id) DO UPDATE SET reaction_type = $3`,
                    [story_id, userId, reaction.toString()]
                );

                await pool.query(
                    `INSERT INTO story_views (story_id, viewer_id)
             VALUES ($1, $2) ON CONFLICT (story_id, viewer_id) DO NOTHING`,
                    [story_id, userId]
                );
                liked = true;

                // 🔔 Notify Author (if not self)
                const actorRes = await pool.query(`SELECT full_name, avatar_url FROM users WHERE user_id = $1`, [userId]);
                const actor = actorRes.rows[0];

                const notificationData = {
                    type: "story_like",
                    text: `${actor.full_name} liked your story`,
                    from: userId,
                    senderName: actor.full_name,
                    senderAvatar: actor.avatar_url,
                    referenceId: story_id,
                    mediaUrl: media_url,
                    time: "Just now"
                };

                // Notify via socket
                socketService.notifyUser(author_id, "notification", notificationData);

                // Persist to DB
                await pool.query(
                    `INSERT INTO notifications (user_id, sender_id, type, text, reference_id) 
                     VALUES ($1, $2, $3, $4, $5)`,
                    [author_id, userId, "story_like", notificationData.text, story_id]
                );
            }
        }

        return res.status(200).json({
            message: userId === author_id ? "Author not reacting" : "reaction recorded",
            liked: liked ? "Story liked" : "story disliked",
            is_liked: liked,
            story_id
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.getStoryDetailsById = async (req, res) => {
    const userId = req.user.sub;
    const storyId = req.params.id;

    if (!storyId || !userId) {
        return res.status(400).json({ message: "storyId and userId are required" });
    }

    try {
        const permission = await pool.query(
            `SELECT author_id FROM stories WHERE story_id = $1`,
            [storyId]
        );

        if (permission.rowCount === 0) {
            return res.status(404).json({ message: "Story not found" });
        }


        if (permission.rows[0].author_id !== userId) {
            return res.status(403).json({ message: "You don't have permission to view these details" });
        }

        const result = await pool.query(`
            SELECT 
                u.user_id,
                u.full_name, 
                u.avatar_url, 
                sr.reaction_type, 
                sv.viewed_at
            FROM story_views sv 
            JOIN users u ON sv.viewer_id = u.user_id
            -- Left Join ensures we still get the viewer even if there is no reaction
            LEFT JOIN story_reactions sr ON sv.story_id = sr.story_id AND sv.viewer_id = sr.user_id
            WHERE sv.story_id = $1
            AND NOT EXISTS (
                SELECT 1 FROM blocks b 
                WHERE (b.blocker_id = $2 AND b.blocked_id = u.user_id) -- Viewer is blocked by me (story author)
                   OR (b.blocker_id = u.user_id AND b.blocked_id = $2) -- Viewer blocked me
            )
            ORDER BY sv.viewed_at DESC
        `, [storyId, userId]);


        if (result.rowCount === 0) {
            return res.status(200).json({
                viewerCount: 0,
                viewers: [],
                message: "No one has viewed this story yet"
            });
        }


        return res.status(200).json({
            viewerCount: result.rowCount,
            viewers: result.rows
        });

    } catch (err) {
        console.error(err);
        return res.status(500).json({ message: "Internal server error" });
    }
};

exports.getPollAnalytics = async (req, res) => {
    const userId = req.user.sub;
    const { id: postId } = req.params;

    try {
        // 1. Verify ownership
        const postRes = await pool.query(
            `SELECT author_id FROM posts WHERE post_id = $1`,
            [postId]
        );

        if (postRes.rowCount === 0) return res.status(404).json({ message: "Post not found" });
        if (postRes.rows[0].author_id !== userId) {
            return res.status(403).json({ message: "Only the poll author can view analytics" });
        }

        // 2. Fetch Analytics
        const query = `
            SELECT 
                pp.poll_id,
                pp.duration,
                pp.created_at,
                (pp.created_at + COALESCE(pp.duration, '1 day')::interval > NOW()) as is_active,
                (SELECT COUNT(*) FROM poll_votes pv WHERE pv.poll_id = pp.poll_id) as total_votes,
                
                -- Options with counts only (NO voter details)
                (
                    SELECT json_agg(
                        json_build_object(
                            'option_id', po.option_id,
                            'option_text', po.option_text,
                            'vote_count', (SELECT COUNT(*) FROM poll_votes pv WHERE pv.option_id = po.option_id)
                        )
                    )
                    FROM poll_options po
                    WHERE po.poll_id = pp.poll_id
                ) as options,

                -- All voters in a single list (anonymized choice)
                (
                    SELECT COALESCE(json_agg(
                        json_build_object(
                            'user_id', u.user_id,
                            'full_name', u.full_name,
                            'avatar_url', u.avatar_url,
                            'headline', u.headline
                        )
                    ), '[]'::json)
                    FROM poll_votes pv
                    JOIN users u ON u.user_id = pv.voter_id
                    WHERE pv.poll_id = pp.poll_id
                ) as voters

            FROM post_polls pp
            WHERE pp.post_id = $1
        `;

        const result = await pool.query(query, [postId]);

        if (result.rowCount === 0) return res.status(404).json({ message: "Poll not found for this post" });

        res.status(200).json(result.rows[0]);

    } catch (err) {
        console.error("Get poll analytics error:", err);
        return res.status(500).json({ message: "Internal server error" });
    }
};

// --- STORY COMMENTS ---
exports.addStoryComment = async (req, res) => {
    const userId = req.user.sub;
    const storyId = req.params.id;
    const { content } = req.body;

    if (!storyId || !userId || !content || !content.trim()) {
        return res.status(400).json({ message: "all fields are required" })
    }

    try {
        const story = await pool.query(`select story_id, author_id, media_url from stories where story_id = $1`, [storyId])

        if (story.rowCount === 0) {
            return res.status(404).json({ message: "Story not found" })
        }

        const storyAuthorId = story.rows[0].author_id;
        const isBlockedByAuthor = await checkBlockStatus(storyAuthorId, userId);
        const hasBlockedAuthor = await checkBlockStatus(userId, storyAuthorId);

        if (isBlockedByAuthor || hasBlockedAuthor) {
            return res.status(403).json({ message: "You cannot reply to this story" });
        }

        const result = await pool.query(
            `INSERT INTO story_comments (story_id, author_id, content)
             VALUES ($1, $2, $3)
             RETURNING comment_id, author_id, content, created_at`,
            [storyId, userId, content.trim()]
        );

        const newComment = result.rows[0];

        // Notify Author (if not self)
        const authorId = story.rows[0].author_id;
        if (authorId !== userId) {
            const userRes = await pool.query(`SELECT full_name, avatar_url FROM users WHERE user_id = $1`, [userId]);
            const commenter = userRes.rows[0];

            socketService.notifyUser(authorId, "notification", {
                type: "story_comment",
                text: `${commenter.full_name} commented on your story`,
                from: userId,
                senderName: commenter.full_name,
                senderAvatar: commenter.avatar_url,
                referenceId: storyId,
                mediaUrl: story.rows[0].media_url,
                time: "Just now"
            });

            await pool.query(
                `INSERT INTO notifications (user_id, sender_id, type, text, reference_id) 
                  VALUES ($1, $2, $3, $4, $5)`,
                [authorId, userId, "story_comment", `${commenter.full_name} commented on your story`, storyId]
            );
        }

        return res.status(200).json({
            message: "comment added",
            comment: newComment
        })

    } catch (err) {
        console.error("Add story comment error", err);
        return res.status(500).json({ message: "Internal server error" })
    }
}

exports.getStoryComments = async (req, res) => {
    const storyId = req.params.id;
    const userId = req.user ? req.user.sub : null;

    if (!storyId) {
        return res.status(400).json({ message: "storyId is required" })
    }
    try {
        const comments = await pool.query(
            `
            SELECT 
                c.comment_id,
                c.content,
                c.created_at,
                u.user_id AS author_id,
                u.full_name,
                u.avatar_url,
                u.headline
            FROM story_comments c
            JOIN users u ON c.author_id = u.user_id
            WHERE c.story_id = $1
            AND NOT EXISTS (
                SELECT 1 FROM blocks b 
                WHERE (b.blocker_id = $2 AND b.blocked_id = c.author_id) 
                   OR (b.blocker_id = c.author_id AND b.blocked_id = $2)
            )
            ORDER BY c.created_at asc
            `,
            [storyId, userId]
        );
        return res.status(200).json(comments.rows);
    } catch (err) {
        console.error("Get story comments error", err);
        return res.status(500).json({ message: "Internal server error" })
    }
}

exports.deleteStoryComment = async (req, res) => {
    const userId = req.user.sub;
    const commentId = req.params.comment_id;

    if (!userId || !commentId) {
        return res.status(400).json({ message: "userId and commentId are required" })
    }

    try {
        // Allow author of comment OR author of story to delete
        // For simplicity, let's start with author of comment
        const result = await pool.query(
            `DELETE FROM story_comments WHERE comment_id = $1 AND author_id = $2 RETURNING comment_id`,
            [commentId, userId]
        );

        if (result.rowCount === 0) {
            // Check if user is story owner? Maybe later.
            return res.status(404).json({ message: "Comment not found or unauthorized" });
        }
        res.status(200).json({ message: "Comment deleted", deletedCommentId: commentId });
    } catch (err) {
        return res.status(500).json({ message: "Internal server error" })
    }
}
