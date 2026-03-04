const { ur, vi } = require("zod/locales");
const pool = require("../../core/db/pool");
const socketService = require("../../core/infrastructure/socket.service");
const { checkBlockStatus } = require("../../core/utils/blockCheck");
const { logAudit } = require("../../core/infrastructure/audit.service");
const cloudinary = require("../../core/infrastructure/cloudinary.client");
const { checkCompanyPermission } = require("../../core/utils/rbac");
const { notifyCompanyFollowers } = require("../../services/notification.service");

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

            COALESCE(p.author_company_id, u.user_id) AS author_id,
            COALESCE(comp.name, u.full_name) AS author_name,
            COALESCE(comp.logo_url, u.avatar_url) AS author_avatar,
            COALESCE(comp.slug, u.account_name) AS author_slug,
            (p.author_company_id IS NOT NULL) AS is_company_post,

            pc.name AS category_name,

            COALESCE(
                (SELECT json_agg(json_build_object('url', pm.url, 'media_type', pm.media_type)) 
                 FROM post_media pm WHERE pm.post_id = p.post_id),
                '[]'::json
            ) AS media,

            (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.post_id)::int AS like_count,
            (SELECT COUNT(*) FROM post_comments pc WHERE pc.post_id = p.post_id)::int AS comment_count,

            (pl_me.post_id IS NOT NULL) AS is_liked,
            EXISTS(SELECT 1 FROM post_comments pc_me WHERE pc_me.post_id = p.post_id AND pc_me.author_id = $${userParamIdx}) AS is_commented,
            EXISTS(SELECT 1 FROM saved_post sp_me WHERE sp_me.post_id = p.post_id AND sp_me.user_id = $${userParamIdx}) AS is_saved,

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
                            'user_id', COALESCE(sp.author_company_id, sp_u.user_id),
                            'full_name', COALESCE(sp_comp.name, sp_u.full_name),
                            'avatar_url', COALESCE(sp_comp.logo_url, sp_u.avatar_url)
                        ),
                         'media', COALESCE((SELECT json_agg(json_build_object('url', pm.url, 'media_type', pm.media_type)) FROM post_media pm WHERE pm.post_id = sp.post_id), '[]'::json),
                         'like_count', (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = sp.post_id)::int,
                         'comment_count', (SELECT COUNT(*) FROM post_comments pc WHERE pc.post_id = sp.post_id)::int,
                         'is_liked', EXISTS(SELECT 1 FROM post_likes pl WHERE pl.post_id = sp.post_id AND pl.user_id = $${userParamIdx}),
                         'is_commented', EXISTS(SELECT 1 FROM post_comments pc_c WHERE pc_c.post_id = sp.post_id AND pc_c.author_id = $${userParamIdx}),
                         'is_saved', EXISTS(SELECT 1 FROM saved_post sp_s WHERE sp_s.post_id = sp.post_id AND sp_s.user_id = $${userParamIdx}),
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
        LEFT JOIN companies comp ON comp.company_id = p.author_company_id
        LEFT JOIN post_categories pc ON pc.category_id = p.category_id

        -- Shared Post Joins
        LEFT JOIN posts sp ON p.shared_post_id = sp.post_id
        LEFT JOIN users sp_u ON sp.author_id = sp_u.user_id
        LEFT JOIN companies sp_comp ON sp_comp.company_id = sp.author_company_id
        LEFT JOIN post_categories sp_cat ON sp.category_id = sp_cat.category_id

        -- Like Check Join
        LEFT JOIN post_likes pl_me ON pl_me.post_id = p.post_id AND pl_me.user_id = $${userParamIdx}

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
        let whereClause = `WHERE p.author_id = $1 AND p.author_company_id IS NULL`;

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

            COALESCE(p.author_company_id, u.user_id) AS author_id,
            COALESCE(comp.name, u.full_name) AS author_name,
            COALESCE(comp.logo_url, u.avatar_url) AS author_avatar,
            COALESCE(comp.slug, u.account_name) AS author_slug,
            (p.author_company_id IS NOT NULL) AS is_company_post,

                        pc.name AS category_name,

                            COALESCE(pm.media, '[]':: json) AS media,
                                COALESCE(lc.like_count, 0) AS like_count,
                                    EXISTS(SELECT 1 FROM post_likes pl WHERE pl.post_id = p.post_id AND pl.user_id = $1) AS is_liked,
                                    EXISTS(SELECT 1 FROM post_comments pc_me WHERE pc_me.post_id = p.post_id AND pc_me.author_id = $1) AS is_commented,
                                    EXISTS(SELECT 1 FROM saved_post sp_me WHERE sp_me.post_id = p.post_id AND sp_me.user_id = $1) AS is_saved,
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
                                                             'user_id', COALESCE(sp.author_company_id, sp_u.user_id),
                                                             'full_name', COALESCE(sp_comp.name, sp_u.full_name),
                                                             'avatar_url', COALESCE(sp_comp.logo_url, sp_u.avatar_url),
                                                             'author_slug', COALESCE(sp_comp.slug, sp_u.account_name),
                                                             'is_company_post', (sp.author_company_id IS NOT NULL)
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
       LEFT JOIN companies comp ON comp.company_id = p.author_company_id
       LEFT JOIN post_categories pc ON pc.category_id = p.category_id
 
         --Shared Post Joins
       LEFT JOIN posts sp ON p.shared_post_id = sp.post_id
       LEFT JOIN users sp_u ON sp.author_id = sp_u.user_id
       LEFT JOIN companies sp_comp ON sp_comp.company_id = sp.author_company_id
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
    let { content, category, visibility, media_urls, post_type, title, poll_options, poll_duration, companyId } = req.body; // category is name, media_urls is array

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // Company Authorization Check
        if (companyId) {
            const memberCheck = await client.query(
                `SELECT 1 FROM company_members WHERE company_id = $1 AND user_id = $2`,
                [companyId, userId]
            );
            if (memberCheck.rowCount === 0) {
                await client.query('ROLLBACK');
                return res.status(403).json({ message: "Not authorized to act as this company" });
            }
        }

        // 0. If reposting, check if original is Personal or already reposted
        if (req.body.shared_post_id) {
            // Check if Personal
            const originalPostCheck = await client.query(
                `SELECT pc.name FROM posts p 
                 LEFT JOIN post_categories pc ON p.category_id = pc.category_id 
                 WHERE p.post_id = $1`,
                [req.body.shared_post_id]
            );
            if (originalPostCheck.rowCount > 0 && originalPostCheck.rows[0].name === 'Personal') {
                await client.query('ROLLBACK');
                return res.status(403).json({ message: "Personal posts cannot be reposted." });
            }

            // Check for Duplicate
            const duplicateCheck = await client.query(
                `SELECT post_id FROM posts WHERE author_id = $1 AND shared_post_id = $2`,
                [userId, req.body.shared_post_id]
            );
            if (duplicateCheck.rowCount > 0) {
                await client.query('ROLLBACK');
                return res.status(409).json({ message: "You have already shared this post." });
            }
        }


        // Infer post_type if not provided
        if (!post_type) {
            if (poll_options && poll_options.length > 0) {
                post_type = 'poll';
            } else if (media_urls && Array.isArray(media_urls) && media_urls.length > 0) {
                const firstUrl = media_urls[0];
                post_type = firstUrl.toLowerCase().match(/\.(mp4|webm|mov)$/) ? 'video' : 'image';
            } else {
                post_type = 'article';
            }
        }

        // 1. Get Category ID
        let categoryId = null;
        if (!category) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: "Category is required" });
        } else {
            const catRes = await client.query(`SELECT category_id FROM post_categories WHERE name = $1`, [category]);
            if (catRes.rowCount > 0) {
                categoryId = catRes.rows[0].category_id;
            } else {
                await client.query('ROLLBACK');
                return res.status(400).json({ message: "Invalid category" });
            }

            // --- CONTEXT-AWARE CATEGORY VALIDATION ---
            const userAllowed = ['Personal', 'Professional', 'Achievement'];
            const companyAllowed = ['Update', 'Hiring', 'Milestone', 'Insight', 'Professional', 'Article']; // Added Article if needed, else stick to requirements

            if (companyId) {
                // Company Post
                if (!['Update', 'Hiring', 'Milestone', 'Insight'].includes(category)) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ message: `Invalid category for Company posts. Allowed: Update, Hiring, Milestone, Insight` });
                }
            } else {
                // User Post
                if (!['Personal', 'Professional', 'Achievement'].includes(category)) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ message: `Invalid category for User posts. Allowed: Personal, Professional, Achievement` });
                }
            }
        }


        // 2. Insert Post
        const postResult = await client.query(
            ` INSERT INTO posts (author_id, category_id, content, visibility,post_type,title, shared_post_id, author_company_id)
      VALUES ($1, $2, $3, $4,$5,$6, $7, $8)
      RETURNING post_id, created_at
      `, [userId, categoryId, content, visibility || 'public', post_type, title, req.body.shared_post_id || null, companyId || null]
        );

        const postId = postResult.rows[0].post_id;
        let pollId;
        if (post_type === 'poll' && poll_options) {
            const pollRes = await client.query(
                `INSERT INTO post_polls (post_id, duration) VALUES ($1, $2) RETURNING poll_id`,
                [postId, poll_duration || '1 days'] // e.g., '1 day', '1 week'
            );

            pollId = pollRes.rows[0].poll_id;

            // Insert each option and collect them
            const insertedOptions = [];
            for (const opt of poll_options) {
                const optRes = await client.query(
                    `INSERT INTO poll_options (poll_id, option_text) VALUES ($1, $2) RETURNING option_id, option_text`,
                    [pollId, opt]
                );
                insertedOptions.push(optRes.rows[0]);
            }
            poll_options = insertedOptions; // Replace string array with object array
        }

        let type;
        // 3. Insert Media (Parallel Optimized)
        if (media_urls && Array.isArray(media_urls) && media_urls.length > 0) {
            const mediaPromises = media_urls.map(url => {
                let currentType = url.toLowerCase().match(/\.(mp4|webm|mov)$/) ? 'video' : 'image';
                type = currentType; // Keep a reference to one type for response (legacy behavior)
                return client.query(
                    `INSERT INTO post_media (post_id, url, media_type) VALUES ($1, $2, $3)`,
                    [postId, url, currentType]
                );
            });
            await Promise.all(mediaPromises);
        }

        // 4. Handle Repost Notification
        if (req.body.shared_post_id) {
            const originalPostRes = await client.query(`SELECT author_id, author_company_id FROM posts WHERE post_id = $1`, [req.body.shared_post_id]);
            if (originalPostRes.rowCount > 0) {
                const originalAuthorId = originalPostRes.rows[0].author_id;
                const originalCompanyId = originalPostRes.rows[0].author_company_id;

                // Determine Reposter Identity
                let reposterName, reposterAvatar;
                if (companyId) {
                    const companyRes = await client.query(`SELECT name, logo_url FROM companies WHERE company_id = $1`, [companyId]);
                    reposterName = companyRes.rows[0].name;
                    reposterAvatar = companyRes.rows[0].logo_url;
                } else {
                    const reposterRes = await client.query(`SELECT full_name, avatar_url FROM users WHERE user_id = $1`, [userId]);
                    reposterName = reposterRes.rows[0].full_name;
                    reposterAvatar = reposterRes.rows[0].avatar_url;
                }

                // Don't notify if reposting own post (User-User, Company-Company)
                let isSelfRepost = false;
                if (!companyId && !originalCompanyId && userId === originalAuthorId) isSelfRepost = true;
                if (companyId && originalCompanyId && companyId === originalCompanyId) isSelfRepost = true;

                if (!isSelfRepost) {
                    const notificationText = `${reposterName} reposted your post`;

                    const meta = {
                        company_id: companyId, // Sender company
                        post_id: postId
                    };

                    // Insert notification
                    await client.query(
                        `INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata, recipient_company_id) 
                          VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                        [originalAuthorId, userId, "repost", notificationText, postId, JSON.stringify(meta), originalCompanyId]
                    );

                    // Emit socket event
                    socketService.notifyUser(originalAuthorId, "notification", {
                        type: "repost",
                        text: notificationText,
                        from: userId,
                        senderName: reposterName,
                        senderAvatar: reposterAvatar,
                        referenceId: postId,
                        metadata: meta,
                        time: "Just now",
                        recipient_company_id: originalCompanyId
                    });
                }
            }
        }

        if (companyId) {
            // PERMISSION CHECK START
            const canCreate = await checkCompanyPermission(client, companyId, userId, ['CREATE_CONTENT', 'MANAGE_COMPANY']);
            if (!canCreate) {
                await client.query('ROLLBACK');
                return res.status(403).json({ message: "Unauthorized to create posts for this company" });
            }
            // PERMISSION CHECK END

            await logAudit(client, {
                entityId: companyId,
                actorId: userId,
                action: 'CREATE_POST',
                metadata: {
                    type: 'post',
                    id: postId,
                    title: title || content.substring(0, 20)
                }
            });
        }

        await client.query('COMMIT');

        // Notify followers with 'posts' preference enabled (fire-and-forget, after commit)
        if (companyId) {
            const companyNameRes = await pool.query(`SELECT name FROM companies WHERE company_id = $1`, [companyId]);
            const cName = companyNameRes.rows[0]?.name || 'A company';
            notifyCompanyFollowers(companyId, "posts", {
                type: "company_post",
                text: `${cName} published a new post`,
                referenceId: postId,
                metadata: { post_title: title || content?.substring(0, 50) },
            }).catch(err => console.error("Post notification error:", err));
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
        await client.query('ROLLBACK');
        console.error("Create post error:", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

exports.getPostById = async (req, res) => {
    const postId = req.params.id;
    const userId = req.user ? req.user.sub : null;

    try {
        const query = `SELECT 
    p.*, 
    COALESCE(comp.name, u.full_name) AS author_name,
    COALESCE(comp.logo_url, u.avatar_url) AS author_avatar,
    COALESCE(comp.slug, u.account_name) AS author_slug,
    (p.author_company_id IS NOT NULL) AS is_company_post,
    c.name AS category_name,

    -- Like Count
    COALESCE(lc.like_count, 0)::int AS like_count,

    -- Comment Count
    (SELECT COUNT(*) FROM post_comments pc WHERE pc.post_id = p.post_id)::int AS comment_count,

    -- Is Liked (Fix for stale state)
    COALESCE(il.is_liked, false) AS is_liked,
    EXISTS(SELECT 1 FROM post_comments pc_me WHERE pc_me.post_id = p.post_id AND pc_me.author_id = $2) AS is_commented,
    EXISTS(SELECT 1 FROM saved_post sp_me WHERE sp_me.post_id = p.post_id AND sp_me.user_id = $2) AS is_saved,

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
                    'user_id', COALESCE(sp.author_company_id, sp_u.user_id),
                    'full_name', COALESCE(sp_comp.name, sp_u.full_name),
                    'avatar_url', COALESCE(sp_comp.logo_url, sp_u.avatar_url)
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
                'user_id', COALESCE(sp.author_company_id, sp_u.user_id),
                'full_name', COALESCE(sp_comp.name, sp_u.full_name),
                'avatar_url', COALESCE(sp_comp.logo_url, sp_u.avatar_url)
            )
        )
        WHEN (sp.visibility = 'public' AND sp_cat.name = 'Personal') THEN json_build_object(
            'is_accessible', false, 
            'reason', 'personal_connection',
            'author', json_build_object(
                'user_id', COALESCE(sp.author_company_id, sp_u.user_id),
                'full_name', COALESCE(sp_comp.name, sp_u.full_name),
                'avatar_url', COALESCE(sp_comp.logo_url, sp_u.avatar_url)
            )
        )
        ELSE 
            json_build_object('is_accessible', false, 'reason', 'unknown')
    END AS shared_post

FROM posts p
JOIN users u ON u.user_id = p.author_id
LEFT JOIN companies comp ON comp.company_id = p.author_company_id
LEFT JOIN post_categories c ON p.category_id = c.category_id

-- Shared Post Joins
LEFT JOIN posts sp ON p.shared_post_id = sp.post_id
LEFT JOIN users sp_u ON sp.author_id = sp_u.user_id
LEFT JOIN companies sp_comp ON sp_comp.company_id = sp.author_company_id
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

        // 2. Fetch Post & Check Permissions (CRITICAL FIX)
        const postCheck = await client.query(`SELECT author_id, author_company_id FROM posts WHERE post_id = $1`, [postId]);
        if (postCheck.rowCount === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ message: "Post not found" });
        }
        const { author_id, author_company_id } = postCheck.rows[0];
        let canEdit = false;

        if (author_id === userId && !author_company_id) {
            canEdit = true;
        } else if (author_company_id) {
            if (author_id === userId) {
                canEdit = true;
            } else {
                canEdit = await checkCompanyPermission(client, author_company_id, userId, ['MANAGE_COMPANY', 'CREATE_CONTENT']);
            }
        }

        if (!canEdit) {
            await client.query("ROLLBACK");
            return res.status(403).json({ message: "Unauthorized to edit this post" });
        }


        // 3. Resolve category ID
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
            await client.query('ROLLBACK'); // Ensure rollback if early exit
            return res.status(400).json({ message: "No fields provided to update" });
        }

        // 4. Update main post content
        if (updates.length > 0) {
            // Add the ID and UserID to the values array
            values.push(postId);
            const postIndex = values.length;

            const updateQuery = `
        UPDATE posts
        SET ${updates.join(", ")}, updated_at = NOW()
        WHERE post_id = $${postIndex}
    `;
            const postUpdate = await client.query(updateQuery, values);

            if (postUpdate.rowCount === 0) {
                await client.query("ROLLBACK");
                return res.status(404).json({ message: "Post not found or unauthorized" });
            }
        }


        let type;
        // 5. Update Media: The "Sync" approach
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


        if (author_company_id) {
            const auditClient = await pool.connect();
            try {
                await logAudit(auditClient, {
                    entityId: author_company_id,
                    actorId: userId,
                    action: 'UPDATE_POST',
                    metadata: {
                        type: 'post',
                        id: postId,
                        title: title || content?.substring(0, 20) || "Updated Post"
                    }
                });
            } finally {
                auditClient.release();
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

// checkCompanyPermission imported from utils/rbac

exports.deletePost = async (req, res) => {
    const postId = req.params.id;
    const userId = req.user.sub;

    if (!postId || !userId) {
        return res.status(400).json({ message: "postId and userId are required" });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Fetch Post Ownership Info
        const postRes = await client.query(
            `SELECT author_id, author_company_id FROM posts WHERE post_id = $1`,
            [postId]
        );

        if (postRes.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: "Post not found" });
        }

        const { author_id, author_company_id } = postRes.rows[0];
        let canDelete = false;

        // 2. Check Permissions
        if (author_id === userId && !author_company_id) {
            // Personal Post -> Author can delete
            canDelete = true;
        } else if (author_company_id) {
            // Company Post -> Check Company Permissions
            // Allow if Author (User acting as company) OR if has MANAGE_COMPANY / CREATE_CONTENT
            if (author_id === userId) {
                canDelete = true;
            } else {
                canDelete = await checkCompanyPermission(client, author_company_id, userId, ['MANAGE_COMPANY', 'CREATE_CONTENT']);
            }
        }

        if (!canDelete) {
            await client.query('ROLLBACK');
            return res.status(403).json({ message: "You are not authorized to delete this post." });
        }

        // 3. Delete

        // Log Audit BEFORE delete (so we still have access if needed, though we already fetched info)
        if (author_company_id) {
            const auditClient = await pool.connect();
            try {
                await logAudit(auditClient, {
                    entityId: author_company_id,
                    actorId: userId,
                    action: 'DELETE_POST', // Consistent naming
                    metadata: {
                        type: 'post',
                        id: postId,
                        title: "Deleted Post"
                    }
                });
            } finally {
                auditClient.release();
            }
        }

        await client.query(
            `DELETE FROM posts WHERE post_id = $1`,
            [postId]
        );

        await client.query('COMMIT');
        res.status(200).json({ message: "Post deleted", deletedPostId: postId });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Delete post error:", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
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
    const { companyId } = req.body;

    try {
        // Company Authorization Check
        if (companyId) {
            const memberCheck = await pool.query(
                `SELECT 1 FROM company_members WHERE company_id = $1 AND user_id = $2`,
                [companyId, userId]
            );
            if (memberCheck.rowCount === 0) {
                return res.status(403).json({ message: "Not authorized to act as this company" });
            }
        }

        // 1️⃣ Check if already liked
        let alreadyLiked;
        if (companyId) {
            alreadyLiked = await pool.query(
                "SELECT 1 FROM post_likes WHERE post_id = $1 AND company_id = $2",
                [postId, companyId]
            );
        } else {
            alreadyLiked = await pool.query(
                "SELECT 1 FROM post_likes WHERE post_id = $1 AND user_id = $2 AND company_id IS NULL",
                [postId, userId]
            );
        }

        let liked;

        if (alreadyLiked.rowCount > 0) {
            // 2️⃣ Unlike
            if (companyId) {
                await pool.query(
                    "DELETE FROM post_likes WHERE post_id = $1 AND company_id = $2",
                    [postId, companyId]
                );
            } else {
                await pool.query(
                    "DELETE FROM post_likes WHERE post_id = $1 AND user_id = $2 AND company_id IS NULL",
                    [postId, userId]
                );
            }
            liked = false;
        } else {
            // 3️⃣ Like
            if (companyId) {
                await pool.query(
                    "INSERT INTO post_likes (post_id, user_id, company_id) VALUES ($1, $2, $3)",
                    [postId, userId, companyId]
                );
            } else {
                await pool.query(
                    "INSERT INTO post_likes (post_id, user_id) VALUES ($1, $2)",
                    [postId, userId]
                );
            }
            liked = true;

            // 🔔 Notify Author
            // Fetch post author
            const postRes = await pool.query("SELECT author_id, author_company_id FROM posts WHERE post_id = $1", [postId]);
            if (postRes.rowCount > 0) {
                const authorId = postRes.rows[0].author_id;
                const authorCompanyId = postRes.rows[0].author_company_id;

                // Don't notify if self (User liking own user post OR Company liking own company post)
                let isSelf = (!companyId && !authorCompanyId && authorId === userId);
                if (companyId && authorCompanyId && companyId === authorCompanyId) isSelf = true;

                if (!isSelf) {
                    let senderName, senderAvatar;

                    if (companyId) {
                        const companyRes = await pool.query("SELECT name, logo_url FROM companies WHERE company_id = $1", [companyId]);
                        senderName = companyRes.rows[0].name;
                        senderAvatar = companyRes.rows[0].logo_url;
                    } else {
                        const userRes = await pool.query("SELECT full_name, avatar_url FROM users WHERE user_id = $1", [userId]);
                        senderName = userRes.rows[0].full_name;
                        senderAvatar = userRes.rows[0].avatar_url;
                    }

                    // Emit real-time
                    socketService.notifyUser(authorId, "notification", {
                        type: "like",
                        senderName: senderName,
                        senderAvatar: senderAvatar,
                        postId,
                        metadata: { company_id: companyId }
                    });

                    // Persist notification
                    await pool.query(
                        `INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata, recipient_company_id) 
                         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                        [authorId, userId, "like", `${senderName} liked your post`, postId, JSON.stringify({ company_id: companyId }), authorCompanyId]
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
    const { content, parent_id, companyId } = req.body; // Added companyId

    if (!postId || !userId || !content || !content.trim()) {
        console.error('[addComment] Missing required fields', { postId, userId, hasContent: !!content });
        return res.status(400).json({ message: "all fields are required" })
    }

    if (content.length > 1000) {
        console.error('[addComment] Comment too long', { length: content.length });
        return res.status(400).json({ message: "Comment too long (max 1000 characters)" })
    }

    try {
        // Company Authorization Check
        if (companyId) {
            const memberCheck = await pool.query(
                `SELECT 1 FROM company_members WHERE company_id = $1 AND user_id = $2`,
                [companyId, userId]
            );
            if (memberCheck.rowCount === 0) {
                return res.status(403).json({ message: "Not authorized to act as this company" });
            }
        }

        const post = await pool.query(`select post_id, author_id, author_company_id from posts where post_id = $1`, [postId])

        if (post.rowCount === 0) {
            return res.status(404).json({ message: "Post not found" })
        }

        const postAuthorId = post.rows[0].author_id;
        const postCompanyId = post.rows[0].author_company_id;

        // Block Check: Post Author (skip if company)
        if (!companyId) {
            const isBlockedByPostAuthor = await checkBlockStatus(postAuthorId, userId);
            const hasBlockedPostAuthor = await checkBlockStatus(userId, postAuthorId);

            if (isBlockedByPostAuthor || hasBlockedPostAuthor) {
                return res.status(403).json({ message: "You cannot comment on this post" });
            }
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

                if (!companyId) { // Skip block check for companies for now (simplify)
                    const isBlockedByParentHandler = await checkBlockStatus(parentAuthorId, userId);
                    const hasBlockedParentHandler = await checkBlockStatus(userId, parentAuthorId);

                    if (isBlockedByParentHandler || hasBlockedParentHandler) {
                        return res.status(403).json({ message: "You cannot reply to this comment" });
                    }
                }
            }

            // Always reply to the root comment of a thread (Instagram-style)
            insertParentId = parentComment.rows[0].parent_id || parent_id;
        }

        const result = await pool.query(
            `INSERT INTO post_comments (post_id, author_id, content, parent_id, author_company_id)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING comment_id, author_id, content, parent_id, author_company_id, created_at`,
            [postId, userId, content.trim(), insertParentId, companyId || null]
        );

        const newComment = result.rows[0];

        // --- NOTIFICATIONS & SOCKETS ---

        // Fetch actor details (User or Company)
        let actorName, actorAvatar;

        if (companyId) {
            const companyRes = await pool.query(`SELECT name, logo_url FROM companies WHERE company_id = $1`, [companyId]);
            const company = companyRes.rows[0];
            actorName = company.name;
            actorAvatar = company.logo_url;
        } else {
            const actorRes = await pool.query(`SELECT full_name, avatar_url FROM users WHERE user_id = $1`, [userId]);
            const actor = actorRes.rows[0];
            actorName = actor.full_name;
            actorAvatar = actor.avatar_url;
        }

        // Regex for mentions: @Username (simple alphanumeric + underscore)
        const mentionMatches = content.match(/@(\w+)/g);
        const mentionedUsernames = mentionMatches ? mentionMatches.map(m => m.substring(1)) : [];

        // Notify Post Owner
        // If Company comments, we notify post owner (User). 
        // If User comments on own post -> Skip.
        // If Company comments on own post (if possible?) -> Skip. 
        // Note: Posts are strictly User-owned currently. Companies don't own posts in this schema yet (except shared posts maybe?).

        let shouldNotifyPostOwner = true;
        if (!companyId && postAuthorId === userId) shouldNotifyPostOwner = false;

        if (shouldNotifyPostOwner) {
            const notificationText = `${actorName} commented on your post`;

            // Notification Metadata
            const meta = {
                comment_id: newComment.comment_id,
                company_id: companyId
            };

            await pool.query(
                `INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata, recipient_company_id) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [postAuthorId, userId, 'comment', notificationText, postId, JSON.stringify(meta), postCompanyId]
            );

            socketService.notifyUser(postAuthorId, "notification", {
                type: 'comment',
                text: notificationText,
                from: userId,
                senderName: actorName,
                senderAvatar: actorAvatar,
                referenceId: postId,
                metadata: meta,
                time: "Just now"
            });
        }

        if (parent_id) {
            // Get parent comment author AND company
            const parentAuthorRes = await pool.query(
                `SELECT author_id, author_company_id FROM post_comments WHERE comment_id = $1`,
                [parent_id]
            );

            if (parentAuthorRes.rowCount > 0) {
                const parentAuthorId = parentAuthorRes.rows[0].author_id;
                const parentCompanyId = parentAuthorRes.rows[0].author_company_id;

                // Notify parent author (if not self and not post owner already notified)
                let isSelfReply = (!companyId && parentAuthorId === userId);

                // Only skip if parent author is post owner AND not representing a company (because company nots are separate)
                let isPostOwner = (parentAuthorId === postAuthorId && !parentCompanyId);

                // Note: If parent is company, we should notify even if "isSelfReply" logic might seem ambiguous.
                // If I am User A, and I reply to my own Company C comment, I SHOULD notify Company C (so A sees it in C's view).
                // So "isSelfReply" should strictly be: Acting as X replying to X.
                if (companyId && parentCompanyId && companyId === parentCompanyId) isSelfReply = true;
                if (!companyId && !parentCompanyId && parentAuthorId === userId) isSelfReply = true;

                if (!isSelfReply && !isPostOwner) {
                    const replyText = `${actorName} replied to your comment`;
                    const meta = {
                        comment_id: newComment.comment_id,
                        parent_id,
                        company_id: companyId
                    };

                    await pool.query(
                        `INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata, recipient_company_id) 
                         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                        [parentAuthorId, userId, 'reply', replyText, postId, JSON.stringify(meta), parentCompanyId]
                    );

                    socketService.notifyUser(parentAuthorId, "notification", {
                        type: 'reply',
                        text: replyText,
                        from: userId,
                        senderName: actorName,
                        senderAvatar: actorAvatar,
                        referenceId: postId,
                        metadata: meta,
                        time: "Just now",
                        recipient_company_id: parentCompanyId // Helper for frontend if needed
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
                    let isSelf = (!companyId && mentionedUserId === userId);

                    if (!isSelf && mentionedUserId !== postAuthorId) {
                        if (!companyId) {
                            const isBlockedByMentioned = await checkBlockStatus(mentionedUserId, userId);
                            const hasBlockedMentioned = await checkBlockStatus(userId, mentionedUserId);
                            if (isBlockedByMentioned || hasBlockedMentioned) continue;
                        }

                        const notifText = `${actorName} mentioned you in a comment`;
                        const meta = {
                            comment_id: newComment.comment_id,
                            company_id: companyId
                        };

                        await pool.query(
                            `INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata) 
                             VALUES ($1, $2, $3, $4, $5, $6)`,
                            [mentionedUserId, userId, 'mention', notifText, postId, JSON.stringify(meta)]
                        );

                        socketService.notifyUser(mentionedUserId, "notification", {
                            type: 'mention',
                            text: notifText,
                            from: userId,
                            senderName: actorName,
                            senderAvatar: actorAvatar,
                            referenceId: postId,
                            metadata: meta,
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

        // The instruction provided a code block for `deletePost` but asked to insert it into `deleteComment`.
        // To maintain syntactic correctness and avoid introducing undefined variables (`post`, `postId`),
        // I am inserting a placeholder for `logAudit` that would be appropriate for `deleteComment`.
        // If the original instruction intended to modify a `deletePost` function that is not present in the provided context,
        // please provide the `deletePost` function's content.
        // For now, I'm assuming the user wants an audit log for comment deletion.
        // If `logAudit` is expected to be called, it needs to be imported or defined.
        // Assuming `logAudit` is available in this scope.
        // Also assuming `comment.author_company_id` exists if company-level auditing is needed for comments.
        if (comment.author_company_id) {
            const auditClient = await pool.connect();
            try {
                await logAudit(auditClient, {
                    entityId: comment.author_company_id, // Using comment's company ID
                    actorId: userId,
                    action: 'DELETE_COMMENT', // Action changed to DELETE_COMMENT
                    metadata: {
                        type: 'comment',
                        id: commentId,
                        post_id: comment.post_id,
                        // Potentially include comment content if needed for audit, but it's being deleted.
                        // For now, just ID and post_id.
                    }
                });
            } finally {
                auditClient.release();
            }
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
    const { companyId } = req.body;

    if (!commentId || !userId) {
        return res.status(400).json({ message: "Comment ID and user ID are required" });
    }

    try {
        // Company Authorization Check
        if (companyId) {
            const memberCheck = await pool.query(
                `SELECT 1 FROM company_members WHERE company_id = $1 AND user_id = $2`,
                [companyId, userId]
            );
            if (memberCheck.rowCount === 0) {
                return res.status(403).json({ message: "Not authorized to act as this company" });
            }
        }

        // Check if comment exists
        const commentCheck = await pool.query(
            `SELECT comment_id, author_id, author_company_id, post_id FROM post_comments WHERE comment_id = $1`,
            [commentId]
        );

        if (commentCheck.rowCount === 0) {
            return res.status(404).json({ message: "Comment not found" });
        }

        const comment = commentCheck.rows[0];

        // Check if user (or company) already liked this comment
        let existingLike;
        if (companyId) {
            existingLike = await pool.query(
                `SELECT * FROM comment_likes WHERE company_id = $1 AND comment_id = $2`,
                [companyId, commentId]
            );
        } else {
            existingLike = await pool.query(
                `SELECT * FROM comment_likes WHERE user_id = $1 AND comment_id = $2 AND company_id IS NULL`,
                [userId, commentId]
            );
        }

        let liked;
        if (existingLike.rowCount > 0) {
            // Unlike
            if (companyId) {
                await pool.query(
                    `DELETE FROM comment_likes WHERE company_id = $1 AND comment_id = $2`,
                    [companyId, commentId]
                );
            } else {
                await pool.query(
                    `DELETE FROM comment_likes WHERE user_id = $1 AND comment_id = $2 AND company_id IS NULL`,
                    [userId, commentId]
                );
            }
            liked = false;
        } else {
            // Like
            if (companyId) {
                await pool.query(
                    `INSERT INTO comment_likes (user_id, comment_id, company_id) VALUES ($1, $2, $3)`,
                    [userId, commentId, companyId]
                );
            } else {
                await pool.query(
                    `INSERT INTO comment_likes (user_id, comment_id) VALUES ($1, $2)`,
                    [userId, commentId]
                );
            }
            liked = true;

            // --- NOTIFICATION LOGIC ---
            const authorId = comment.author_id;
            const authorCompanyId = comment.author_company_id;

            // Determine if self-like
            let isSelf = (!companyId && authorId === userId);
            if (companyId && authorCompanyId && companyId === authorCompanyId) isSelf = true;
            if (!companyId && !authorCompanyId && authorId === userId) isSelf = true;

            if (!isSelf) {
                let senderName, senderAvatar;

                if (companyId) {
                    const companyRes = await pool.query("SELECT name, logo_url FROM companies WHERE company_id = $1", [companyId]);
                    senderName = companyRes.rows[0].name;
                    senderAvatar = companyRes.rows[0].logo_url;
                } else {
                    const userRes = await pool.query("SELECT full_name, avatar_url FROM users WHERE user_id = $1", [userId]);
                    senderName = userRes.rows[0].full_name;
                    senderAvatar = userRes.rows[0].avatar_url;
                }

                // Persist notification
                const meta = {
                    comment_id: commentId,
                    company_id: companyId,
                    post_id: comment.post_id
                };

                await pool.query(
                    `INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata, recipient_company_id) 
                     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [authorId, userId, "like", `${senderName} liked your comment`, comment.post_id, JSON.stringify(meta), authorCompanyId]
                );

                // Emit real-time
                socketService.notifyUser(authorId, "notification", {
                    type: "like",
                    text: `${senderName} liked your comment`,
                    senderName: senderName,
                    senderAvatar: senderAvatar,
                    referenceId: comment.post_id, // Link to post usually
                    metadata: meta,
                    recipient_company_id: authorCompanyId
                });
            }
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
    const { companyId } = req.query;

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
        
        CASE 
            WHEN c.author_company_id IS NOT NULL THEN comp.name 
            ELSE u.full_name 
        END AS full_name,

        CASE 
            WHEN c.author_company_id IS NOT NULL THEN comp.slug 
            ELSE u.account_name 
        END AS account_name,

        CASE 
            WHEN c.author_company_id IS NOT NULL THEN comp.logo_url 
            ELSE u.avatar_url 
        END AS avatar_url,
        COALESCE(comp.slug, u.account_name) AS author_slug,
        (c.author_company_id IS NOT NULL) AS is_company_post,
        CASE 
            WHEN c.author_company_id IS NOT NULL THEN comp.slogan 
            ELSE u.headline 
        END AS headline,

        c.author_company_id,

        COALESCE(
          (SELECT COUNT(*)::int FROM comment_likes cl WHERE cl.comment_id = c.comment_id),
          0
        ) AS like_count,
        COALESCE(
          (SELECT EXISTS(SELECT 1 FROM comment_likes cl 
           WHERE cl.comment_id = c.comment_id 
           AND (
               ($3::uuid IS NOT NULL AND cl.company_id = $3::uuid) 
               OR 
               ($3::uuid IS NULL AND cl.user_id = $2 AND cl.company_id IS NULL)
           )
          )),
          false
        ) AS is_liked
      FROM post_comments c
      JOIN users u ON c.author_id = u.user_id
      LEFT JOIN companies comp ON c.author_company_id = comp.company_id
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
            [postId, userId, companyId || null]
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
    const companyId = req.headers['x-company-id'];
    try {
        // Fetch following IDs (including companies)
        const followingRes = await pool.query(`
            SELECT following_id as id FROM followers WHERE follower_id = $1
            UNION
            SELECT company_id as id FROM company_followers WHERE user_id = $1
        `, [userId]);

        const followingIds = followingRes.rows.map(r => r.id);
        followingIds.push(userId); // Always include own stories

        const result = await pool.query(
            `
            SELECT 
                s.*, 
                COALESCE(comp.name, u.full_name) AS author_name, 
                CASE 
                    WHEN s.author_company_id IS NOT NULL THEN comp.logo_url 
                    ELSE u.avatar_url 
                END AS author_avatar,
                -- 1. Check if the current entity has viewed this story
                EXISTS (
                    SELECT 1 FROM story_views sv 
                    WHERE sv.story_id = s.story_id AND 
                    (
                        ($3::uuid IS NOT NULL AND sv.viewer_company_id = $3::uuid) OR
                        ($3::uuid IS NULL AND sv.viewer_id = $1 AND sv.viewer_company_id IS NULL)
                    )
                ) AS has_viewed,
                -- 2. Check if the current entity has liked this story
                EXISTS (
                    SELECT 1 FROM story_reactions sr 
                    WHERE sr.story_id = s.story_id AND sr.reaction_type = 'true' AND
                    (
                        ($3::uuid IS NOT NULL AND sr.reactor_company_id = $3::uuid) OR
                        ($3::uuid IS NULL AND sr.user_id = $1 AND sr.reactor_company_id IS NULL)
                    )
                ) AS has_liked,
                -- 3. Identity flag for UI changes
                (s.author_id = $1) AS is_author,
                (s.author_company_id IS NOT NULL) AS is_company,
                -- 4. Counts
                (SELECT COUNT(*) FROM story_views sv WHERE sv.story_id = s.story_id)::int AS view_count,
                (SELECT COUNT(*) FROM story_reactions sr WHERE sr.story_id = s.story_id AND sr.reaction_type = 'true')::int AS like_count
            FROM stories s
            JOIN users u ON s.author_id = u.user_id
            LEFT JOIN companies comp ON s.author_company_id = comp.company_id
            WHERE s.expires_at > now()
            AND (
                s.author_id = ANY($2)
                OR s.author_company_id = ANY($2)
            )
            ORDER BY s.created_at DESC
            `,
            [userId, followingIds, companyId || null]
        );

        res.json(result.rows);
    } catch (err) {
        console.error("Get stories error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.getGroupedStories = async (req, res) => {
    const userId = req.user.sub;
    const companyId = req.headers['x-company-id'];

    try {
        let currentEntityId = userId;
        let currentEntityName = "You";
        let currentEntityAvatar = null;
        let isCompanyContext = false;

        // 1. Determine Context (Company vs User)
        if (companyId) {
            const memberCheck = await pool.query(
                `SELECT 1 FROM company_members WHERE company_id = $1 AND user_id = $2`,
                [companyId, userId]
            );
            if (memberCheck.rowCount > 0) {
                const compRes = await pool.query(`SELECT company_id, name, logo_url FROM companies WHERE company_id = $1`, [companyId]);
                if (compRes.rowCount > 0) {
                    const comp = compRes.rows[0];
                    currentEntityId = comp.company_id;
                    currentEntityName = "Your Company"; // UI can override
                    currentEntityAvatar = comp.logo_url;
                    isCompanyContext = true;
                }
            }
        }

        if (!isCompanyContext) {
            const userRes = await pool.query(
                `SELECT user_id, full_name, avatar_url FROM users WHERE user_id = $1`,
                [userId]
            );
            if (userRes.rowCount > 0) {
                const currentUser = userRes.rows[0];
                currentEntityId = currentUser.user_id;
                currentEntityAvatar = currentUser.avatar_url;
            }
        }

        // Fetch following IDs
        let followingQuery = "SELECT following_id as id FROM followers WHERE follower_id = $1";
        if (!isCompanyContext) {
            followingQuery = `
                SELECT following_id as id FROM followers WHERE follower_id = $1
                UNION
                SELECT company_id as id FROM company_followers WHERE user_id = $1
            `;
        }

        const followingRes = await pool.query(followingQuery, [currentEntityId]);
        const followingIds = followingRes.rows.map(r => r.id);
        followingIds.push(currentEntityId);

        // 2. Fetch all active stories with author details (prefer company info if acting as company)
        const result = await pool.query(
            `
            SELECT 
                s.*, 
                COALESCE(comp.name, u.full_name) AS author_name, 
                CASE 
                    WHEN s.author_company_id IS NOT NULL THEN comp.logo_url 
                    ELSE u.avatar_url 
                END AS author_avatar,
                COALESCE(s.author_company_id, s.author_id) AS group_key,
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

                -- Check if viewed/liked using context
                EXISTS (
                    SELECT 1 FROM story_views sv 
                    WHERE sv.story_id = s.story_id AND 
                    (
                        ($4::uuid IS NOT NULL AND sv.viewer_company_id = $4::uuid) OR
                        ($4::uuid IS NULL AND sv.viewer_id = $1 AND sv.viewer_company_id IS NULL)
                    )
                ) AS has_viewed,
                EXISTS (
                    SELECT 1 FROM story_reactions sr 
                    WHERE sr.story_id = s.story_id AND sr.reaction_type = 'true' AND
                    (
                        ($4::uuid IS NOT NULL AND sr.reactor_company_id = $4::uuid) OR
                        ($4::uuid IS NULL AND sr.user_id = $1 AND sr.reactor_company_id IS NULL)
                    )
                ) AS has_liked,
                (s.author_id = $1) AS is_author,
                (s.author_company_id IS NOT NULL) AS is_company,
                -- Aggregate counts
                (SELECT COUNT(*) FROM story_views sv WHERE sv.story_id = s.story_id)::int AS view_count,
                (SELECT COUNT(*) FROM story_reactions sr WHERE sr.story_id = s.story_id AND sr.reaction_type = 'true')::int AS like_count
            FROM stories s
            JOIN users u ON s.author_id = u.user_id
            LEFT JOIN companies comp ON s.author_company_id = comp.company_id
            LEFT JOIN posts sp ON s.shared_post_id = sp.post_id
            LEFT JOIN users sp_u ON sp.author_id = sp_u.user_id
            LEFT JOIN post_categories sp_cat ON sp.category_id = sp_cat.category_id
            WHERE s.expires_at > now()
            AND (
                s.author_id = $2
                OR s.author_company_id = $2
                OR s.author_id = ANY($3)
                OR s.author_company_id = ANY($3)
            )
            AND NOT EXISTS (
                SELECT 1 FROM blocks b 
                WHERE (b.blocker_id = $1 AND b.blocked_id = s.author_id)
                   OR (b.blocker_id = s.author_id AND b.blocked_id = $1)
            )
            ORDER BY s.created_at ASC
            `,
            [userId, currentEntityId, followingIds, companyId || null]
        );

        const stories = result.rows;
        const groupsMap = new Map();

        // Initialize Current Entity Group always (User or Company)
        groupsMap.set(currentEntityId, {
            author: {
                id: currentEntityId,
                name: currentEntityName,
                avatar: currentEntityAvatar,
                is_company: isCompanyContext
            },
            is_current_user: true,
            latest_story_at: null, // Will update if stories exist
            stories: []
        });

        // Group stories
        for (const story of stories) {
            const groupKey = story.group_key;

            if (!groupsMap.has(groupKey)) {
                groupsMap.set(groupKey, {
                    author: {
                        id: groupKey,
                        name: story.author_name,
                        avatar: story.author_avatar
                    },
                    // is_current_user is true for the active context (User or Company)
                    is_current_user: groupKey === currentEntityId,
                    latest_story_at: story.created_at,
                    stories: []
                });
            }

            const group = groupsMap.get(groupKey);
            group.latest_story_at = story.created_at;

            group.stories.push({
                story_id: story.story_id,
                title: story.title,
                description: story.description,
                media_url: story.media_url,
                media_type: story.media_type,
                created_at: story.created_at,
                expires_at: story.expires_at,
                author_id: groupKey, // Use groupKey as author_id for grouping consistency
                author_name: story.author_name,
                author_avatar: story.author_avatar,
                is_author: story.is_author,
                is_company: story.is_company,
                has_viewed: story.has_viewed,
                has_liked: story.has_liked,
                view_count: story.view_count || 0,
                like_count: story.like_count || 0,
                shared_post: story.shared_post,
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

exports.getStoryRecommendations = async (req, res) => {
    try {
        // Mocked response or empty array for now so frontend doesn't crash 
        // until recommendations logic is actually implemented for stories.
        return res.status(200).json([]);
    } catch (err) {
        console.error("Story recommendations error:", err);
        return res.status(500).json({ message: "Internal server error" });
    }
};

exports.createStory = async (req, res) => {
    // Extract user ID from JWT — support both .sub and .user_id
    const userId = req.user?.sub || req.user?.user_id;
    if (!userId) {
        return res.status(401).json({ message: "Unauthorized: user not identified" });
    }

    const {
        title,
        media_url,        // The baked snapshot URL (image or video) from Cloudinary
        description,
        media_type,
        public_id,        // Cloudinary public_id for cleanup
        shared_post_id,
        story_metadata,   // Optional: edit metadata for re-editing (hybrid approach)
    } = req.body;

    // --- Validate required fields ---
    if (!media_url) {
        return res.status(400).json({ message: "media_url is required" });
    }

    const companyId = req.headers['x-company-id']; // Optional company context

    try {
        let authorCompanyId = null;

        if (companyId) {
            const memberCheck = await pool.query(
                `SELECT 1 FROM company_members WHERE company_id = $1 AND user_id = $2`,
                [companyId, userId]
            );
            if (memberCheck.rowCount === 0) {
                return res.status(403).json({ message: "Not authorized to act as this company" });
            }
            authorCompanyId = companyId;
        }

        // Derive media_type from URL extension if not provided
        const type = media_type || (media_url.toLowerCase().match(/\.(mp4|webm|mov)$/) ? 'video' : 'image');

        // Snapshot-based: everything is immediately ready (no server-side rendering)
        const result = await pool.query(
            `INSERT INTO stories
                (author_id, title, description, media_url, media_type,
                 expires_at, cld_public_id, shared_post_id,
                 story_metadata, author_company_id)
             VALUES ($1, $2, $3, $4, $5, now() + interval '24 hours', $6, $7, $8, $9)
             RETURNING story_id, created_at`,
            [
                userId,
                title ?? '',
                description || null,
                media_url,          // $4
                type,               // $5
                public_id || null,  // $6
                shared_post_id || null, // $7
                story_metadata ? JSON.parse(JSON.stringify(story_metadata)) : {}, // $8
                authorCompanyId || null  // $9
            ]
        );

        const { story_id } = result.rows[0];

        // Fetch a DTO that perfectly matches the Showcase API expectation 
        // (so the frontend optimistic insert works instantly)
        const mappedResult = await pool.query(
            `
            SELECT 
                s.*, 
                COALESCE(comp.name, u.full_name) AS author_name, 
                CASE 
                    WHEN s.author_company_id IS NOT NULL THEN comp.logo_url 
                    ELSE u.avatar_url 
                END AS author_avatar,
                false AS has_viewed,
                false AS has_liked,
                true AS is_author,
                (s.author_company_id IS NOT NULL) AS is_company,
                0 AS view_count,
                0 AS like_count,
                null AS shared_post
            FROM stories s
            JOIN users u ON s.author_id = u.user_id
            LEFT JOIN companies comp ON s.author_company_id = comp.company_id
            WHERE s.story_id = $1
            `,
            [story_id]
        );

        res.status(201).json(mappedResult.rows[0]);

    } catch (err) {
        console.error("[createStory] Database error:", err.message);
        console.error("[createStory] Full error:", err);
        res.status(500).json({ message: "Internal server error", detail: err.message });
    }
};



exports.deleteStory = async (req, res) => {
    const storyId = req.params.id;
    const userId = req.user.sub;

    if (!storyId) {
        return res.status(400).json({ message: "storyId is required" });
    }

    try {
        // Delete from DB and get the Cloudinary public_id for cleanup
        const result = await pool.query(
            `DELETE FROM stories WHERE story_id = $1 AND author_id = $2 RETURNING story_id, cld_public_id, media_type`,
            [storyId, userId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ message: "Story not found or unauthorized", storyId, userId });
        }

        // Clean up Cloudinary asset in background
        const { cld_public_id, media_type } = result.rows[0];
        if (cld_public_id) {
            const resourceType = media_type === 'video' ? 'video' : 'image';
            cloudinary.uploader.destroy(cld_public_id, { resource_type: resourceType })
                .catch(err => console.error(`[deleteStory] Cloudinary cleanup failed for ${cld_public_id}:`, err.message));
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
    const { companyId } = req.body; // Optional: View as company

    try {
        const storyRes = await pool.query(
            `SELECT author_id FROM stories WHERE story_id = $1`, [story_id]
        );

        if (storyRes.rowCount === 0) {
            return res.status(404).json({ message: "Story not found" });
        }

        const author_id = storyRes.rows[0].author_id;

        // If viewing as Company
        if (companyId) {
            // 1. Verify user is a member of the company
            const memberCheck = await pool.query(
                `SELECT 1 FROM company_members WHERE company_id = $1 AND user_id = $2`,
                [companyId, viewer_id]
            );

            if (memberCheck.rowCount === 0) {
                return res.status(403).json({ message: "Not authorized to act as this company" });
            }

            // 2. Record View (Company Logic)
            // We record the view if the Company hasn't viewed it yet.
            // We ignore author_id check strictly for now, or we can say companies owned by author also don't count?
            // Usually, "Pages" viewing "personal profiles" counts.
            // But if I own the company, maybe it shouldn't count?
            // Let's count it for now to be simple, unless it's literally the same author_id (which is a User ID, not Company ID).
            // A Company cannot be the "author" of a story yet (stories are user-centric in DB, author_id is FK to users).
            // So a Company viewing a User story is always a "cross-entity" view.

            await pool.query(
                `INSERT INTO story_views (story_id, viewer_id, viewer_company_id) 
                 VALUES ($1, $2, $3)
                 ON CONFLICT (story_id, viewer_company_id) WHERE viewer_company_id IS NOT NULL 
                 DO NOTHING`,
                [story_id, viewer_id, companyId]
            );

            return res.status(200).json({
                message: "Company view recorded",
                story_id: story_id
            });
        }

        // If viewing as User
        // Only insert if the viewer is NOT the author
        if (viewer_id !== author_id) {
            await pool.query(
                `INSERT INTO story_views (story_id, viewer_id, viewer_company_id) 
                 VALUES ($1, $2, NULL)
                 ON CONFLICT (story_id, viewer_id) WHERE viewer_company_id IS NULL
                 DO NOTHING`,
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
    const { id: storyId } = req.params;
    const userId = req.user.sub;
    const { reaction } = req.body; // true = like, false = undo
    const companyId = req.headers['x-company-id']; // Optional company context

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        // 1. Determine Reactor (User or Company)
        let reactorCompanyId = null;
        let reactorUserId = userId; // Default to user

        if (companyId) {
            // Verify membership
            const memberCheck = await client.query(
                `SELECT 1 FROM company_members WHERE company_id = $1 AND user_id = $2`,
                [companyId, userId]
            );
            if (memberCheck.rowCount === 0) {
                return res.status(403).json({ message: "Not authorized to act as this company" });
            }
            reactorCompanyId = companyId;
            reactorUserId = null; // Reactions are attributed to Company, not User+Company? 
            // DB schema: user_id is nullable? No, schema says `user_id UUID REFERENCES users`. I made it nullable in migration?
            // Wait, I did NOT make user_id nullable in migration. I only added reactor_company_id and dropped PK.
            // I need to ensure user_id is nullable in DB if I want to support "Company Only" reaction.
            // Actually, for now let's keep user_id as the "Actor" (who clicked) and reactor_company_id as the "Context".
            // But unique constraint `idx_story_reactions_company_unique` is on `(story_id, reactor_company_id)`.
            // So if User A acts as Comp X, and User B acts as Comp X, they collide. This IS correct for "Company Reaction".
            // So `reactorUserId` should be stored for audit, but uniqueness is on Company.
            // However, my partial index `idx_story_reactions_personal_unique` is `WHERE reactor_company_id IS NULL`.
            // So if I insert `user_id` AND `reactor_company_id`, it targets the Company Index. Correct.
        }

        // 2. Fetch Story & Media URL (for notification)
        const storyRes = await client.query(`SELECT author_id, media_url FROM stories WHERE story_id = $1`, [storyId]);
        if (storyRes.rowCount === 0) return res.status(404).json({ message: "Story not found" });
        const { author_id, media_url } = storyRes.rows[0];

        // 3. Toggle Like
        let liked = false;

        // Check existing reaction
        let query = "";
        let params = [];

        if (reactorCompanyId) {
            query = `SELECT * FROM story_reactions WHERE story_id = $1 AND reactor_company_id = $2`;
            params = [storyId, reactorCompanyId];
        } else {
            query = `SELECT * FROM story_reactions WHERE story_id = $1 AND user_id = $2 AND reactor_company_id IS NULL`;
            params = [storyId, reactorUserId];
        }

        const existingReaction = await client.query(query, params);

        if (existingReaction.rowCount > 0) {
            // UNLIKE
            if (reactorCompanyId) {
                await client.query("DELETE FROM story_reactions WHERE story_id = $1 AND reactor_company_id = $2", [storyId, reactorCompanyId]);
            } else {
                await client.query("DELETE FROM story_reactions WHERE story_id = $1 AND user_id = $2 AND reactor_company_id IS NULL", [storyId, reactorUserId]);
            }
            liked = false;
        } else {
            // LIKE
            // We need to handle the INSERT carefully with ON CONFLICT
            // Since we have partial indexes, ON CONFLICT (story_id, user_id) only works if we satisfy the WHERE clause of the partial index IN THE INSERT?
            // Actually, ON CONFLICT target must match the index definition.

            if (reactorCompanyId) {
                await client.query(
                    `INSERT INTO story_reactions (story_id, user_id, reactor_company_id, reaction_type)
                     VALUES ($1, $2, $3, $4)
                     ON CONFLICT (story_id, reactor_company_id) WHERE reactor_company_id IS NOT NULL
                     DO UPDATE SET reaction_type = $4`,
                    [storyId, userId, reactorCompanyId, reaction.toString()]
                );

                // Also record view for company
                await client.query(
                    `INSERT INTO story_views (story_id, viewer_id, viewer_company_id)
                     VALUES ($1, $2, $3)
                     ON CONFLICT (story_id, viewer_company_id) WHERE viewer_company_id IS NOT NULL
                     DO NOTHING`,
                    [storyId, userId, reactorCompanyId]
                );

            } else {
                await client.query(
                    `INSERT INTO story_reactions (story_id, user_id, reaction_type)
                     VALUES ($1, $2, $3)
                     ON CONFLICT (story_id, user_id) WHERE reactor_company_id IS NULL
                     DO UPDATE SET reaction_type = $3`,
                    [storyId, userId, reaction.toString()]
                );

                // Also record view for user
                await client.query(
                    `INSERT INTO story_views (story_id, viewer_id)
                     VALUES ($1, $2)
                     ON CONFLICT (story_id, viewer_id) WHERE viewer_company_id IS NULL
                     DO NOTHING`,
                    [storyId, userId]
                );
            }
            liked = true;

            // Notification (Only if not self-reaction)
            // If Company reacts to User Story -> Notify User.
            // If User reacts to User Story -> Notify User.
            // If Author is same as Actor (User Context) -> Skip.
            // If Author is same as Actor (Company Context) -> Skip ? (Company reacting to own story?)

            let shouldNotify = true;
            if (!reactorCompanyId && author_id === userId) shouldNotify = false;
            // TODO: If Company owns the story, check against Company ID? (Stories don't have owner_company_id yet, presumed User is author)

            if (shouldNotify && liked) {
                const actorName = reactorCompanyId ? (await client.query("SELECT name FROM companies WHERE company_id = $1", [reactorCompanyId])).rows[0].name : (await client.query("SELECT full_name FROM users WHERE user_id = $1", [userId])).rows[0].full_name;
                const actorAvatar = reactorCompanyId ? (await client.query("SELECT logo_url FROM companies WHERE company_id = $1", [reactorCompanyId])).rows[0].logo_url : (await client.query("SELECT avatar_url FROM users WHERE user_id = $1", [userId])).rows[0].avatar_url;

                const notificationData = {
                    type: "story_like",
                    text: `${actorName} liked your story`,
                    from: userId,
                    senderName: actorName,
                    senderAvatar: actorAvatar,
                    referenceId: storyId,
                    mediaUrl: media_url,
                    metadata: { company_id: reactorCompanyId }
                };

                // Notify via socket - ensuring socketService is available
                try {
                    // Check global or imported socketService
                    const ioService = require('../../core/infrastructure/socket.service');
                    if (ioService && ioService.notifyUser) {
                        ioService.notifyUser(author_id, "notification", notificationData);
                    }
                } catch (e) {
                    // console.warn("Socket notification failed:", e);
                }

                // Persist to DB
                await client.query(
                    `INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata) 
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                    [author_id, userId, "story_like", notificationData.text, storyId, notificationData.metadata]
                );
            }
        }

        const likeCountRes = await client.query(
            `SELECT COUNT(*) as count FROM story_reactions WHERE story_id = $1 AND reaction_type = 'true'`,
            [storyId]
        );
        const likeCount = parseInt(likeCountRes.rows[0].count, 10);

        try {
            const ioService = require('../../core/infrastructure/socket.service');
            if (ioService && ioService.notifyStory) {
                ioService.notifyStory(storyId, "story_reaction_updated", { storyId, likeCount });
            }
        } catch (e) {
            console.error("Socket emit failed", e)
        }

        await client.query("COMMIT");
        return res.status(200).json({ success: true, liked, likeCount });

    } catch (err) {
        await client.query("ROLLBACK");
        console.error("React story error:", err);
        return res.status(500).json({ message: "Failed to react to story" });
    } finally {
        client.release();
    }
};

exports.getStoryDetailsById = async (req, res) => {
    const userId = req.user.sub;
    const { id: storyId } = req.params;

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
                COALESCE(c.company_id, u.user_id) as user_id, -- Frontend uses 'user_id' as key
                COALESCE(c.name, u.full_name) as full_name, 
                COALESCE(c.logo_url, u.avatar_url) as avatar_url, 
                sr.reaction_type, 
                sv.viewed_at,
                c.company_id,
                CASE WHEN c.company_id IS NOT NULL THEN true ELSE false END as is_company
            FROM story_views sv 
            JOIN users u ON sv.viewer_id = u.user_id
            LEFT JOIN companies c ON sv.viewer_company_id = c.company_id
            -- Left Join ensures we still get the viewer even if there is no reaction
            -- Join specifically on context (Company vs User)
            LEFT JOIN story_reactions sr ON sv.story_id = sr.story_id AND (
                (sv.viewer_company_id IS NOT NULL AND sr.reactor_company_id = sv.viewer_company_id)
                OR
                (sv.viewer_company_id IS NULL AND sr.user_id = sv.viewer_id AND sr.reactor_company_id IS NULL)
            )
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
    const companyId = req.headers['x-company-id']; // Optional company context

    if (!storyId || !userId || !content || !content.trim()) {
        return res.status(400).json({ message: "all fields are required" })
    }

    try {
        let authorCompanyId = null;
        if (companyId) {
            const memberCheck = await pool.query(
                `SELECT 1 FROM company_members WHERE company_id = $1 AND user_id = $2`,
                [companyId, userId]
            );
            if (memberCheck.rowCount === 0) {
                return res.status(403).json({ message: "Not authorized to act as this company" });
            }
            authorCompanyId = companyId;
        }

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
            `INSERT INTO story_comments (story_id, author_id, content, author_company_id)
             VALUES ($1, $2, $3, $4)
             RETURNING comment_id, author_id, content, created_at, author_company_id`,
            [storyId, userId, content.trim(), authorCompanyId]
        );

        const newComment = result.rows[0];

        // Notify Author (if not self)
        const authorId = story.rows[0].author_id;
        if (authorId !== userId) {
            let commenterName, commenterAvatar;
            if (authorCompanyId) {
                const compRes = await pool.query(`SELECT name, logo_url FROM companies WHERE company_id = $1`, [authorCompanyId]);
                commenterName = compRes.rows[0].name;
                commenterAvatar = compRes.rows[0].logo_url;
            } else {
                const userRes = await pool.query(`SELECT full_name, avatar_url FROM users WHERE user_id = $1`, [userId]);
                commenterName = userRes.rows[0].full_name;
                commenterAvatar = userRes.rows[0].avatar_url;
            }

            socketService.notifyUser(authorId, "notification", {
                type: "story_comment",
                text: `${commenterName} commented on your story`,
                from: userId,
                senderName: commenterName,
                senderAvatar: commenterAvatar,
                referenceId: storyId,
                mediaUrl: story.rows[0].media_url,
                time: "Just now",
                metadata: { company_id: authorCompanyId }
            });

            await pool.query(
                `INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata) 
                  VALUES ($1, $2, $3, $4, $5, $6)`,
                [authorId, userId, "story_comment", `${commenterName} commented on your story`, storyId, { company_id: authorCompanyId }]
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
                COALESCE(comp.company_id, u.user_id) AS author_id,
                COALESCE(comp.name, u.full_name) AS full_name,
                CASE 
                    WHEN c.author_company_id IS NOT NULL THEN comp.logo_url 
                    ELSE u.avatar_url 
                END AS avatar_url,
                u.headline,
                (c.author_company_id IS NOT NULL) AS is_company
            FROM story_comments c
            JOIN users u ON c.author_id = u.user_id
            LEFT JOIN companies comp ON c.author_company_id = comp.company_id
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
