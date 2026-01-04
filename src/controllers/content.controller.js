const { ur } = require("zod/locales");
const pool = require("../db/pool");

// --- Feed / Posts ---
exports.getPublicFeed = async (req, res) => {


    try {
        let query = `
            SELECT p.*, u.full_name as author_name, u.avatar_url as author_avatar, pc.name as category_name,
            COALESCE((SELECT json_agg(pm) FROM post_media pm WHERE pm.post_id = p.post_id), '[]'::json) AS media,
            (SELECT json_build_object('poll_id', pp.poll_id,
            'duration', pp.duration,
            'total_votes', (SELECT COUNT(*) FROM poll_votes pv WHERE pv.poll_id = pp.poll_id),
             'options', 
                COALESCE((SELECT json_agg(json_build_object(
                                    'option_id', po.option_id,
                                    'option_text', po.option_text,
                                    -- Calculate vote count for this specific option
                                    'vote_count', (SELECT COUNT(*) FROM poll_votes pv WHERE pv.option_id = po.option_id)
                                )) FROM poll_options po WHERE po.poll_id = pp.poll_id), '[]'::json))
             FROM post_polls pp WHERE pp.post_id = p.post_id) AS poll
            FROM posts p
            JOIN users u ON p.author_id = u.user_id
            LEFT JOIN post_categories pc ON p.category_id = pc.category_id
            WHERE p.visibility = 'public' ORDER BY p.created_at DESC
        `;


        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error("Get feed error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.getPersonalizedFeed = async (req, res) => {
    const userId = req.user.sub;
    const { category } = req.query;

    try {
        let query = `
            SELECT p.*, u.full_name as author_name, u.avatar_url as author_avatar, pc.name as category_name,
            COALESCE((SELECT json_agg(pm) FROM post_media pm WHERE pm.post_id = p.post_id), '[]'::json) AS media,
            (SELECT json_build_object('poll_id', pp.poll_id,
            'duration', pp.duration,
            'total_votes', (SELECT COUNT(*) FROM poll_votes pv WHERE pv.poll_id = pp.poll_id),
             'options', 
                COALESCE((SELECT json_agg(json_build_object(
                                    'option_id', po.option_id,
                                    'option_text', po.option_text,
                                    -- Calculate vote count for this specific option
                                    'vote_count', (SELECT COUNT(*) FROM poll_votes pv WHERE pv.option_id = po.option_id)
                                )) FROM poll_options po WHERE po.poll_id = pp.poll_id), '[]'::json))
             FROM post_polls pp WHERE pp.post_id = p.post_id) AS poll
            FROM posts p
            JOIN users u ON p.author_id = u.user_id
            LEFT JOIN post_categories pc ON p.category_id = pc.category_id
            WHERE (p.visibility = 'public' OR p.author_id = $1)
        `;

        const params = [userId];
        if (category) {
            query += ` AND pc.name = $2`;
            params.push(category);
        }
        query += ` ORDER BY p.created_at DESC`;

        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        console.error("Get feed error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

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
        const query = `
           SELECT     p.*, 
    c.name AS category_name,

    --  Media (array)
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

    --  Poll (object or null)
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
                            'option_text', po.option_text
                            'vote_count', COUNT(pv.vote_id)
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

        `;

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
        const catRes = await client.query(
            `SELECT category_id FROM post_categories WHERE name = $1`,
            [category]
        );
        const categoryId = catRes.rows[0].category_id;

        // 3. Update main post content
        const postUpdate = await client.query(
            `UPDATE posts 
             SET title = $1, content = $2, visibility = $3, category_id = $4, updated_at = NOW()
             WHERE post_id = $5 AND author_id = $6`,
            [title, content, visibility, categoryId, postId, userId]
        );

        if (postUpdate.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: "Post not found or unauthorized" });
        }

        let type;
        // 4. Update Media: The "Sync" approach
        if (media_urls && Array.isArray(media_urls)) {
            await client.query(`DELETE FROM post_media WHERE post_id = $1`, [postId]);

            // Insert new media list
            for (const url of media_urls) {
                type = url.toLowerCase().match(/\.(mp4|webm|mov)$/) ? 'video' : 'image';
                await client.query(
                    `INSERT INTO post_media (post_id, url, media_type) VALUES ($1, $2, $3)`,
                    [postId, url, type]
                );
            }
        }

        await client.query('COMMIT');


        const query = `
           SELECT     p.*, 
    c.name AS category_name,

    --  Media (array)
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

    --  Poll (object or null)
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
                            'option_text', po.option_text
                            'vote_count', COUNT(pv.vote_id)
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

exports.getStories = async (req, res) => {
    // Return stories that are not expired
    try {
        const result = await pool.query(
            `
            SELECT s.*, u.full_name, u.avatar_url
            FROM stories s
            JOIN users u ON s.author_id = u.user_id
            WHERE s.expires_at > now()
            ORDER BY s.created_at DESC
            `
        );
        res.json(result.rows);
    } catch (err) {
        console.error("Get stories error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.createStory = async (req, res) => {
    const userId = req.user.sub;
    const {title, media_url,description } = req.body; // description field need to add and  title also

    try {
         let type;
            type = media_url.toLowerCase().match(/\.(mp4|webm|mov)$/) ? 'video' : 'image';
        await pool.query(
            `
            INSERT INTO stories (author_id,title, description, media_url, media_type, expires_at)
            VALUES ($1, $2, $3, $4, $5, now() + interval '24 hours')
            `,
                
            [userId,title, description, media_url, type || 'image'] 
        );
        res.status(201).json({ message: "Story created" ,
            userId:userId,
            title:title,
            description:description,
            media_url:media_url,
            media_type:type,
            
        });
    } catch (err) {
        console.error("Create story error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.viewStory = async (req, res) => {

    const { id } = req.params;
    const viewer_id = req.user.sub;

    if (!id && !viewer_id) {
        return res.status(400).json({ message: "id and viewer_id are required" })
    }

    try {
        await pool.query(
            `INSERT INTO story_views (  story_id, viewer_id)  VALUES ($1, $2)
  ON CONFLICT (story_id, viewer_id) DO NOTHING`, [id, viewer_id]
        );
        res.status(200).json({ message: "story viewed" });
    } catch (err) {
        console.error("View story error:", err);
        res.status(500).json({ message: "Internal server error" });
    }

};

exports.reactToStory = async (req, res) => {
    const userId = req.user.sub;
    const { id } = req.params; // story_id
    const { reaction } = req.body;

    try {
        await pool.query(
            `
            INSERT INTO story_reactions (story_id, user_id, reaction_type)
            VALUES ($1, $2, $3)
            ON CONFLICT (story_id, user_id) DO UPDATE SET reaction_type = $3
            `,
            [id, userId, reaction]
        );
        res.status(200).json({ message: "Reacted to story" });
    } catch (err) {
        console.error("Story reaction error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};
