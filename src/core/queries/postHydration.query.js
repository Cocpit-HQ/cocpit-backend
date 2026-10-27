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
    p.is_unlisted,
    (SELECT status FROM post_appeals pa WHERE pa.post_id = p.post_id ORDER BY created_at DESC LIMIT 1) AS appeal_status,

    COALESCE(p.author_org_id, u.user_id) AS author_id,
    p.author_org_id AS author_org_id,
    p.author_id AS created_by_user_id,
    COALESCE(comp.name, u.full_name) AS author_name,
    CASE WHEN p.author_org_id IS NOT NULL THEN comp.logo_url ELSE u.avatar_url END AS author_avatar,
    COALESCE(comp.slug, u.account_name) AS author_slug,
    CASE WHEN p.author_org_id IS NOT NULL THEN comp.headline ELSE u.headline END AS author_headline,
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
            'id', COALESCE(u.user_id, o.org_id, pt.tagged_user_id),
            'full_name', CASE WHEN u.is_deactivated = TRUE OR (u.user_id IS NULL AND o.org_id IS NULL) THEN 'Unknown User' ELSE COALESCE(u.full_name, o.name) END,
            'account_name', CASE WHEN u.is_deactivated = TRUE OR (u.user_id IS NULL AND o.org_id IS NULL) THEN NULL ELSE COALESCE(u.account_name, o.slug) END,
            'avatar_url', CASE WHEN u.is_deactivated = TRUE OR (u.user_id IS NULL AND o.org_id IS NULL) THEN NULL ELSE COALESCE(u.avatar_url, o.logo_url) END,
            'type', CASE WHEN o.org_id IS NOT NULL THEN 'company' ELSE 'user' END
         ) ORDER BY (CASE WHEN u.is_deactivated = TRUE OR (u.user_id IS NULL AND o.org_id IS NULL) THEN 1 ELSE 0 END) ASC)
         FROM post_tags pt 
         LEFT JOIN active_users u ON pt.tagged_user_id = u.user_id
         LEFT JOIN organizations o ON pt.tagged_user_id = o.org_id AND o.is_deleted = FALSE
         WHERE pt.post_id = p.post_id 
           AND pt.is_active_tag = true),
        '[]'::json
    ) AS tags,

    (
        SELECT COALESCE(json_agg(json_build_object(
            'user_id', COALESCE(u_mention.user_id, o_mention.org_id),
            'full_name', COALESCE(u_mention.full_name, o_mention.name),
            'account_name', COALESCE(u_mention.account_name, o_mention.slug)
        )), '[]'::json)
        FROM (
            SELECT DISTINCT (regexp_matches(COALESCE(p.content, ''), '@\\[[^\\]]+\\]\\(([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\\)', 'g'))[1]::uuid AS mentioned_id
        ) mentions
        LEFT JOIN active_users u_mention ON u_mention.user_id = mentions.mentioned_id
        LEFT JOIN organizations o_mention ON o_mention.org_id = mentions.mentioned_id AND o_mention.is_deleted = FALSE
        WHERE u_mention.user_id IS NOT NULL OR o_mention.org_id IS NOT NULL
    ) AS mentioned_users,

    COALESCE(
        (SELECT json_agg(json_build_object('media_id', pm.media_id, 'url', pm.url, 'master_url', pm.master_url, 'media_type', pm.media_type, 'width', pm.width, 'height', pm.height, 'fallback_url', pm.fallback_url, 'avif_url', pm.avif_url, 'processing_status', pm.processing_status, 'stream_uid', pm.stream_uid, 'stream_hls_url', pm.stream_hls_url, 'stream_dash_url', pm.stream_dash_url, 'stream_thumbnail_url', pm.stream_thumbnail_url, 'hdr_manifest_url', pm.hdr_manifest_url, 'hdr_processing_status', pm.hdr_processing_status))
         FROM post_media pm WHERE pm.post_id = p.post_id),
        '[]'::json
    ) AS media,

    (SELECT COUNT(*) FROM active_post_likes pl WHERE pl.post_id = p.post_id)::int AS like_count,
    (
        -- Resolve human-readable display name for the sample liker preview:
        -- Use company name if liked by an organization, otherwise fall back to user's full name (instead of slugs/handles)
        SELECT COALESCE(comp_like.name, u_like.full_name)
        FROM active_post_likes pl_sample
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
    (SELECT COUNT(*) FROM active_post_comments pc WHERE pc.post_id = p.post_id)::int AS comment_count,
    (SELECT COUNT(*) FROM saved_post sp_cnt WHERE sp_cnt.post_id = p.post_id)::int AS save_count,
    (SELECT COUNT(*) FROM posts sp_share WHERE sp_share.shared_post_id = p.post_id AND sp_share.is_active = TRUE AND (sp_share.is_removed IS FALSE OR sp_share.is_removed IS NULL))::int AS "rePostCount",
    (SELECT COUNT(*) FROM shares s WHERE s.entity_type IN ('post', 'article') AND s.entity_id = p.post_id::text)::int AS "sharePostCount",

    (
        EXISTS(
            SELECT 1 FROM active_post_likes pl 
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
            AND sp_rep.is_active = TRUE
            AND (sp_rep.is_removed IS FALSE OR sp_rep.is_removed IS NULL)
        )
    ) AS is_reposted,

    (
        EXISTS(
            SELECT 1 FROM posts sp_rep
            WHERE sp_rep.shared_post_id = p.post_id 
            AND (
                ($${companyParamIdx}::uuid IS NOT NULL AND sp_rep.author_org_id = $${companyParamIdx}::uuid)
                OR
                ($${companyParamIdx}::uuid IS NULL AND sp_rep.author_id = $${userParamIdx} AND sp_rep.author_org_id IS NULL)
            )
            AND sp_rep.is_active = TRUE
            AND (sp_rep.is_removed IS FALSE OR sp_rep.is_removed IS NULL)
            AND sp_rep.content IS NOT NULL AND TRIM(sp_rep.content) != ''
        )
    ) AS is_reposted_with_thoughts,

    (
        SELECT sp_rep.post_id FROM posts sp_rep
        WHERE sp_rep.shared_post_id = p.post_id 
        AND (
            ($${companyParamIdx}::uuid IS NOT NULL AND sp_rep.author_org_id = $${companyParamIdx}::uuid)
            OR
            ($${companyParamIdx}::uuid IS NULL AND sp_rep.author_id = $${userParamIdx} AND sp_rep.author_org_id IS NULL)
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
            SELECT 1 FROM active_post_comments pc_me 
            WHERE pc_me.post_id = p.post_id 
            AND (
                ($${companyParamIdx}::uuid IS NOT NULL AND pc_me.author_org_id = $${companyParamIdx}::uuid)
                OR
                ($${companyParamIdx}::uuid IS NULL AND pc_me.author_id = $${userParamIdx} AND pc_me.author_org_id IS NULL)
            )
        )
    ) AS is_commented,

    (
        EXISTS(
            SELECT 1 FROM saved_post sp_me 
            WHERE sp_me.post_id = p.post_id 
            AND (
                ($${companyParamIdx}::uuid IS NOT NULL AND sp_me.org_id = $${companyParamIdx}::uuid)
                OR
                ($${companyParamIdx}::uuid IS NULL AND sp_me.user_id = $${userParamIdx} AND sp_me.org_id IS NULL)
            )
        )
    ) AS is_saved,

    (
        EXISTS(
            SELECT 1 FROM reports r_rep 
            WHERE r_rep.target_type = 'POST' 
            AND (
                r_rep.target_id = p.post_id 
                OR (
                    p.shared_post_id IS NOT NULL 
                    AND r_rep.target_id = p.shared_post_id
                )
                OR (
                    EXISTS (
                        SELECT 1 FROM posts rp 
                        WHERE rp.post_id = r_rep.target_id 
                          AND rp.shared_post_id = COALESCE(p.shared_post_id, p.post_id)
                          AND (rp.content IS NULL OR TRIM(regexp_replace(rp.content, '<[^>]+>|&nbsp;|\u200B|\u00A0|&#8203;|&#160;|&zwnj;', '', 'gi')) = '')
                    )
                )
            )
            AND (
                ($${companyParamIdx}::uuid IS NOT NULL AND r_rep.reporter_org_id = $${companyParamIdx}::uuid)
                OR
                ($${companyParamIdx}::uuid IS NULL AND r_rep.reporter_id = $${userParamIdx} AND r_rep.reporter_org_id IS NULL)
            )
        )
    ) AS is_reported,

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
            'author_avatar', CASE WHEN pc_first.author_org_id IS NOT NULL THEN comp_first.logo_url ELSE u_first.avatar_url END,
            'author_title', u_first.headline
        )
        FROM active_post_comments pc_first
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
                'location', sp.location,
                'created_at', sp.created_at,
                'post_type', sp.post_type,
                'author', json_build_object(
                    'user_id', COALESCE(sp.author_org_id, sp_u.user_id),
                    'author_org_id', sp.author_org_id,
                    'created_by_user_id', sp.author_id,
                    'full_name', COALESCE(sp_comp.name, sp_u.full_name),
                    'avatar_url', COALESCE(sp_comp.logo_url, sp_u.avatar_url),
                    'author_headline', CASE WHEN sp.author_org_id IS NOT NULL THEN sp_comp.headline ELSE sp_u.headline END,
                    'author_slug', COALESCE(sp_comp.slug, sp_u.account_name),
                    'is_organization_post', (sp.author_org_id IS NOT NULL)
                ),
                 'shared_post_data', CASE
                     WHEN sp.shared_job_id IS NOT NULL THEN (
                         SELECT json_build_object(
                             'is_accessible', true,
                             'job_id', sj_sp.job_id,
                             'title', sj_sp.title,
                             'company_name', sj_sp.company_name,
                             'location', sj_sp.location,
                             'company_logo', sj_sp_comp.logo_url
                         )
                         FROM jobs sj_sp
                         LEFT JOIN organizations sj_sp_comp ON sj_sp.org_id = sj_sp_comp.org_id
                         WHERE sj_sp.job_id = sp.shared_job_id
                     )
                     WHEN sp.shared_post_id IS NOT NULL THEN (
                         SELECT json_build_object(
                             'is_accessible', true,
                             'post_id', sp_sp.post_id,
                             'content', sp_sp.content,
                             'created_at', sp_sp.created_at,
                             'post_type', sp_sp.post_type,
                             'title', sp_sp.title,
                             'author', json_build_object(
                                 'user_id', COALESCE(sp_sp.author_org_id, sp_sp_u.user_id),
                                 'full_name', COALESCE(sp_sp_comp.name, sp_sp_u.full_name),
                                 'avatar_url', COALESCE(sp_sp_comp.logo_url, sp_sp_u.avatar_url),
                                 'author_slug', COALESCE(sp_sp_comp.slug, sp_sp_u.account_name),
                                 'is_organization_post', (sp_sp.author_org_id IS NOT NULL)
                             ),
                             'media', COALESCE((SELECT json_agg(json_build_object('media_id', pm.media_id, 'url', pm.url, 'master_url', pm.master_url, 'media_type', pm.media_type, 'width', pm.width, 'height', pm.height, 'fallback_url', pm.fallback_url, 'avif_url', pm.avif_url, 'processing_status', pm.processing_status, 'stream_uid', pm.stream_uid, 'stream_hls_url', pm.stream_hls_url, 'stream_dash_url', pm.stream_dash_url, 'stream_thumbnail_url', pm.stream_thumbnail_url, 'hdr_manifest_url', pm.hdr_manifest_url, 'hdr_processing_status', pm.hdr_processing_status)) FROM post_media pm WHERE pm.post_id = sp_sp.post_id), '[]'::json)
                         )
                         FROM posts sp_sp
                         LEFT JOIN active_users sp_sp_u ON sp_sp_u.user_id = sp_sp.author_id
                         LEFT JOIN organizations sp_sp_comp ON sp_sp_comp.org_id = sp_sp.author_org_id
                         WHERE sp_sp.post_id = sp.shared_post_id
                     )
                     ELSE NULL
                 END,
                 'mentioned_users', (
                     SELECT COALESCE(json_agg(json_build_object(
                         'user_id', COALESCE(u_mention.user_id, o_mention.org_id),
                         'full_name', COALESCE(u_mention.full_name, o_mention.name),
                         'account_name', COALESCE(u_mention.account_name, o_mention.slug)
                     )), '[]'::json)
                     FROM (
                         SELECT DISTINCT (regexp_matches(COALESCE(sp.content, ''), '@\\[[^\\]]+\\]\\(([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\\)', 'g'))[1]::uuid AS mentioned_id
                     ) mentions
                     LEFT JOIN active_users u_mention ON u_mention.user_id = mentions.mentioned_id
                     LEFT JOIN organizations o_mention ON o_mention.org_id = mentions.mentioned_id AND o_mention.is_deleted = FALSE
                     WHERE u_mention.user_id IS NOT NULL OR o_mention.org_id IS NOT NULL
                 ),
                 'media', COALESCE((SELECT json_agg(json_build_object('media_id', pm.media_id, 'url', pm.url, 'master_url', pm.master_url, 'media_type', pm.media_type, 'width', pm.width, 'height', pm.height, 'fallback_url', pm.fallback_url, 'avif_url', pm.avif_url, 'processing_status', pm.processing_status, 'stream_uid', pm.stream_uid, 'stream_hls_url', pm.stream_hls_url, 'stream_dash_url', pm.stream_dash_url, 'stream_thumbnail_url', pm.stream_thumbnail_url, 'hdr_manifest_url', pm.hdr_manifest_url, 'hdr_processing_status', pm.hdr_processing_status)) FROM post_media pm WHERE pm.post_id = sp.post_id), '[]'::json),
                 'achievement_image_url', sp_ai.cloudinary_url,
                 'like_count', (SELECT COUNT(*) FROM active_post_likes pl WHERE pl.post_id = sp.post_id)::int,
                 'sample_liker_username', (
                     SELECT COALESCE(comp_like.name, u_like.full_name)
                     FROM active_post_likes pl_sample
                     LEFT JOIN active_users u_like ON u_like.user_id = pl_sample.user_id
                     LEFT JOIN organizations comp_like ON comp_like.org_id = pl_sample.org_id
                     WHERE pl_sample.post_id = sp.post_id
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
                 ),
                 'comment_count', (SELECT COUNT(*) FROM active_post_comments pc WHERE pc.post_id = sp.post_id)::int,
                 'rePostCount', (SELECT COUNT(*) FROM posts sp_share2 WHERE sp_share2.shared_post_id = sp.post_id AND sp_share2.is_active = TRUE AND (sp_share2.is_removed IS FALSE OR sp_share2.is_removed IS NULL))::int,
                 'sharePostCount', (SELECT COUNT(*) FROM shares s WHERE s.entity_type IN ('post', 'article') AND s.entity_id = sp.post_id::text)::int,
                 'is_liked', EXISTS(
                     SELECT 1 FROM active_post_likes pl 
                     WHERE pl.post_id = sp.post_id 
                     AND (
                         ($${companyParamIdx}::uuid IS NOT NULL AND pl.org_id = $${companyParamIdx}::uuid)
                         OR
                         ($${companyParamIdx}::uuid IS NULL AND pl.user_id = $${userParamIdx} AND pl.org_id IS NULL)
                     )
                 ),
                 'is_reposted', EXISTS(
                     SELECT 1 FROM posts sp_rep
                     WHERE sp_rep.shared_post_id = sp.post_id 
                     AND (
                         ($${companyParamIdx}::uuid IS NOT NULL AND sp_rep.author_org_id = $${companyParamIdx}::uuid)
                         OR
                         ($${companyParamIdx}::uuid IS NULL AND sp_rep.author_id = $${userParamIdx} AND sp_rep.author_org_id IS NULL)
                     )
                     AND sp_rep.is_active = TRUE
                     AND (sp_rep.is_removed IS FALSE OR sp_rep.is_removed IS NULL)
                 ),
                 'is_reposted_with_thoughts', EXISTS(
                     SELECT 1 FROM posts sp_rep
                     WHERE sp_rep.shared_post_id = sp.post_id 
                     AND (
                         ($${companyParamIdx}::uuid IS NOT NULL AND sp_rep.author_org_id = $${companyParamIdx}::uuid)
                         OR
                         ($${companyParamIdx}::uuid IS NULL AND sp_rep.author_id = $${userParamIdx} AND sp_rep.author_org_id IS NULL)
                     )
                     AND sp_rep.is_active = TRUE
                     AND (sp_rep.is_removed IS FALSE OR sp_rep.is_removed IS NULL)
                     AND sp_rep.content IS NOT NULL AND TRIM(sp_rep.content) != ''
                 ),
                 'repost_id', (
                     SELECT sp_rep.post_id FROM posts sp_rep
                     WHERE sp_rep.shared_post_id = sp.post_id 
                     AND (
                         ($${companyParamIdx}::uuid IS NOT NULL AND sp_rep.author_org_id = $${companyParamIdx}::uuid)
                         OR
                         ($${companyParamIdx}::uuid IS NULL AND sp_rep.author_id = $${userParamIdx} AND sp_rep.author_org_id IS NULL)
                     )
                     AND sp_rep.is_active = TRUE
                     AND (sp_rep.is_removed IS FALSE OR sp_rep.is_removed IS NULL)
                     LIMIT 1
                 ),
                 'is_commented', EXISTS(
                     SELECT 1 FROM active_post_comments pc_c 
                     WHERE pc_c.post_id = sp.post_id 
                     AND (
                         ($${companyParamIdx}::uuid IS NOT NULL AND pc_c.author_org_id = $${companyParamIdx}::uuid)
                         OR
                         ($${companyParamIdx}::uuid IS NULL AND pc_c.author_id = $${userParamIdx} AND pc_c.author_org_id IS NULL)
                     )
                 ),
                 'is_saved', EXISTS(
                     SELECT 1 FROM saved_post sp_s 
                     WHERE sp_s.post_id = sp.post_id 
                     AND (
                         ($${companyParamIdx}::uuid IS NOT NULL AND sp_s.org_id = $${companyParamIdx}::uuid)
                         OR
                         ($${companyParamIdx}::uuid IS NULL AND sp_s.user_id = $${userParamIdx} AND sp_s.org_id IS NULL)
                     )
                 ),
                 'is_reported', EXISTS(
                     SELECT 1 FROM reports r_rep 
                     WHERE r_rep.target_type = 'POST' 
                     AND (
                         r_rep.target_id = sp.post_id 
                         OR (
                             sp.shared_post_id IS NOT NULL 
                             AND r_rep.target_id = sp.shared_post_id
                         )
                         OR (
                             EXISTS (
                                 SELECT 1 FROM posts rp 
                                 WHERE rp.post_id = r_rep.target_id 
                                   AND rp.shared_post_id = COALESCE(sp.shared_post_id, sp.post_id)
                                   AND (rp.content IS NULL OR TRIM(regexp_replace(rp.content, '<[^>]+>|&nbsp;|\u200B|\u00A0|&#8203;|&#160;|&zwnj;', '', 'gi')) = '')
                             )
                         )
                     )
                     AND (
                         ($${companyParamIdx}::uuid IS NOT NULL AND r_rep.reporter_org_id = $${companyParamIdx}::uuid)
                         OR
                         ($${companyParamIdx}::uuid IS NULL AND r_rep.reporter_id = $${userParamIdx} AND r_rep.reporter_org_id IS NULL)
                     )
                 ),
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

