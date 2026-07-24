/**
 * Core SQL query components to hydrate a Post response.
 * Used to keep Public Feed and Hashtag Feed consistent.
 */

const getPostHydrationSelect = (companyParamIdx, userParamIdx) => `
    p.post_id,
    CASE WHEN p.post_type IN ('article', 'poll') THEN p.title ELSE NULL END AS title,
    p.content,
    p.created_at,
    p.visibility,
    p.post_type,

    COALESCE(p.author_org_id, u.user_id) AS author_id,
    COALESCE(comp.name, u.full_name) AS author_name,
    COALESCE(comp.logo_url, u.avatar_url) AS author_avatar,
    COALESCE(comp.slug, u.account_name) AS author_slug,
    COALESCE(comp.slogan, u.headline) AS author_headline,
    (p.author_org_id IS NOT NULL) AS is_organization_post,
    (comp.entity_type = 'INSTITUTION') AS is_institution_post,
    CASE 
        WHEN p.is_broadcast = TRUE AND (
            -- Viewer is the author org
            ($${companyParamIdx}::uuid IS NOT NULL AND p.author_org_id = $${companyParamIdx}::uuid)
            OR
            -- Viewer is an org and is a child of the author org
            ($${companyParamIdx}::uuid IS NOT NULL AND EXISTS (SELECT 1 FROM organizations child WHERE child.org_id = $${companyParamIdx}::uuid AND child.parent_org_id = p.author_org_id))
            OR
            -- Viewer is a user and is a member of the author org or child org
            ($${companyParamIdx}::uuid IS NULL AND EXISTS (
                SELECT 1 FROM organization_members om 
                JOIN organizations o ON o.org_id = om.org_id
                WHERE om.user_id = $${userParamIdx} AND om.status = 'ACTIVE'
                  AND (o.org_id = p.author_org_id OR o.parent_org_id = p.author_org_id)
            ))
        ) THEN TRUE 
        ELSE FALSE 
    END AS is_broadcast,

    pc.name AS category_name,
    p.location,
    p.achievement_image_id,
    ai.key AS achievement_image_key,
    ai.cloudinary_url AS achievement_image_url,
    COALESCE(ai.title, CASE WHEN pc.name = 'Achievement' AND p.post_type = 'image' THEN p.title ELSE NULL END) AS achievement_image_title,

    COALESCE(
        (SELECT json_agg(json_build_object(
            'id', u.user_id,
            'full_name', u.full_name,
            'account_name', u.account_name,
            'avatar_url', u.avatar_url
         ))
         FROM post_tags pt 
          JOIN active_users u ON pt.tagged_user_id = u.user_id
         WHERE pt.post_id = p.post_id AND pt.is_active_tag = true),
        '[]'::json
    ) AS tags,

    COALESCE(
        (SELECT json_agg(json_build_object('url', pm.url, 'media_type', pm.media_type)) 
         FROM post_media pm WHERE pm.post_id = p.post_id),
        '[]'::json
    ) AS media,

    (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.post_id)::int AS like_count,
    (
        SELECT COALESCE(comp_like.slug, u_like.account_name)
        FROM post_likes pl_sample
         LEFT JOIN active_users u_like ON u_like.user_id = pl_sample.user_id
        LEFT JOIN organizations comp_like ON comp_like.org_id = pl_sample.org_id
        WHERE pl_sample.post_id = p.post_id
        AND NOT (
            ($${companyParamIdx}::uuid IS NOT NULL AND pl_sample.org_id = $${companyParamIdx}::uuid)
            OR
            ($${companyParamIdx}::uuid IS NULL AND pl_sample.user_id = $${userParamIdx} AND pl_sample.org_id IS NULL)
        )
        ORDER BY 
            (
                $${userParamIdx}::uuid IS NOT NULL AND 
                (
                    (pl_sample.user_id IS NOT NULL AND EXISTS (
                        SELECT 1 FROM followers f 
                        WHERE f.follower_id = $${userParamIdx} AND f.following_id = pl_sample.user_id
                    ))
                    OR 
                    (pl_sample.org_id IS NOT NULL AND EXISTS (
                        SELECT 1 FROM organization_followers ofol 
                        WHERE ofol.user_id = $${userParamIdx} AND ofol.org_id = pl_sample.org_id
                    ))
                )
            ) DESC,
            pl_sample.created_at DESC
        LIMIT 1
    ) AS sample_liker_username,
    (SELECT COUNT(*) FROM post_comments pc WHERE pc.post_id = p.post_id)::int AS comment_count,
    (SELECT COUNT(*) FROM saved_post sp_cnt WHERE sp_cnt.post_id = p.post_id)::int AS save_count,
    (SELECT COUNT(*) FROM posts sp_share WHERE sp_share.shared_post_id = p.post_id)::int AS share_count,

    (
        EXISTS(
            SELECT 1 FROM post_likes pl 
            WHERE pl.post_id = p.post_id 
            AND (
                ($${companyParamIdx}::uuid IS NOT NULL AND pl.org_id = $${companyParamIdx}::uuid)
                OR
                ($${companyParamIdx}::uuid IS NULL AND pl.user_id = $${userParamIdx} AND pl.org_id IS NULL)
            )
        )
    ) AS is_liked,

    (
        EXISTS(
            SELECT 1 FROM posts sp_rep
            WHERE sp_rep.shared_post_id = p.post_id 
            AND (
                ($${companyParamIdx}::uuid IS NOT NULL AND sp_rep.author_org_id = $${companyParamIdx}::uuid)
                OR
                ($${companyParamIdx}::uuid IS NULL AND sp_rep.author_id = $${userParamIdx} AND sp_rep.author_org_id IS NULL)
            )
            AND (sp_rep.is_removed IS FALSE OR sp_rep.is_removed IS NULL)
        )
    ) AS is_reposted,

    (
        SELECT sp_rep.post_id FROM posts sp_rep
        WHERE sp_rep.shared_post_id = p.post_id 
        AND (
            ($${companyParamIdx}::uuid IS NOT NULL AND sp_rep.author_org_id = $${companyParamIdx}::uuid)
            OR
            ($${companyParamIdx}::uuid IS NULL AND sp_rep.author_id = $${userParamIdx} AND sp_rep.author_org_id IS NULL)
        )
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
            FROM post_likes pl_sample
            WHERE pl_sample.post_id = p.post_id
              AND pl_sample.user_id IS NOT NULL
              AND NOT (
                  ($${companyParamIdx}::uuid IS NOT NULL AND pl_sample.org_id = $${companyParamIdx}::uuid)
                  OR
                  ($${companyParamIdx}::uuid IS NULL AND pl_sample.user_id = $${userParamIdx}::uuid AND pl_sample.org_id IS NULL)
              )
            ORDER BY pl_sample.created_at DESC
            LIMIT 3
        ) sub
        LEFT JOIN active_users u_like ON u_like.user_id = sub.user_id
        LEFT JOIN organizations comp_like ON comp_like.org_id = sub.org_id
    ) AS liked_users,

    (
        EXISTS(
            SELECT 1 FROM post_comments pc_me 
            WHERE pc_me.post_id = p.post_id 
            AND (
                ($${companyParamIdx}::uuid IS NOT NULL AND pc_me.author_org_id = $${companyParamIdx}::uuid)
                OR
                ($${companyParamIdx}::uuid IS NULL AND pc_me.author_id = $${userParamIdx} AND pc_me.author_org_id IS NULL)
            )
        )
    ) AS is_commented,

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
            'user_vote', (
                SELECT pv_u.option_id FROM poll_votes pv_u 
                WHERE pv_u.poll_id = pp.poll_id 
                AND (
                    ($${companyParamIdx}::uuid IS NOT NULL AND pv_u.org_id = $${companyParamIdx}::uuid)
                    OR
                    ($${companyParamIdx}::uuid IS NULL AND pv_u.voter_id = $${userParamIdx} AND pv_u.org_id IS NULL)
                )
                LIMIT 1
            ),
            'is_active', (pp.created_at + COALESCE(pp.duration, '1 day')::interval > NOW())
        )
        FROM post_polls pp WHERE pp.post_id = p.post_id
    ) AS poll,
    (
        SELECT json_build_object(
            'comment_id', pc_first.comment_id,
            'content', pc_first.content,
            'created_at', pc_first.created_at,
            'author_id', COALESCE(pc_first.author_org_id, u_first.user_id),
            'author_name', COALESCE(comp_first.name, u_first.full_name),
            'author_avatar', COALESCE(comp_first.logo_url, u_first.avatar_url),
            'author_title', u_first.headline
        )
        FROM post_comments pc_first
         JOIN active_users u_first ON u_first.user_id = pc_first.author_id
        LEFT JOIN organizations comp_first ON comp_first.org_id = pc_first.author_org_id
        WHERE pc_first.post_id = p.post_id AND pc_first.parent_id IS NULL
        ORDER BY pc_first.created_at ASC
        LIMIT 1
    ) AS first_comment,

    --Shared Post Data
    CASE 
        WHEN p.shared_job_id IS NOT NULL THEN
            json_build_object(
                 'is_accessible', true,
                 'job_id', sj.job_id,
                 'title', sj.title,
                 'company_name', sj.company_name,
                 'location', sj.location,
                 'job_type', sj.job_type,
                 'work_mode', sj.work_mode,
                 'salary_min', sj.salary_min,
                 'salary_max', sj.salary_max,
                 'company_logo', sj_comp.logo_url,
                 'created_at', sj.created_at,
                 'is_active', sj.is_active,
                 'company_slug', sj_comp.slug,
                 'shared_entity_type', 'job'
            )
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
                'title', CASE WHEN sp.post_type IN ('article', 'poll') THEN sp.title ELSE NULL END,
                'content', sp.content,
                'created_at', sp.created_at,
                'post_type', sp.post_type,
                'author', json_build_object(
                    'user_id', COALESCE(sp.author_org_id, sp_u.user_id),
                    'full_name', COALESCE(sp_comp.name, sp_u.full_name),
                    'avatar_url', COALESCE(sp_comp.logo_url, sp_u.avatar_url),
                    'author_headline', COALESCE(sp_comp.slogan, sp_u.headline),
                    'author_slug', COALESCE(sp_comp.slug, sp_u.account_name),
                    'is_organization_post', (sp.author_org_id IS NOT NULL)
                ),
                 'media', COALESCE((SELECT json_agg(json_build_object('url', pm.url, 'media_type', pm.media_type)) FROM post_media pm WHERE pm.post_id = sp.post_id), '[]'::json),
                 'achievement_image_url', sp_ai.cloudinary_url,
                 'like_count', (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = sp.post_id)::int,
                 'comment_count', (SELECT COUNT(*) FROM post_comments pc WHERE pc.post_id = sp.post_id)::int,
                 'share_count', (SELECT COUNT(*) FROM posts sp_share2 WHERE sp_share2.shared_post_id = sp.post_id)::int,
                 'is_liked', EXISTS(
                     SELECT 1 FROM post_likes pl 
                     WHERE pl.post_id = sp.post_id 
                     AND (
                         ($${companyParamIdx}::uuid IS NOT NULL AND pl.org_id = $${companyParamIdx}::uuid)
                         OR
                         ($${companyParamIdx}::uuid IS NULL AND pl.user_id = $${userParamIdx} AND pl.org_id IS NULL)
                     )
                 ),
                 'is_commented', EXISTS(
                     SELECT 1 FROM post_comments pc_c 
                     WHERE pc_c.post_id = sp.post_id 
                     AND (
                         ($${companyParamIdx}::uuid IS NOT NULL AND pc_c.author_org_id = $${companyParamIdx}::uuid)
                         OR
                         ($${companyParamIdx}::uuid IS NULL AND pc_c.author_id = $${userParamIdx} AND pc_c.author_org_id IS NULL)
                     )
                 ),
                 'is_saved', EXISTS(SELECT 1 FROM saved_post sp_s WHERE sp_s.post_id = sp.post_id AND sp_s.user_id = $${userParamIdx}),
                'poll', (
                    SELECT json_build_object(
                        'poll_id', pp.poll_id,
                        'duration', COALESCE(pp.duration, '1 day'),
                        'total_votes', (SELECT COUNT(*) FROM poll_votes pv WHERE pv.poll_id = pp.poll_id)::int,
                        'user_vote', (
                            SELECT pv_u.option_id FROM poll_votes pv_u 
                            WHERE pv_u.poll_id = pp.poll_id 
                            AND (
                                ($${companyParamIdx}::uuid IS NOT NULL AND pv_u.org_id = $${companyParamIdx}::uuid)
                                OR
                                ($${companyParamIdx}::uuid IS NULL AND pv_u.voter_id = $${userParamIdx} AND pv_u.org_id IS NULL)
                            )
                            LIMIT 1
                        ),
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
`;

