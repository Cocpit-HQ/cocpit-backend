const pool = require("../../core/db/pool");
const { checkOrgPermission } = require("../../core/utils/rbac");

// Helper for Audit Logging
const logAudit = async (client, { entityId, actorId, action, metadata = {} }) => {
    const query = `
    INSERT INTO audit_logs (entity_type, entity_id, actor_id, action, metadata)
    VALUES ($1, $2, $3, $4, $5)
  `;
    await client.query(query, ['ORGANIZATION', entityId, actorId, action, metadata]);
};

exports.notifyEmployees = async (req, res) => {
    const { orgId: companyId, postId } = req.params;
    const userId = req.user.sub;

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const canNotify = await checkOrgPermission(client, companyId, userId, 'MANAGE_COMPANY');
        if (!canNotify) throw new Error("Forbidden: You cannot notify members");

        // 1. Get Organization Name
        const companyRes = await client.query('SELECT name FROM organizations WHERE org_id = $1', [companyId]);
        const companyName = companyRes.rows[0].name;

        // 2. Get all members (excluding the sender)
        const employeesRes = await client.query(
            `SELECT user_id FROM organization_members WHERE org_id = $1 AND user_id != $2`,
            [companyId, userId]
        );
        const employees = employeesRes.rows;

        if (employees.length === 0) {
            await client.query("COMMIT");
            return res.json({ message: "No other members to notify", count: 0 });
        }

        // 3. Create Notifications
        const notificationText = `${companyName} invites you to share their new post.`;
        const notificationType = 'advocacy';

        for (const emp of employees) {
            await client.query(
                `INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [emp.user_id, userId, notificationType, notificationText, postId, { companyId }]
            );
        }

        await client.query("COMMIT");
        res.json({ message: "Notifications sent", count: employees.length });
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Notify members error:", err);
        if (err.message.startsWith("Forbidden")) return res.status(403).json({ message: err.message });
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

exports.getOrganizationPosts = async (req, res) => {
    const { orgId: companyId } = req.params;
    const userId = req.user ? req.user.sub : null; // Can be guest theoretically, but middleware might enforce auth
    const {
        cursorCreatedAt,
        cursorPostId,
        limit = 10,
    } = req.query;

    try {
        const params = [companyId];
        let idx = 2;
        let whereClause = `WHERE p.author_org_id = $1`;

        // We can expose a userId param for "is_liked" check even if public
        // For now, let's assume req.user is populated if authenticated

        if (userId) {
            params.push(userId); // $2
            idx++;
        } else {
            params.push(null); // $2 dummy
            idx++;
        }
        const userParamIdx = 2; // Fixed index for user_id in this specific query construction

        // 1. Cursor handling
        if (cursorCreatedAt && cursorPostId) {
            whereClause += ` AND (p.created_at, p.post_id) < ($${idx}, $${idx + 1})`;
            params.push(cursorCreatedAt, cursorPostId);
            idx += 2;
        }

        // 2. Limit
        params.push(limit);

        const query = `
        SELECT
            p.post_id,
            p.content,
            p.created_at,
            p.visibility,

            -- Author is always the company here
            comp.org_id AS author_id, -- Mapped to author_id for frontend compatibility
            comp.name AS author_name,
            comp.logo_url AS author_avatar,
            comp.slug AS author_slug,
            comp.slogan AS author_headline,
            (comp.entity_type = 'ORGANIZATION') AS is_organization_post,
            (comp.entity_type = 'INSTITUTION') AS is_institution_post,

            pc.name AS category_name,

            COALESCE(pm.media, '[]'::json) AS media,
            COALESCE(lc.like_count, 0)::int AS like_count,
            COALESCE(cc.comment_count, 0)::int AS comment_count,
            EXISTS(SELECT 1 FROM post_likes pl WHERE pl.post_id = p.post_id AND pl.user_id = $${userParamIdx}) AS is_liked,

            pp.poll,

            -- Shared Post Data
            CASE 
                WHEN p.shared_post_id IS NULL THEN NULL
                WHEN sp.post_id IS NULL THEN 
                    json_build_object('is_accessible', false, 'reason', 'deleted')
                ELSE
                    json_build_object(
                        'is_accessible', true,
                        'post_id', sp.post_id,
                        'content', sp.content,
                        'created_at', sp.created_at,
                        'author', json_build_object(
                             'user_id', COALESCE(sp.author_org_id, sp_u.user_id),
                             'full_name', COALESCE(sp_comp.name, sp_u.full_name),
                             'avatar_url', COALESCE(sp_comp.logo_url, sp_u.avatar_url),
                             'author_slug', COALESCE(sp_comp.slug, sp_u.account_name),
                             'author_headline', COALESCE(sp_comp.slogan, sp_u.headline),
                             'is_organization_post', (sp.author_org_id IS NOT NULL)
                        ),
                        'media', COALESCE(sp_media.media, '[]'::json),
                        'like_count', (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = sp.post_id)::int,
                        'comment_count', (SELECT COUNT(*) FROM post_comments pc WHERE pc.post_id = sp.post_id)::int,
                         'is_liked', EXISTS(SELECT 1 FROM post_likes pl WHERE pl.post_id = sp.post_id AND pl.user_id = $${userParamIdx})
                    )
            END AS shared_post

        FROM posts p
        JOIN organizations comp ON comp.org_id = p.author_org_id
        LEFT JOIN post_categories pc ON pc.category_id = p.category_id

         -- Media
        LEFT JOIN (
            SELECT post_id, json_agg(json_build_object('url', url, 'media_type', media_type)) as media
            FROM post_media GROUP BY post_id
        ) pm ON pm.post_id = p.post_id

        -- Likes
        LEFT JOIN (
            SELECT post_id, COUNT(*) AS like_count FROM post_likes GROUP BY post_id
        ) lc ON lc.post_id = p.post_id

        -- Comments
        LEFT JOIN (
            SELECT post_id, COUNT(*) AS comment_count FROM post_comments GROUP BY post_id
        ) cc ON cc.post_id = p.post_id

        -- Polls
        LEFT JOIN (
             SELECT pp.post_id, json_build_object(
                'poll_id', pp.poll_id,
                'duration', COALESCE(pp.duration, '1 day'),
                'total_votes', COALESCE(pv.total_votes, 0),
                'user_vote', (SELECT pv_u.option_id FROM poll_votes pv_u WHERE pv_u.poll_id = pp.poll_id AND pv_u.voter_id = $${userParamIdx} LIMIT 1),
                'options', COALESCE(po.options, '[]'::json),
                'is_active', (pp.created_at + COALESCE(pp.duration, '1 day')::interval > NOW())
             ) AS poll
             FROM post_polls pp
             LEFT JOIN (
                SELECT poll_id, json_agg(json_build_object('option_id', option_id, 'option_text', option_text, 'vote_count', vote_count)) AS options
                FROM (
                    SELECT po.option_id, po.poll_id, po.option_text, COUNT(pv.vote_id) AS vote_count
                    FROM poll_options po
                    LEFT JOIN poll_votes pv ON pv.option_id = po.option_id
                    GROUP BY po.option_id
                ) t GROUP BY poll_id
             ) po ON po.poll_id = pp.poll_id
             LEFT JOIN (SELECT poll_id, COUNT(*) as total_votes FROM poll_votes GROUP BY poll_id) pv ON pv.poll_id = pp.poll_id
        ) pp ON pp.post_id = p.post_id

        -- Shared Post Joins
        LEFT JOIN posts sp ON p.shared_post_id = sp.post_id
        LEFT JOIN active_users sp_u ON sp.author_id = sp_u.user_id
        LEFT JOIN organizations sp_comp ON sp_comp.org_id = sp.author_org_id
        LEFT JOIN (
             SELECT post_id, json_agg(json_build_object('url', url, 'media_type', media_type)) as media
             FROM post_media GROUP BY post_id
        ) sp_media ON sp.post_id = sp_media.post_id
        
        ${whereClause} AND (p.is_removed IS FALSE OR p.is_removed IS NULL)
        ORDER BY p.created_at DESC, p.post_id DESC
        LIMIT $${idx}
        `;

        const { rows } = await pool.query(query, params);
        const last = rows[rows.length - 1];

        res.json({
            posts: rows,
            nextCursor: last ? { cursorCreatedAt: last.created_at, cursorPostId: last.post_id } : null
        });

    } catch (err) {
        console.error("Get organization posts error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};
