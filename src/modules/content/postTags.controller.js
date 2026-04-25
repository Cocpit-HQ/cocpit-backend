const pool = require("../../core/db/pool");

exports.syncPostTags = async (req, res) => {
    const { postId, tags } = req.body; 

    // Use empty array if tags is undefined
    const validTags = Array.isArray(tags) ? tags : [];

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Step 1: Soft-delete (deactivate) tags that are NOT in the new list
        if (validTags.length > 0) {
            await client.query(`
                UPDATE post_tags 
                SET is_active_tag = false, updated_at = NOW() 
                WHERE post_id = $1 AND tagged_user_id != ALL($2::uuid[])
            `, [postId, validTags]);
        } else {
            // If the array is completely empty, deactivate ALL tags for this post
            await client.query(`
                UPDATE post_tags 
                SET is_active_tag = false, updated_at = NOW() 
                WHERE post_id = $1
            `, [postId]);
        }

        // Step 2: Upsert (Insert or Reactivate) the new tags
        if (validTags.length > 0) {
            // We use UNNEST($2::uuid[]) to efficiently batch insert multiple rows
            // ON CONFLICT handles if the user was tagged previously
            await client.query(`
                INSERT INTO post_tags (post_id, tagged_user_id, is_active_tag, updated_at)
                SELECT $1, unnest($2::uuid[]), true, NOW()
                ON CONFLICT (post_id, tagged_user_id) 
                DO UPDATE SET 
                    is_active_tag = true,
                    updated_at = NOW()
            `, [postId, validTags]);
        }

        await client.query('COMMIT');
        return res.status(200).json({ message: "Tags synced successfully" });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Error syncing post tags:", error);
        return res.status(500).json({ error: "Internal server error while syncing tags" });
    } finally {
        client.release();
    }
};

exports.getActivePostTags = async (req, res) => {
    const { postId } = req.query;

    if (!postId) {
        return res.status(400).json({ error: "postId query parameter is required" });
    }

    try {
        const query = `
            SELECT 
                u.user_id AS id,
                u.full_name,
                u.account_name,
                u.headline,
                u.avatar_url,
                p.account_type,
                'USER'::text as type,
                NULL::text as slug,
                NULL::text as industry,
                pt.tag_id, 
                pt.updated_at AS tagged_at
            FROM post_tags pt
            JOIN users u ON pt.tagged_user_id = u.user_id
            LEFT JOIN profiles p ON u.user_id = p.user_id
            WHERE pt.post_id = $1 AND pt.is_active_tag = true
            ORDER BY pt.updated_at DESC
        `;
        
        const { rows } = await pool.query(query, [postId]);

        return res.status(200).json({
            postId,
            active_tags_count: rows.length,
            tags: rows
        });

    } catch (error) {
        console.error("Error fetching active tags:", error);
        return res.status(500).json({ error: "Internal server error" });
    }
};