const getPublicFeedWhere = (userParamIdx, companyParamIdx = null) => `
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
    AND NOT (p.post_type = 'article' AND p.author_org_id IS NOT NULL)
    AND (p.is_deleted IS FALSE OR p.is_deleted IS NULL)
    AND (p.is_unlisted IS FALSE OR p.is_unlisted IS NULL)
    AND (p.author_org_id IS NOT NULL OR (u.is_deactivated = FALSE AND (u.is_deleted IS NULL OR u.is_deleted = FALSE)))
    AND (p.author_org_id IS NULL OR (comp.is_deleted = FALSE AND comp.is_deactivated = FALSE))
    AND p.is_community_article IS NOT TRUE
    ${companyParamIdx ? `
    AND NOT EXISTS (
        SELECT 1 FROM blocks b
        WHERE (b.is_org_block = true AND p.author_org_id IS NULL AND ((b.blocker_id = $${companyParamIdx} AND b.blocked_id = p.author_id) OR (b.blocker_id = p.author_id AND b.blocked_id = $${companyParamIdx})))
           OR (b.is_org_block = true AND p.author_org_id IS NOT NULL AND ((b.blocker_id = p.author_org_id AND b.blocked_id = $${companyParamIdx}) OR (b.blocker_id = $${companyParamIdx} AND b.blocked_id = p.author_org_id)))
    )
    -- STRICT REPOST BLOCKING: Exclude repost if original author is blocked
    AND (
        p.shared_post_id IS NULL 
        OR NOT EXISTS (
            SELECT 1 FROM blocks b 
            WHERE (b.is_org_block = true AND sp.author_org_id IS NULL AND ((b.blocker_id = $${companyParamIdx} AND b.blocked_id = sp.author_id) OR (b.blocker_id = sp.author_id AND b.blocked_id = $${companyParamIdx})))
               OR (b.is_org_block = true AND sp.author_org_id IS NOT NULL AND ((b.blocker_id = sp.author_org_id AND b.blocked_id = $${companyParamIdx}) OR (b.blocker_id = $${companyParamIdx} AND b.blocked_id = sp.author_org_id)))
        )
    )
    ` : `
    AND NOT EXISTS (
        SELECT 1 FROM blocks b 
        WHERE (b.is_org_block = false AND p.author_org_id IS NULL AND ((b.blocker_id = $${userParamIdx} AND b.blocked_id = p.author_id) OR (b.blocker_id = p.author_id AND b.blocked_id = $${userParamIdx})))
           OR (b.is_org_block = true AND p.author_org_id IS NOT NULL AND ((b.blocker_id = p.author_org_id AND b.blocked_id = $${userParamIdx}) OR (b.blocker_id = $${userParamIdx} AND b.blocked_id = p.author_org_id)))
    )
    -- STRICT REPOST BLOCKING: Exclude repost if original author is blocked
    AND (
        p.shared_post_id IS NULL 
        OR NOT EXISTS (
            SELECT 1 FROM blocks b 
            WHERE (b.is_org_block = false AND sp.author_org_id IS NULL AND ((b.blocker_id = $${userParamIdx} AND b.blocked_id = sp.author_id) OR (b.blocker_id = sp.author_id AND b.blocked_id = $${userParamIdx})))
               OR (b.is_org_block = true AND sp.author_org_id IS NOT NULL AND ((b.blocker_id = sp.author_org_id AND b.blocked_id = $${userParamIdx}) OR (b.blocker_id = $${userParamIdx} AND b.blocked_id = sp.author_org_id)))
        )
    )
    `}
    AND (
        p.shared_post_id IS NULL 
        OR (
            (sp.author_org_id IS NOT NULL OR (sp_u.is_deactivated = FALSE AND (sp_u.is_deleted IS NULL OR sp_u.is_deleted = FALSE)))
            AND (sp.author_org_id IS NULL OR (sp_comp.is_deleted = FALSE AND sp_comp.is_deactivated = FALSE))
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
