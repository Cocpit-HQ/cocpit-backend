const pool = require("../../../core/db/pool");

/**
 * Post Adapter
 * Converts post entity to universal preview metadata.
 */
async function resolve(postId) {
    const res = await pool.query(
        `SELECT
            p.post_id,
            p.content,
            u.full_name AS author_name,
            u.avatar_url AS author_avatar,
            (SELECT json_agg(json_build_object('url', pm.url, 'media_type', pm.media_type))
             FROM post_media pm WHERE pm.post_id = p.post_id
            ) AS media
         FROM posts p
         JOIN users u ON p.author_id = u.user_id
         WHERE p.post_id = $1`,
        [postId]
    );
    if (res.rowCount === 0) return null;

    const row = res.rows[0];
    const firstMedia = row.media && row.media[0] ? row.media[0].url : null;

    return {
        entityType: "post",
        entityId: postId,
        title: `Post by ${row.author_name}`,
        subtitle: row.content ? row.content.substring(0, 120) : "Shared content",
        image: firstMedia || row.author_avatar,
        url: `/post/${postId}`,
    };
}

module.exports = { resolve };