const getPostHydrationJoins = () => `
    FROM posts p
     JOIN active_users u ON u.user_id = p.author_id
    LEFT JOIN organizations comp ON comp.org_id = p.author_org_id
    LEFT JOIN post_categories pc ON pc.category_id = p.category_id
    LEFT JOIN achievement_images ai ON ai.id = p.achievement_image_id

    -- Shared Post Joins
    LEFT JOIN posts sp ON p.shared_post_id = sp.post_id
     LEFT JOIN active_users sp_u ON sp.author_id = sp_u.user_id
    LEFT JOIN organizations sp_comp ON sp_comp.org_id = sp.author_org_id
    LEFT JOIN post_categories sp_cat ON sp.category_id = sp_cat.category_id
    LEFT JOIN achievement_images sp_ai ON sp_ai.id = sp.achievement_image_id
    LEFT JOIN jobs sj ON p.shared_job_id = sj.job_id
    LEFT JOIN organizations sj_comp ON sj.org_id = sj_comp.org_id
`;

const getPublicFeedWhere = (userParamIdx) => `
    WHERE (
        -- 1. Normal public posts (unchanged)
        (p.visibility = 'public' AND (p.is_broadcast IS FALSE OR p.is_broadcast IS NULL))
        OR
        -- 2. Broadcasts: visible to MEMBERS of child orgs (high-trust relationship)
        (
            p.is_broadcast = TRUE
            AND p.broadcast_scope = 'CHILDREN'
            AND p.author_org_id IN (
                SELECT o.parent_org_id
                FROM organizations o
                JOIN organization_members om ON om.org_id = o.org_id
                WHERE om.user_id = $${userParamIdx}
                  AND om.status = 'ACTIVE'
                  AND o.parent_org_id IS NOT NULL
            )
        )
        OR
        -- 3. Broadcasts: visible to FOLLOWERS of child orgs (discovery — 1 level only)
        (
            p.is_broadcast = TRUE
            AND p.broadcast_scope = 'CHILDREN'
            AND p.author_org_id IN (
                SELECT o.parent_org_id
                FROM organizations o
                JOIN organization_followers of_rel ON of_rel.org_id = o.org_id
                WHERE of_rel.user_id = $${userParamIdx}
                  AND o.parent_org_id IS NOT NULL
            )
        )
    )
    AND (p.is_removed IS FALSE OR p.is_removed IS NULL)
    AND p.is_active = TRUE
    AND p.is_community_article IS NOT TRUE
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
`;

module.exports = {
    getPostHydrationSelect,
    getPostHydrationJoins,
    getPublicFeedWhere,
};
