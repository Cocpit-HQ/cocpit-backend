const { ur, vi } = require("zod/locales");
const pool = require("../db/pool");

// --- Feed / Posts ---
exports.getPublicFeed = async (req, res) => {
    const { cursorCreatedAt, cursorPostId } = req.query;
    const limit = 10;

    try {
        const params = [];
        let cursorCondition = "";

        if (cursorCreatedAt && cursorPostId) {
            params.push(cursorCreatedAt, cursorPostId);
            cursorCondition = `
        AND (p.created_at, p.post_id) < ($1, $2)
      `;
        }

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

        COALESCE(pm.media, '[]') AS media,
        pp.poll

      FROM posts p
      JOIN users u ON u.user_id = p.author_id
      LEFT JOIN post_categories pc ON pc.category_id = p.category_id

      LEFT JOIN (
        SELECT post_id, json_agg(pm.*) AS media
        FROM post_media pm
        GROUP BY post_id
      ) pm ON pm.post_id = p.post_id

      LEFT JOIN (
        SELECT
          pp.post_id,
          json_build_object(
            'poll_id', pp.poll_id,
            'options', COALESCE(po.options, '[]'),
            'total_votes', COALESCE(pv.total_votes, 0)
          ) AS poll
        FROM post_polls pp
        LEFT JOIN (
          SELECT poll_id,
                 json_agg(
                   json_build_object(
                     'option_id', option_id,
                     'option_text', option_text,
                     'vote_count', vote_count
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
            GROUP BY po.option_id
          ) t
          GROUP BY poll_id
        ) po ON po.poll_id = pp.poll_id
        LEFT JOIN (
          SELECT poll_id, COUNT(*) AS total_votes
          FROM poll_votes
          GROUP BY poll_id
        ) pv ON pv.poll_id = pp.poll_id
      ) pp ON pp.post_id = p.post_id

      WHERE p.visibility = 'public'
      ${cursorCondition}

      ORDER BY p.created_at DESC, p.post_id DESC
      LIMIT $${params.length}
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
            whereClause += ` AND pc.name = $${idx}`;
            params.push(category);
            idx++;
        }

        // ✅ Cursor-based pagination (stable)
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

      -- ✅ MEDIA
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

      -- ✅ LIKE COUNT
      LEFT JOIN (
        SELECT post_id, COUNT(*) AS like_count
        FROM post_likes
        GROUP BY post_id
      ) lc ON lc.post_id = p.post_id

      -- ✅ COMMENT COUNT
      LEFT JOIN (
        SELECT post_id, COUNT(*) AS comment_count
        FROM post_comments
        GROUP BY post_id
      ) cc ON cc.post_id = p.post_id

      -- ✅ POLL
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
//             'duration', pp.duration,
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
    const { content, category, visibility, media_urls, post_type, title, poll_options, poll_duration } = req.body; // category is name, media_urls is array

    try {
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
            ` INSERT INTO posts (author_id, category_id, content, visibility,post_type,title)
      VALUES ($1, $2, $3, $4,$5,$6)
      RETURNING post_id, created_at
      `, [userId, categoryId, content, visibility || 'public', post_type, title]
        );

        const postId = postResult.rows[0].post_id;
        let pollId;
        if (post_type === 'poll' && poll_options) {
            const pollRes = await pool.query(
                `INSERT INTO post_polls (post_id, duration) VALUES ($1, $2) RETURNING poll_id`,
                [postId, poll_duration || '1 days'] // e.g., '1 day', '1 week'
            );
            pollId = pollRes.rows[0].poll_id;

            // Insert each option
            for (const opt of poll_options) {
                await pool.query(`INSERT INTO poll_options (poll_id, option_text) VALUES ($1, $2)`, [pollId, opt]);
            }
        }

        let type;
        // 3. Insert Media
        if (media_urls && Array.isArray(media_urls)) {
            for (const url of media_urls) {
                type = url.toLowerCase().match(/\.(mp4|webm|mov)$/) ? 'video' : 'image';
                await pool.query(`INSERT INTO post_media (post_id, url, media_type) VALUES ($1, $2, $3)`, [postId, url, type]);
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
                options: poll_options
            }
        });
    } catch (err) {
        console.error("Create post error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.getPostById = async (req, res) => {
    const postId = req.params.id;

    try {
        const query = `SELECT 
    p.*, 
    c.name AS category_name,

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
            'duration', pp.duration,
            'options',
            COALESCE(
                (
                    SELECT json_agg(
                        json_build_object(
                            'option_id', po.option_id,
                            'option_text', po.option_text,
                            -- FIX: Subquery to count votes for this specific option
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
    ) AS poll
FROM posts p
LEFT JOIN post_categories c ON p.category_id = c.category_id
WHERE p.post_id = $1;
`

        const result = await pool.query(query, [postId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ message: "Post not found" });
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
            updates.push(`category_id = $${index++}`);
            values.push(categoryId);
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
        'duration', pp.duration,
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
             (pp.created_at + pp.duration > NOW()) as is_active 
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
    const { content } = req.body;

    if (!postId || !userId || !content.trim()) {
        return res.status(400).json({ message: "all fields are required" })
    }

    try {
        const post = await pool.query(`select post_id from posts where post_id = $1`, [postId])

        if (post.rowCount === 0) {
            return res.status(404).json({ message: "Post not found" })
        }

        const result = await pool.query(
            `INSERT INTO post_comments (post_id, author_id, content)
   VALUES ($1, $2, $3)
   RETURNING comment_id,author_id, content, created_at`,
            [postId, userId, content.trim()]
        );

        return res.status(200).json({
            message: "comment added",
            comment: result.rows[0]
        })

    } catch (err) {
        return res.status(500).json({ message: "Internal server error" })
    }
}

exports.updateComment = async (req, res) => {
    const userId = req.user.sub;
    const commentId = req.params.comment_id;
    const { content } = req.body;

    if (!commentId) {
        return res.status(400).json({ message: "commentId is required" });
    }

    if (!content || !content.trim()) {
        return res.status(400).json({ message: "Content is required" });
    }

    try {
        const result = await pool.query(
            `
      UPDATE post_comments
      SET content = $1, created_at = NOW()
      WHERE comment_id = $2 AND author_id = $3
      RETURNING comment_id, content, created_at
      `,
            [content.trim(), commentId, userId]
        );
        const temp = await pool.query(`select * from post_comments where comment_id = $1 and author_id = $2`, [commentId, userId])

        if (result.rowCount === 0) {
            // Either comment doesn't exist OR user is not the author
            return res.status(403).json({ message: "Not allowed or comment not found" });
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
    const commentId = req.params.comment_id;

    if (!userId || !commentId) {
        return res.status(400).json({ message: "userId and commentId are required" })
    }

    try {
        const result = await pool.query(
            `delete from post_comments where comment_id = $1 and author_id = $2 RETURNING comment_id`,
            [commentId, userId]
        );
        if (result.rowCount === 0) {
            return res.status(404).json({ message: "Comment not found", commentId, userId });
        }
        res.status(200).json({ message: "Comment deleted", deletedCommentId: commentId });
    } catch (err) {
        return res.status(500).json({ message: "Internal server error" })
    }
}

exports.getComments = async (req, res) => {
    const postId = req.params.id;

    if (!postId) {
        return res.status(400).json({ message: "postId is required" })
    }
    try {
        const post = await pool.query(`select post_id from posts where post_id = $1`, [postId])
        console.log(post)
        if (post.rowCount === 0) {
            return res.status(404).json({ message: "Post not found" })
        }
        console.log(postId)
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
      FROM post_comments c
      JOIN users u ON c.author_id = u.user_id
      WHERE c.post_id = $1
      ORDER BY c.created_at desc
      `,
            [postId]
        );
        return res.status(200).json(comments.rows);
    } catch (err) {
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
                (s.author_id = $1) AS is_author
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

exports.createStory = async (req, res) => {
    const userId = req.user.sub;
    const { title, media_url, description } = req.body; // description field need to add and  title also

    try {
        let type;
        type = media_url.toLowerCase().match(/\.(mp4|webm|mov)$/) ? 'video' : 'image';
        await pool.query(
            `
            INSERT INTO stories (author_id,title, description, media_url, media_type, expires_at)
            VALUES ($1, $2, $3, $4, $5, now() + interval '24 hours')
            `,

            [userId, title, description, media_url, type || 'image']
        );
        res.status(201).json({
            message: "Story created",
            userId: userId,
            title: title,
            description: description,
            media_url: media_url,
            media_type: type,

        });
    } catch (err) {
        console.error("Create story error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.deleteStory = async (req, res) => {
    const storyId = req.params.id;
    const userId = req.user.sub;
}

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
        const storyRes = await pool.query(`SELECT author_id FROM stories WHERE story_id = $1`, [story_id]);
        if (storyRes.rowCount === 0) return res.status(404).json({ message: "Story not found" });

        const author_id = storyRes.rows[0].author_id;
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
            ORDER BY sv.viewed_at DESC
        `, [storyId]);


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
