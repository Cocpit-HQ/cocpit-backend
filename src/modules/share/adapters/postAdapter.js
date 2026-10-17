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
            p.post_type,
            p.title,
            u.full_name AS author_name,
            u.avatar_url AS author_avatar,
            (SELECT json_agg(json_build_object('url', url, 'media_type', media_type))
             FROM post_media pm WHERE pm.post_id = p.post_id
            ) AS media,
            (
                SELECT json_build_object(
                    'poll_id', pp.poll_id,
                    'options', (
                        SELECT json_agg(json_build_object('option_id', po.option_id, 'option_text', po.option_text, 'vote_count', (SELECT COUNT(*) FROM poll_votes pv WHERE pv.option_id = po.option_id)))
                        FROM poll_options po WHERE po.poll_id = pp.poll_id
                    ),
                    'total_votes', (SELECT COUNT(*) FROM poll_votes pv WHERE pv.poll_id = pp.poll_id),
                    'duration', COALESCE(pp.duration, '1 day'),
                    'is_active', (pp.created_at + COALESCE(pp.duration, '1 day')::interval > NOW())
                )
                FROM post_polls pp WHERE pp.post_id = p.post_id
            ) AS poll
         FROM posts p
         JOIN active_users u ON p.author_id = u.user_id
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
        post_type: row.post_type || "text",
        post_title: row.title || null,
        poll: row.poll || null,
    };
}

module.exports = { resolve };
