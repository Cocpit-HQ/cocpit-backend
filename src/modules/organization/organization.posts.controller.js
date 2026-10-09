const pool = require("../../core/db/pool");
const { hydrateShareCounts } = require("../../utils/shareHydration");
const BlockModel = require("../../models/block.model");
const { checkOrgPermission } = require("../../core/utils/rbac");
const { checkActorBlockStatus } = require("../../core/utils/blockCheck");

// Is the viewer currently "acting as" the given org (via x-actor-type/x-actor-id headers)?
// Needed so that a like/vote/repost made by ANY team member while acting as this company
// is reflected as "mine" for every other team member also currently acting as it.
const isActingAsOrg = (req, orgId) => {
    const rawType = req.headers["x-actor-type"];
    const type = typeof rawType === "string" ? rawType.trim().toUpperCase() : null;
    const isOrgType = type === "ORGANIZATION" || type === "COMPANY" || type === "ORG";
    return isOrgType && req.headers["x-actor-id"] === orgId;
};

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
        filter,
    } = req.query;

    try {
        let hasPrivateAccess = false;
        if (req.user || req.actor) {
            const isBlocked = await checkActorBlockStatus(req, companyId);
            if (isBlocked) {
                return res.status(404).json({ message: "Organization not found" });
            }
            if (userId) {
                hasPrivateAccess = await checkOrgPermission(pool, companyId, userId, ['MANAGE_COMPANY', 'SWITCH_TO_COMPANY', 'MANAGE_ORGANIZATION', 'SWITCH_TO_ORGANIZATION']);
            }
        }

        const params = [companyId]; // $1
        let idx = 2;

        const userParamIdx = 2; // Fixed index for user_id in this specific query construction
        if (userId) {
            params.push(userId); // $2
            idx++;
        } else {
            params.push(null); // $2 dummy
            idx++;
        }

        // Is the viewer currently acting as THIS company? If so, "my" likes/votes/reposts
        // should reflect the company's shared identity, not just this individual's clicks.
        const rawType = req.headers["x-actor-type"];
        const type = typeof rawType === "string" ? rawType.trim().toUpperCase() : null;
        const isOrgType = type === "ORGANIZATION" || type === "COMPANY" || type === "ORG";
        const actorOrgId = isOrgType ? req.headers["x-actor-id"] : null;
        params.push(actorOrgId); // $3
        const orgActorParamIdx = idx;
        idx++;

        let whereClause = `WHERE p.author_org_id = $1`;

        if (filter === 'Post') {
            whereClause += ` AND p.shared_post_id IS NULL AND p.shared_job_id IS NULL `;
        } else if (filter === 'Repost') {
            whereClause += ` AND (p.shared_post_id IS NOT NULL OR p.shared_job_id IS NOT NULL) `;
        } else if (filter === 'Private post') {
            if (!hasPrivateAccess) {
                return res.json({ posts: [], nextCursor: null });
            }
            whereClause += ` AND p.visibility = 'private' `;
        } else if (filter === 'Articles' || filter === 'Article') {
            whereClause += ` AND (p.post_type = 'article' OR pc.name = 'Article' OR p.is_community_article = TRUE) AND p.shared_post_id IS NULL AND p.shared_job_id IS NULL `;
        } else if (filter === 'Video' || filter === 'Videos') {
            whereClause += ` AND (p.post_type = 'video' OR EXISTS (SELECT 1 FROM post_media pm WHERE pm.post_id = p.post_id AND pm.media_type = 'video')) AND p.shared_post_id IS NULL AND p.shared_job_id IS NULL `;
        } else if (filter === 'Poll' || filter === 'Polls') {
            whereClause += ` AND (p.post_type = 'poll' OR EXISTS (SELECT 1 FROM post_polls pp WHERE pp.post_id = p.post_id)) AND p.shared_post_id IS NULL AND p.shared_job_id IS NULL `;
        }

        if (filter !== 'Private post') {
            whereClause += ` AND (p.visibility IS NULL OR p.visibility != 'private') `;
        }
        whereClause += ` AND p.is_community_article IS NOT TRUE `;

        // Exclude posts reported by the current user
        whereClause += ` AND ($${userParamIdx}::uuid IS NULL OR NOT EXISTS (
            SELECT 1 FROM reports r 
            WHERE r.target_type IN ('POST', 'ARTICLE', 'JOB', 'THOUGHT')
              AND (r.target_id = p.post_id OR r.target_id = p.shared_post_id OR r.target_id = p.shared_job_id)
              AND r.reporter_id = $${userParamIdx}::uuid
        )) `;

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
            p.post_type,
            p.title,

            -- Author is always the company here
            comp.org_id AS author_id, -- Mapped to author_id for frontend compatibility
            p.author_id AS created_by_user_id, -- Real team member who created this post
            comp.name AS author_name,
            comp.logo_url AS author_avatar,
            comp.slug AS author_slug,
            comp.headline AS author_headline,
            (comp.entity_type = 'ORGANIZATION') AS is_organization_post,
            (comp.entity_type = 'INSTITUTION') AS is_institution_post,

            pc.name AS category_name,

            COALESCE(pm.media, '[]'::json) AS media,
            COALESCE(lc.like_count, 0)::int AS like_count,
            COALESCE(cc.comment_count, 0)::int AS comment_count,
            (SELECT COUNT(*) FROM posts sp_share WHERE sp_share.shared_post_id = p.post_id AND sp_share.is_active = TRUE AND (sp_share.is_removed IS FALSE OR sp_share.is_removed IS NULL))::int AS "rePostCount",
            (SELECT COUNT(*) FROM shares s WHERE s.entity_type IN ('post', 'article') AND s.entity_id = p.post_id::text)::int AS "sharePostCount",
            (
                SELECT COALESCE(comp_like.slug, u_like.account_name)
                FROM active_post_likes pl_sample
                LEFT JOIN active_users u_like ON u_like.user_id = pl_sample.user_id
                LEFT JOIN organizations comp_like ON comp_like.org_id = pl_sample.org_id
                WHERE pl_sample.post_id = p.post_id
                AND ($${userParamIdx}::uuid IS NULL OR pl_sample.user_id != $${userParamIdx}::uuid)
                ORDER BY pl_sample.created_at DESC
                LIMIT 1
            ) AS sample_liker_username,
            EXISTS(
                SELECT 1 FROM active_post_likes pl WHERE pl.post_id = p.post_id AND (
                    ($${orgActorParamIdx}::uuid IS NOT NULL AND pl.org_id = $${orgActorParamIdx}::uuid) OR ($${orgActorParamIdx}::uuid IS NULL AND pl.user_id = $${userParamIdx} AND pl.org_id IS NULL)
                )
            ) AS is_liked,
            EXISTS(
                SELECT 1 FROM posts sp_rep
                WHERE sp_rep.shared_post_id = p.post_id
                AND (
                    ($${orgActorParamIdx}::uuid IS NOT NULL AND sp_rep.author_org_id = $${orgActorParamIdx}::uuid) OR ($${orgActorParamIdx}::uuid IS NULL AND sp_rep.author_id = $${userParamIdx} AND sp_rep.author_org_id IS NULL)
                )
                AND sp_rep.is_active = TRUE
                AND (sp_rep.is_removed IS FALSE OR sp_rep.is_removed IS NULL)
            ) AS is_reposted,
        EXISTS(
                SELECT 1 FROM posts sp_rep
                WHERE sp_rep.shared_post_id = p.post_id
                AND (
                    ($${orgActorParamIdx}::uuid IS NOT NULL AND sp_rep.author_org_id = $${orgActorParamIdx}::uuid) OR ($${orgActorParamIdx}::uuid IS NULL AND sp_rep.author_id = $${userParamIdx} AND sp_rep.author_org_id IS NULL)
                )
                AND sp_rep.is_active = TRUE
                AND (sp_rep.is_removed IS FALSE OR sp_rep.is_removed IS NULL)
            AND sp_rep.content IS NOT NULL AND TRIM(sp_rep.content) != ''
        ) AS is_reposted_with_thoughts,
            (
                SELECT sp_rep.post_id FROM posts sp_rep
                WHERE sp_rep.shared_post_id = p.post_id
                AND (
                    ($${orgActorParamIdx}::uuid IS NOT NULL AND sp_rep.author_org_id = $${orgActorParamIdx}::uuid) OR ($${orgActorParamIdx}::uuid IS NULL AND sp_rep.author_id = $${userParamIdx} AND sp_rep.author_org_id IS NULL)
                )
                AND sp_rep.is_active = TRUE
                AND (sp_rep.is_removed IS FALSE OR sp_rep.is_removed IS NULL)
                LIMIT 1
            ) AS repost_id,
            (
                SELECT COALESCE(
                    json_agg(json_build_object(
                        'username', COALESCE(comp_like.slug, u_like.account_name),
                        'avatar_url', COALESCE(comp_like.logo_url, u_like.avatar_url)
                    )),
                    '[]'::json
                )
                FROM (
                    SELECT pl_sample.user_id, pl_sample.org_id
                    FROM active_post_likes pl_sample
                    WHERE pl_sample.post_id = p.post_id
                      AND pl_sample.user_id IS NOT NULL
                      AND pl_sample.user_id != $${userParamIdx}::uuid
                    ORDER BY pl_sample.created_at DESC
                    LIMIT 3
                ) sub
                LEFT JOIN active_users u_like ON u_like.user_id = sub.user_id
                LEFT JOIN organizations comp_like ON comp_like.org_id = sub.org_id
            ) AS liked_users,

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
                        'location', sp.location,
                        'created_at', sp.created_at,
                        'author', json_build_object(
                             'user_id', COALESCE(sp.author_org_id, sp_u.user_id),
                             'full_name', COALESCE(sp_comp.name, sp_u.full_name),
                             'avatar_url', COALESCE(sp_comp.logo_url, sp_u.avatar_url),
                             'author_slug', COALESCE(sp_comp.slug, sp_u.account_name),
                             'author_headline', CASE WHEN sp.author_org_id IS NOT NULL THEN sp_comp.headline ELSE sp_u.headline END,
                             'is_organization_post', (sp.author_org_id IS NOT NULL)
                        ),
                        'media', COALESCE(sp_media.media, '[]'::json),
                        'like_count', (SELECT COUNT(*) FROM active_post_likes pl WHERE pl.post_id = sp.post_id)::int,
                        'comment_count', (SELECT COUNT(*) FROM active_post_comments pc WHERE pc.post_id = sp.post_id)::int,
                        'rePostCount', (SELECT COUNT(*) FROM posts sp_share2 WHERE sp_share2.shared_post_id = sp.post_id AND sp_share2.is_active = TRUE AND (sp_share2.is_removed IS FALSE OR sp_share2.is_removed IS NULL))::int,
                        'sharePostCount', (SELECT COUNT(*) FROM shares s WHERE s.entity_type IN ('post', 'article') AND s.entity_id = sp.post_id::text)::int,
                        'is_liked', EXISTS(
                            SELECT 1 FROM active_post_likes pl WHERE pl.post_id = sp.post_id AND (
                                ($${orgActorParamIdx}::uuid IS NOT NULL AND pl.org_id = $${orgActorParamIdx}::uuid) OR ($${orgActorParamIdx}::uuid IS NULL AND pl.user_id = $${userParamIdx} AND pl.org_id IS NULL)
                            )
                        ),
                        'is_reposted', EXISTS(
                            SELECT 1 FROM posts sp_rep
                            WHERE sp_rep.shared_post_id = sp.post_id
                            AND (
                                ($${orgActorParamIdx}::uuid IS NOT NULL AND sp_rep.author_org_id = $${orgActorParamIdx}::uuid) OR ($${orgActorParamIdx}::uuid IS NULL AND sp_rep.author_id = $${userParamIdx} AND sp_rep.author_org_id IS NULL)
                            )
                            AND sp_rep.is_active = TRUE
                            AND (sp_rep.is_removed IS FALSE OR sp_rep.is_removed IS NULL)
                        ),
              'is_reposted_with_thoughts', EXISTS(
                            SELECT 1 FROM posts sp_rep
                            WHERE sp_rep.shared_post_id = sp.post_id
                            AND (
                                ($${orgActorParamIdx}::uuid IS NOT NULL AND sp_rep.author_org_id = $${orgActorParamIdx}::uuid) OR ($${orgActorParamIdx}::uuid IS NULL AND sp_rep.author_id = $${userParamIdx} AND sp_rep.author_org_id IS NULL)
                            )
                            AND sp_rep.is_active = TRUE
                            AND (sp_rep.is_removed IS FALSE OR sp_rep.is_removed IS NULL)
                        AND sp_rep.content IS NOT NULL AND TRIM(sp_rep.content) != ''
              ),
                        'repost_id', (
                            SELECT sp_rep.post_id FROM posts sp_rep
                            WHERE sp_rep.shared_post_id = sp.post_id
                            AND (
                                ($${orgActorParamIdx}::uuid IS NOT NULL AND sp_rep.author_org_id = $${orgActorParamIdx}::uuid) OR ($${orgActorParamIdx}::uuid IS NULL AND sp_rep.author_id = $${userParamIdx} AND sp_rep.author_org_id IS NULL)
                            )
                            AND sp_rep.is_active = TRUE
                            AND (sp_rep.is_removed IS FALSE OR sp_rep.is_removed IS NULL)
                            LIMIT 1
                        ),
                        'liked_users', (
                            SELECT COALESCE(
                                json_agg(json_build_object(
                                    'username', COALESCE(comp_like.slug, u_like.account_name),
                                    'avatar_url', COALESCE(comp_like.logo_url, u_like.avatar_url)
                                )),
                                '[]'::json
                            )
                            FROM (
                                SELECT pl_sample.user_id, pl_sample.org_id
                                FROM active_post_likes pl_sample
                                WHERE pl_sample.post_id = sp.post_id
                                  AND pl_sample.user_id IS NOT NULL
                                  AND pl_sample.user_id != $${userParamIdx}::uuid
                                ORDER BY pl_sample.created_at DESC
                                LIMIT 3
                            ) sub
                            LEFT JOIN active_users u_like ON u_like.user_id = sub.user_id
                            LEFT JOIN organizations comp_like ON comp_like.org_id = sub.org_id
                        )
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
            SELECT post_id, COUNT(*) AS like_count FROM active_post_likes GROUP BY post_id
        ) lc ON lc.post_id = p.post_id

        -- Comments
        LEFT JOIN (
            SELECT post_id, COUNT(*) AS comment_count FROM active_post_comments GROUP BY post_id
        ) cc ON cc.post_id = p.post_id

        -- Polls
        LEFT JOIN (
             SELECT pp.post_id, json_build_object(
                'poll_id', pp.poll_id,
                'duration', COALESCE(pp.duration, '1 day'),
                'total_votes', COALESCE(pv.total_votes, 0),
                'user_vote', (
                    SELECT pv_u.option_id FROM poll_votes pv_u WHERE pv_u.poll_id = pp.poll_id AND (
                        ($${orgActorParamIdx}::uuid IS NOT NULL AND pv_u.org_id = $${orgActorParamIdx}::uuid) OR ($${orgActorParamIdx}::uuid IS NULL AND pv_u.voter_id = $${userParamIdx} AND pv_u.org_id IS NULL)
                    ) LIMIT 1
                ),
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
        
        ${whereClause} AND (p.is_removed IS FALSE OR p.is_removed IS NULL) AND p.is_active = TRUE
        ORDER BY p.created_at DESC, p.post_id DESC
        LIMIT $${idx}
        `;

        const { rows } = await pool.query(query, params);
        const last = rows[rows.length - 1];

        const hydratedRows = await hydrateShareCounts(rows);

        res.json({
            posts: hydratedRows,
            nextCursor: last ? { cursorCreatedAt: last.created_at, cursorPostId: last.post_id } : null
        });

    } catch (err) {
        console.error("Get organization posts error:", err);
        res.status(500).json({ message: "Internal server error", error: err.message });
    }
};
