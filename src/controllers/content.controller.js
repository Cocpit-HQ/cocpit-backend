const { ur } = require("zod/locales");
const pool = require("../db/pool");

// --- Feed / Posts ---

exports.getFeed = async (req, res) => {
    const userId = req.user.sub;
    const { category } = req.query;

    try {
        let query = `
      SELECT p.*, u.full_name as author_name, u.avatar_url as author_avatar, pc.name as category_name
      FROM posts p
      JOIN users u ON p.author_id = u.user_id
      LEFT JOIN post_categories pc ON p.category_id = pc.category_id
      WHERE 1=1
    `;
        const params = [];

        // Logic for visibility: Public OR (Connections AND Connected)
        // For simplicity, we show all public posts for now, or implement logic later.
        // The design doc says: "visibility: public, connections, private".
        // We should filter.
        // Simplifying assumption: User can see all Public posts + Posts from connections.

        query += ` AND (p.visibility = 'public' OR p.author_id = $1)`;
        // TODO: Add logic for 'connections' visibility when Followers/Connections are implemented.
        params.push(userId);
        let paramCount = 2;

        if (category) {
            query += ` AND pc.name = $${paramCount}`;
            params.push(category);
            paramCount++;
        }

        query += ` ORDER BY p.created_at DESC`;

        const result = await pool.query(query, params);

        // Fetch media for posts? Or join?
        // Let's do a separate query or array agg if needed.
        // For MVP, just return posts.

        res.json(result.rows);
    } catch (err) {
        console.error("Get feed error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.createPost = async (req, res) => {
    const userId = req.user.sub;
    const { content, category, visibility, media_urls } = req.body; // category is name, media_urls is array

    try {
        // 1. Get Category ID
        let categoryId = null;
        if (category) {
            const catRes = await pool.query(`SELECT category_id FROM post_categories WHERE name = $1`, [category]);
            if (catRes.rowCount > 0) {
                categoryId = catRes.rows[0].category_id;
            } else {
                // Or create default categories if they don't exist?
                // Assuming categories are pre-seeded or we insert on fly.
                const newCat = await pool.query(`INSERT INTO post_categories (name) VALUES ($1) RETURNING category_id`, [category]);
                categoryId = newCat.rows[0].category_id;
            }
        }

        // 2. Insert Post
        const postResult = await pool.query(
            `
      INSERT INTO posts (author_id, category_id, content, visibility)
      VALUES ($1, $2, $3, $4)
      RETURNING post_id, created_at
      `,
            [userId, categoryId, content, visibility || 'public']
        );

        const postId = postResult.rows[0].post_id;

        // 3. Insert Media
        if (media_urls && Array.isArray(media_urls)) {
            for (const url of media_urls) {
                await pool.query(
                    `INSERT INTO post_media (post_id, url, media_type) VALUES ($1, $2, 'image')`,
                    [postId, url]
                );
            }
        }

        res.status(201).json({ message: "Post created", postId });
    } catch (err) {
        console.error("Create post error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.getPostById= async(req,res)=>{
    const postId = req.params.id;
    const userId = req.user.sub;

    try{
        const postResult = await pool.query(
            `select * from posts where post_id =$1 and author_id = $2`,[postId]);

        if(!postResult){
            return res.status(404).json({message:"post not found"})
        }else{
            res.status(200).json(postResult.rows[0]);
        }
    }catch(err){
        console.error("Get post by id error:", err);
        res.status(401).json({ message: "Internal server error" });
    }

}
// exports.deletePost = async (req, res) => {
//     const postId = req.params.id;
//     const userId = req.user.sub;

//     try {
//         // Check if post exists 


// }
exports.createPostCategory = async (req, res) => {
    const category = req.body.category;

    // if (!category || category.trim().length === 0) {
    //     return res.status(400).json({ message: "Category name required" });
    // }

    if (category !== 'Personal' || category !== 'Professional' || category !== 'Achievement') {
        return res.status(400).json({ message: "Invalid category name" });
    }

    try {
        await pool.query(
            `Insert into post_categories (name) values ($1)`, [category]
        )
        res.status(201).json("category created")
    } catch (err) {
        console.error("Create post category error:", err);
        res.status(500).json({ message: "Internal server error" })
    }
}

exports.handlePostMedia = async (req, res) => {
         const post_id = req.params.id;      // ✅ correct param
  const { url, media_type } = req.body;

  if (!url || !media_type) {
    return res.status(400).json({ message: "url and media_type are required" });
  }

        try{
            await pool.query(
                `Insert into post_media (post_id,url,media_type) values($1,$2,$3)`,
                [post_id,url,media_type]
            );
            res.status(201).json({message:"media added"})
        }catch(err){
            console.error('Handle post media error:', err);
            res.status(500).json({ message: 'Internal server error'});
        }

}

// --- Stories ---

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
    const { media_url, media_type } = req.body; // description field need to add and  title also

    try {
        await pool.query(
            `
            INSERT INTO stories (author_id, media_url, media_type, expires_at)
            VALUES ($1, $2, $3, now() + interval '24 hours')
            `,
            [userId, media_url, media_type || 'image'] //description,title of story
        );
        res.status(201).json({ message: "Story created" });
    } catch (err) {
        console.error("Create story error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.viewStory = async (req, res) => {

    const { id } = req.params;
    const viewer_id = req.user.sub;
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
