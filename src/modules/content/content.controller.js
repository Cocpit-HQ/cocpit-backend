const { incrementUserHashtagScore } = require("../../services/recommendation.service");
const { ur, vi } = require("zod/locales");
const { sanitizeContent } = require("../../utils/contentSanitizer");
const { sanitizeArticleContent } = require("../../utils/articleContentSanitizer");
const pool = require("../../core/db/pool");
const socketService = require("../../core/infrastructure/socket.service");
const { checkBlockStatus } = require("../../core/utils/blockCheck");
const BlockModel = require("../../models/block.model");
const { logAudit } = require("../../core/infrastructure/audit.service");
const { r2Client, hasR2, bucketName, deleteR2Asset, deleteR2Assets } = require("../../core/infrastructure/r2.client");
const { checkOrgPermission } = require("../../core/utils/rbac");
const { notifyOrgFollowers, notifyBroadcastToChildOrgs } = require("../../services/notification.service");
const { logActivity, removeActivity } = require("../../core/services/activityLogger");
const { logActivity: logIntentActivity } = require("../../utils/activityLogger");
const { sendToUser: sendPush } = require("../notification/notification.service");
const contentGenerationService = require("../../services/contentGeneration.service");

const getRequestedOrganizationActorId = (req, fallbackOrgId = null) => {
    // 1. Prefer Explicit Actor Header Context
    const actorOrgId = req.actor?.type === "ORGANIZATION" ? req.actor.orgId : null;

    if (actorOrgId) {
        if (fallbackOrgId && actorOrgId !== fallbackOrgId) {
            const err = new Error("Active organization actor does not match requested organization");
            err.statusCode = 403;
            throw err;
        }
        return actorOrgId;
    }

    // 2. Fallback to Passed companyId - but verify membership
    if (fallbackOrgId) {
        const userOrgs = req.userOrganizations || [];
        if (!userOrgs.includes(fallbackOrgId)) {
            const err = new Error("You do not have permission to act as this organization");
            err.statusCode = 403;
            throw err;
        }
        return fallbackOrgId;
    }

    return null;
};

const getContentActorScope = (req, fallbackOrgId = null) => {
    const userId = req.user?.sub || req.user?.user_id;
    const orgId = getRequestedOrganizationActorId(req, fallbackOrgId);

    return {
        userId,
        orgId,
        isOrgActor: !!orgId,
    };
};

const getOptionalContentActorScope = (req, _fallbackOrgId = null) => {
    const userId = req.user?.sub || req.user?.user_id || null;

    if (!userId) {
        return {
            userId: null,
            orgId: null,
            isOrgActor: false,
        };
    }

    return getContentActorScope(req);
};

const broadcastChannelArticlePublished = async (orgId, article) => {
    try {
        // 1. Fetch organization details
        const orgRes = await pool.query(`SELECT name, logo_url FROM organizations WHERE org_id = $1`, [orgId]);
        if (orgRes.rows.length === 0) return;
        const orgName = orgRes.rows[0].name || "An organization";
        const orgLogo = orgRes.rows[0].logo_url || null;

        // 2. Fetch subscribers
        const subscribers = await pool.query(
            `SELECT cs.user_id FROM community_subscriptions cs
             JOIN communities c ON cs.community_id = c.community_id
             WHERE c.org_id = $1 AND cs.status = 'SUBSCRIBED'`,
            [orgId]
        );

        if (subscribers.rows.length === 0) return;

        const subscriberIds = subscribers.rows.map(sub => sub.user_id);
        const notificationText = `"${orgName}" posted: "${article.preview}"`;
        const notificationTitle = `New update from "${orgName}"`;

        // 3. Bulk Insert DB Notifications
        const insertQuery = `
            INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata, is_read, created_at)
            SELECT unnest($1::uuid[]), NULL, 'channel_article', $2, $3, $4::jsonb, false, NOW()
            RETURNING notification_id, user_id, created_at
        `;
        const insertValues = [
            subscriberIds,
            notificationText,
            article.id,
            JSON.stringify({ org_id: orgId })
        ];

        const insertRes = await pool.query(insertQuery, insertValues);

        // 4. Emit real-time sockets & push notifications
        for (const row of insertRes.rows) {
            // Socket emit
            socketService.notifyUser(row.user_id, "notification", {
                notification_id: row.notification_id,
                type: 'channel_article',
                text: notificationText,
                reference_id: article.id,
                is_read: false,
                created_at: row.created_at.toISOString(),
                actor_name: orgName,
                actor_avatar: orgLogo,
                is_company_actor: true,
                metadata: { org_id: orgId }
            });

            // Push notification
            sendPush(row.user_id, notificationTitle, notificationText, {
                type: 'channel_article',
                referenceId: article.id
            }).catch(() => {});
        }
    } catch (err) {
        console.error("Error broadcasting channel article publication:", err);
    }
};

const { getPostHydrationSelect, getPostHydrationJoins, getPublicFeedWhere } = require("../../core/queries/postHydration.query.js");
const { hydrateShareCounts } = require("../../utils/shareHydration");

// --- Feed / Posts ---
// ===========================================================================
// [CLEANUP - FEED REFACTOR] REASON FOR COMMENTING OUT:
// - Status: DEPRECATED
// - Technical Reason: Legacy unranked public feed query (~122 lines). It fetched
//   unranked public posts before the introduction of the Day 3 Feed Engine.
// - Active Replacement: Replaced entirely by GET /api/feed handled by
//   feed.controller.js and feed.service.js (providing caching, scoring, and diversity).
// ===========================================================================
/*
exports.getPublicFeed = async (req, res) => {
    const { cursorCreatedAt, cursorPostId, companyId: requestedCompanyId } = req.query;
    const limit = 10;

    try {
        const actorScope = getOptionalContentActorScope(req, requestedCompanyId || null);
        const params = [];
        let cursorCondition = "";

        // 1. Cursor Handling
        if (cursorCreatedAt && cursorPostId) {
            params.push(cursorCreatedAt, cursorPostId);
            // Since this is first, we know indices are $1 and $2
            cursorCondition = `AND (p.created_at, p.post_id) < ($${params.length - 1}, $${params.length})`;
        }

        // 2. Limit
        params.push(limit);
        const limitParamIdx = params.length;

        // 3. User ID and Company ID (needed for subqueries)
        const userId = actorScope.userId;

        params.push(userId);
        const userParamIdx = params.length;

        params.push(actorScope.orgId || null);
        const companyParamIdx = params.length;

        const query = `
        SELECT
            ${getPostHydrationSelect(companyParamIdx, userParamIdx)}
        ${getPostHydrationJoins()}
        ${getPublicFeedWhere(userParamIdx, companyParamIdx)}
        ${cursorCondition}
        ORDER BY p.created_at DESC, p.post_id DESC
        LIMIT $${limitParamIdx}
        `;

        const { rows } = await pool.query(query, params);
        // Recommendation System Phase 1 Integration: Inject 1 random suggested post on Page 1
        let finalRows = rows;
        try {
            if (!cursorPostId && actorScope.userId) {
                const redisClient = require("../../core/db/redis");
                const { getHashtagPostsInternal } = require("./hashtag.controller"); // We will export an internal getter

                if (redisClient.isOpen) {
                    const topTags = await redisClient.zRevRange(`user:${actorScope.userId}:interests`, 0, 4);
                    if (topTags && topTags.length > 0) {
                        // Rotation: pick 1 random tag
                        const randomTag = topTags[Math.floor(Math.random() * topTags.length)];

                        let suggestedPostIds = await redisClient.lRange(`feed:hashtag:${randomTag}`, 0, 0);

                        // Wait, DB fallback if Redis feed cache is missing
                        if (!suggestedPostIds || suggestedPostIds.length === 0) {
                            const { rows: dbFallback } = await pool.query(`
                                SELECT p.post_id FROM posts p 
                                JOIN post_hashtags ph ON p.post_id = ph.post_id 
                                JOIN hashtags h ON h.hashtag_id = ph.hashtag_id
                                WHERE h.tag = $1 ORDER BY p.created_at DESC LIMIT 1
                             `, [randomTag]);
                            suggestedPostIds = dbFallback.map(r => r.post_id);
                        }

                        if (suggestedPostIds.length > 0) {
                            // Rather than rewrite hashtag feed, let's just do a tiny exact match query
                            const { getPostHydrationSelect, getPostHydrationJoins, getPublicFeedWhere } = require("../../core/queries/postHydration.query");
                            const { rows: hydratedSuggestions } = await pool.query(`
                                SELECT ${getPostHydrationSelect(2, 1)}
                                ${getPostHydrationJoins()}
                                ${getPublicFeedWhere(1)}
                                AND p.post_id = ANY($3::uuid[])
                             `, [actorScope.userId, actorScope.orgId || null, suggestedPostIds]);

                            if (hydratedSuggestions && hydratedSuggestions.length > 0) {
                                const suggestion = hydratedSuggestions[0];
                                const isDuplicate = finalRows.some(p => p.post_id === suggestion.post_id);
                                if (!isDuplicate) {
                                    suggestion.is_suggested = true;
                                    suggestion.suggested_reason = `Because you follow #${randomTag}`;
                                    // Splice at index 3
                                    if (finalRows.length > 3) {
                                        finalRows.splice(3, 0, suggestion);
                                    } else {
                                        finalRows.push(suggestion);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        } catch (suggestionErr) {
            console.error("Feed suggestion error:", suggestionErr);
        }


        const last = rows[rows.length - 1];

        finalRows = await hydrateShareCounts(finalRows);
        res.json({
            posts: finalRows.map(post => {
                // If it's not an article or poll, completely remove the title key
                if (post.post_type !== 'article' && post.post_type !== 'poll') delete post.title;
                if (post.shared_post && post.shared_post.post_type !== 'article' && post.shared_post.post_type !== 'poll') delete post.shared_post.title;
                return post;
            }),
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
*/

exports.getMyPosts = async (req, res) => {
    const {
        category,
        filter,
        cursorCreatedAt,
        cursorPostId,
        limit = 10,
        companyId: requestedCompanyId,
        preview
    } = req.query;

    const isPreview = preview === 'true' || preview === true;

    try {
        const actorScope = getContentActorScope(req, requestedCompanyId || null);
        const { userId, orgId: companyId, isOrgActor } = actorScope;
        const params = [userId, companyId || null];
        const userParamIdx = 1;
        const orgParamIdx = 2;
        let idx = 3;
        let whereClause = "";
        if (filter === 'Comments') {
            whereClause = `WHERE EXISTS (SELECT 1 FROM active_post_comments pc_filter WHERE pc_filter.post_id = p.post_id AND ${isOrgActor ? `pc_filter.author_org_id = $${orgParamIdx}::uuid` : `pc_filter.author_id = $${userParamIdx} AND pc_filter.author_org_id IS NULL`}) AND p.is_active = TRUE AND (p.is_removed IS FALSE OR p.is_removed IS NULL)`;
        } else {
            whereClause = isOrgActor
                ? `WHERE p.author_org_id = $${orgParamIdx}::uuid AND p.is_active = TRUE AND (p.is_removed IS FALSE OR p.is_removed IS NULL)`
                : `WHERE p.author_id = $${userParamIdx} AND p.author_org_id IS NULL AND p.is_active = TRUE AND (p.is_removed IS FALSE OR p.is_removed IS NULL)`;
        }

        // ✅ Category filter (skip if "All")
        if (category && category !== "All") {
            whereClause += ` AND pc.name = $${idx} `;
            params.push(category);
            idx++;
        }

        if (filter) {
            if (filter === 'Post') {
                whereClause += ` AND p.shared_post_id IS NULL AND p.shared_job_id IS NULL `;
            } else if (filter === 'Repost') {
                whereClause += ` AND (p.shared_post_id IS NOT NULL OR p.shared_job_id IS NOT NULL) `;
            } else if (filter === 'Private post') {
                whereClause += ` AND p.visibility = 'private' `;
            } else if (filter === 'Articles' || filter === 'Article') {
                whereClause += ` AND (p.post_type = 'article' OR pc.name = 'Article' OR p.is_community_article = TRUE) AND p.shared_post_id IS NULL AND p.shared_job_id IS NULL `;
            } else if (filter === 'Video' || filter === 'Videos') {
                whereClause += ` AND (p.post_type = 'video' OR EXISTS (SELECT 1 FROM post_media pm WHERE pm.post_id = p.post_id AND pm.media_type = 'video')) AND p.shared_post_id IS NULL AND p.shared_job_id IS NULL `;
            } else if (filter === 'Poll' || filter === 'Polls') {
                whereClause += ` AND (p.post_type = 'poll' OR EXISTS (SELECT 1 FROM post_polls pp WHERE pp.post_id = p.post_id)) AND p.shared_post_id IS NULL AND p.shared_job_id IS NULL `;
            }
        }

        if (filter !== 'Private post') {
            whereClause += ` AND (p.visibility IS NULL OR p.visibility != 'private') `;
        }

        // ✅ Cursor-based pagination (stable)
        if (cursorCreatedAt && cursorPostId) {
            whereClause += `
        AND(p.created_at, p.post_id) < ($${idx}, $${idx + 1})
        `;
            params.push(cursorCreatedAt, cursorPostId);
            idx += 2;
        }

        // ✅ Strict Block Logic for Shared Posts
        whereClause += `
        ${isOrgActor ? `
        AND (
            p.shared_post_id IS NULL 
            OR NOT EXISTS (
                SELECT 1 FROM blocks b 
                WHERE (b.is_org_block = true AND sp.author_org_id IS NULL AND ((b.blocker_id = $${orgParamIdx} AND b.blocked_id = sp.author_id) OR (b.blocker_id = sp.author_id AND b.blocked_id = $${orgParamIdx})))
                   OR (b.is_org_block = true AND sp.author_org_id IS NOT NULL AND ((b.blocker_id = sp.author_org_id AND b.blocked_id = $${orgParamIdx}) OR (b.blocker_id = $${orgParamIdx} AND b.blocked_id = sp.author_org_id)))
            )
        )
        ` : `
        AND (
            p.shared_post_id IS NULL 
            OR NOT EXISTS (
                SELECT 1 FROM blocks b 
                WHERE (b.is_org_block = false AND sp.author_org_id IS NULL AND ((b.blocker_id = $${userParamIdx} AND b.blocked_id = sp.author_id) OR (b.blocker_id = sp.author_id AND b.blocked_id = $${userParamIdx})))
                   OR (b.is_org_block = true AND sp.author_org_id IS NOT NULL AND ((b.blocker_id = sp.author_org_id AND b.blocked_id = $${userParamIdx}) OR (b.blocker_id = $${userParamIdx} AND b.blocked_id = sp.author_org_id)))
                   OR (b.is_org_block = false AND sp.author_org_id IS NOT NULL AND (b.blocker_id = $${userParamIdx} AND b.blocked_id = sp.author_org_id))
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

        -- Exclude posts reported by the current user
        AND NOT EXISTS (
            SELECT 1 FROM reports r 
            WHERE r.target_type IN ('POST', 'ARTICLE', 'JOB', 'THOUGHT')
              AND (r.target_id = p.post_id OR r.target_id = p.shared_post_id OR r.target_id = p.shared_job_id)
              AND r.reporter_id = $${userParamIdx}::uuid
        )
        `;

        // If org actor, $1 is the org_id. We might need the userId for block checks if they are personal blocks,
        // but typically blocks are user-level. For now, assuming $1 is the actor.

        // ✅ LIMIT (provide a buffer for preview mode so frontend can filter hidden posts)
        params.push(isPreview ? Math.max(Number(limit) || 10, 10) : limit);

        const query = `
        SELECT
            ${getPostHydrationSelect(orgParamIdx, userParamIdx)}
        ${getPostHydrationJoins()}
        ${whereClause}
        ORDER BY
        ${isPreview ? `
            CASE
                -- Tier 1: Original media posts (image/video)
                WHEN p.shared_post_id IS NULL AND p.shared_job_id IS NULL
                     AND (
                         p.post_type::text IN ('video', 'image')
                         OR EXISTS (
                             SELECT 1 FROM post_media pm
                             WHERE pm.post_id = p.post_id
                               AND pm.media_type IN ('image', 'video')
                         )
                     )
                THEN 1

                -- Tier 2: Original text/article posts (no media, no poll)
                WHEN p.shared_post_id IS NULL AND p.shared_job_id IS NULL
                     AND NOT EXISTS (SELECT 1 FROM post_media pm WHERE pm.post_id = p.post_id)
                     AND NOT EXISTS (SELECT 1 FROM post_polls pp WHERE pp.post_id = p.post_id)
                     AND (p.post_type IS NULL OR p.post_type::text NOT IN ('poll', 'video', 'image'))
                THEN 2

                -- Tier 3: Reposts (shared post or shared job)
                WHEN (p.shared_post_id IS NOT NULL OR p.shared_job_id IS NOT NULL)
                THEN 3

                -- Tier 4: Polls
                WHEN (p.post_type::text = 'poll' OR EXISTS (SELECT 1 FROM post_polls pp WHERE pp.post_id = p.post_id))
                THEN 4

                ELSE 5
            END ASC,
        ` : ''}
        p.created_at DESC, p.post_id DESC
        LIMIT $${idx}
        `;

        const { rows } = await pool.query(query, params);
        // Recommendation System Phase 1 Integration: Inject 1 random suggested post on Page 1
        let finalRows = rows;
        // ===========================================================================
        // [CLEANUP - FEED REFACTOR] REASON FOR COMMENTING OUT:
        // - Status: IRRELEVANT / ERRONEOUS INJECTION
        // - Technical Reason: This block was erroneously injecting stranger hashtag-recommended
        //   posts into the user's personal profile posts list (getMyPosts).
        // - Active Replacement: Recommendations belong in the main home feed (/api/feed),
        //   while profile views must show strictly the user's/company's own authored posts.
        // ===========================================================================
        /*
        try {
            if (!cursorPostId && actorScope.userId) {
                const redisClient = require("../../core/db/redis");
                const { getHashtagPostsInternal } = require("./hashtag.controller"); // We will export an internal getter

                if (redisClient.isOpen) {
                    const topTags = await redisClient.zRevRange(`user:${actorScope.userId}:interests`, 0, 4);
                    if (topTags && topTags.length > 0) {
                        // Rotation: pick 1 random tag
                        const randomTag = topTags[Math.floor(Math.random() * topTags.length)];

                        let suggestedPostIds = await redisClient.lRange(`feed:hashtag:${randomTag}`, 0, 0);

                        // Wait, DB fallback if Redis feed cache is missing
                        if (!suggestedPostIds || suggestedPostIds.length === 0) {
                            const { rows: dbFallback } = await pool.query(`
                                SELECT p.post_id FROM posts p 
                                JOIN post_hashtags ph ON p.post_id = ph.post_id 
                                JOIN hashtags h ON h.hashtag_id = ph.hashtag_id
                                WHERE h.tag = $1 ORDER BY p.created_at DESC LIMIT 1
                             `, [randomTag]);
                            suggestedPostIds = dbFallback.map(r => r.post_id);
                        }

                        if (suggestedPostIds.length > 0) {
                            // Rather than rewrite hashtag feed, let's just do a tiny exact match query
                            const { getPostHydrationSelect, getPostHydrationJoins, getPublicFeedWhere } = require("../../core/queries/postHydration.query");
                            const { rows: hydratedSuggestions } = await pool.query(`
                                SELECT ${getPostHydrationSelect(2, 1)}
                                ${getPostHydrationJoins()}
                                ${getPublicFeedWhere(1)}
                                AND p.post_id = ANY($3::uuid[])
                             `, [actorScope.userId, actorScope.orgId || null, suggestedPostIds]);

                            if (hydratedSuggestions && hydratedSuggestions.length > 0) {
                                const suggestion = hydratedSuggestions[0];
                                const isDuplicate = finalRows.some(p => p.post_id === suggestion.post_id);
                                if (!isDuplicate) {
                                    suggestion.is_suggested = true;
                                    suggestion.suggested_reason = `Because you follow #${randomTag}`;
                                    // Splice at index 3
                                    if (finalRows.length > 3) {
                                        finalRows.splice(3, 0, suggestion);
                                    } else {
                                        finalRows.push(suggestion);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        } catch (suggestionErr) {
            console.error("Feed suggestion error:", suggestionErr);
        }
        */

        const last = rows[rows.length - 1];

        finalRows = await hydrateShareCounts(finalRows);
        res.json({
            posts: finalRows.map(post => {
                // If it's not an article or poll, completely remove the title key
                if (post.post_type !== 'article' && post.post_type !== 'poll') delete post.title;
                if (post.shared_post && post.shared_post.post_type !== 'article' && post.shared_post.post_type !== 'poll') delete post.shared_post.title;
                return post;
            }),
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

// ===========================================================================
// [CLEANUP - FEED REFACTOR] REASON FOR COMMENTING OUT:
// - Status: UNUSED / REDUNDANT (~215 lines)
// - Technical Reason: getMyCommentedPosts and getMyPrivatePosts are not called by frontend.
// - Active Replacement: Frontend retrieves user's posts via GET /users/me/posts (getMyPosts)
//   with query parameters (?filter=Comments and ?category=...).
// ===========================================================================
/*
exports.getMyCommentedPosts = async (req, res) => {
    const {
        search,
        cursorCreatedAt,
        cursorPostId,
        limit = 10,
        companyId: requestedCompanyId
    } = req.query;

    try {
        const actorScope = getContentActorScope(req, requestedCompanyId || null);
        const { userId, orgId: companyId, isOrgActor } = actorScope;
        const params = [userId];
        const userParamIdx = 1;
        let orgParamIdx = null;
        let idx = 2;

        if (isOrgActor) {
            params.push(companyId);
            orgParamIdx = 2;
            idx = 3;
        }

        // Filter: Posts commented by the user, excluding their own posts (per user request)
        let whereClause = isOrgActor
            ? `WHERE EXISTS (SELECT 1 FROM active_post_comments pc_me WHERE pc_me.post_id = p.post_id AND pc_me.author_org_id = $${orgParamIdx}) AND p.author_org_id != $${orgParamIdx} AND p.is_active = TRUE AND (p.is_removed IS FALSE OR p.is_removed IS NULL)`
            : `WHERE EXISTS (SELECT 1 FROM active_post_comments pc_me WHERE pc_me.post_id = p.post_id AND pc_me.author_id = $${userParamIdx} AND pc_me.author_org_id IS NULL) AND p.author_id != $${userParamIdx} AND p.is_active = TRUE AND (p.is_removed IS FALSE OR p.is_removed IS NULL)`;

        if (search && search.trim() !== "") {
            whereClause += ` AND p.content ILIKE $${idx} `;
            params.push(`%${search.trim()}%`);
            idx++;
        }

        if (cursorCreatedAt && cursorPostId) {
            whereClause += ` AND (p.created_at, p.post_id) < ($${idx}, $${idx + 1}) `;
            params.push(cursorCreatedAt, cursorPostId);
            idx += 2;
        }

        params.push(limit);
        const limitIdx = idx;

        const query = `
        SELECT
            p.post_id,
            p.content,
            p.created_at,
            p.visibility,
            p.post_type,
            COALESCE(p.author_org_id, u.user_id) AS author_id,
            COALESCE(comp.name, u.full_name) AS author_name,
            CASE WHEN p.author_org_id IS NOT NULL THEN comp.logo_url ELSE u.avatar_url END AS author_avatar,
            COALESCE(comp.slug, u.account_name) AS author_slug,
            (p.author_org_id IS NOT NULL) AS is_organization_post,
            pc.name AS category_name,
            p.location,
            COALESCE(pm.media, '[]'::json) AS media,
            COALESCE(lc.like_count, 0) AS like_count,
            EXISTS(SELECT 1 FROM active_post_likes pl_me WHERE pl_me.post_id = p.post_id AND (
                ${isOrgActor ? `pl_me.org_id = $${orgParamIdx}::uuid` : `pl_me.user_id = $${userParamIdx} AND pl_me.org_id IS NULL`}
            )) AS is_liked,
            true AS is_commented,
            EXISTS(SELECT 1 FROM saved_post sp_me WHERE sp_me.post_id = p.post_id AND (
                ${isOrgActor ? `sp_me.org_id = $${orgParamIdx}::uuid` : `sp_me.user_id = $${userParamIdx} AND sp_me.org_id IS NULL`}
            )) AS is_saved,
            COALESCE(cc.comment_count, 0) AS comment_count,
            (
                SELECT json_build_object(
                    'comment_id', mc.comment_id,
                    'content', mc.content,
                    'created_at', mc.created_at,
                    'author_id', COALESCE(mc.author_org_id, mc_u.user_id),
                    'author_name', COALESCE(mc_comp.name, mc_u.full_name),
                    'author_avatar', CASE WHEN mc.author_org_id IS NOT NULL THEN mc_comp.logo_url ELSE mc_u.avatar_url END,
                    'author_title', mc_u.headline,
                    'like_count', (SELECT COUNT(*) FROM active_comment_likes cl WHERE cl.comment_id = mc.comment_id)::int,
                    'is_liked', EXISTS(SELECT 1 FROM active_comment_likes cl WHERE cl.comment_id = mc.comment_id AND (
                        ${isOrgActor ? `cl.org_id = $${orgParamIdx}::uuid` : `cl.user_id = $${userParamIdx} AND cl.org_id IS NULL`}
                    )),
                    'reply_count', (SELECT COUNT(*) FROM active_post_comments rc WHERE rc.parent_id = mc.comment_id)::int
                )
                FROM active_post_comments mc
                JOIN active_users mc_u ON mc_u.user_id = mc.author_id
                LEFT JOIN organizations mc_comp ON mc_comp.org_id = mc.author_org_id
                WHERE mc.post_id = p.post_id
                AND (${isOrgActor ? `mc.author_org_id = $${orgParamIdx}::uuid` : `mc.author_id = $${userParamIdx} AND mc.author_org_id IS NULL`})
                ORDER BY mc.created_at DESC
                LIMIT 1
            ) AS my_comment
        FROM posts p
        JOIN active_users u ON u.user_id = p.author_id
        LEFT JOIN organizations comp ON comp.org_id = p.author_org_id
        LEFT JOIN post_categories pc ON pc.category_id = p.category_id
        LEFT JOIN (
            SELECT pm.post_id, json_agg(json_build_object('media_id', pm.media_id, 'url', pm.url, 'media_type', pm.media_type)) AS media
            FROM post_media pm GROUP BY pm.post_id
        ) pm ON pm.post_id = p.post_id
        LEFT JOIN (SELECT post_id, COUNT(*) AS like_count FROM active_post_likes GROUP BY post_id) lc ON lc.post_id = p.post_id
        LEFT JOIN (SELECT post_id, COUNT(*) AS comment_count FROM active_post_comments GROUP BY post_id) cc ON cc.post_id = p.post_id
        ${whereClause}
        ORDER BY p.created_at DESC, p.post_id DESC
        LIMIT $${limitIdx}
        `;

        const { rows } = await pool.query(query, params);
        const last = rows[rows.length - 1];

        const hydratedRows = await hydrateShareCounts(rows);
        res.json({
            posts: hydratedRows,
            nextCursor: last ? { cursorCreatedAt: last.created_at, cursorPostId: last.post_id } : null,
        });
    } catch (err) {
        console.error("Get commented posts error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.getMyPrivatePosts = async (req, res) => {
    const {
        search,
        cursorCreatedAt,
        cursorPostId,
        limit = 10,
        companyId: requestedCompanyId
    } = req.query;

    try {
        const actorScope = getContentActorScope(req, requestedCompanyId || null);
        const { userId, orgId: companyId, isOrgActor } = actorScope;
        const params = [userId];
        const userParamIdx = 1;
        let orgParamIdx = null;
        let idx = 2;

        if (isOrgActor) {
            params.push(companyId);
            orgParamIdx = 2;
            idx = 3;
        }

        let whereClause = isOrgActor
            ? `WHERE p.author_org_id = $${orgParamIdx} AND p.visibility = 'private' AND p.is_active = TRUE AND (p.is_removed IS FALSE OR p.is_removed IS NULL)`
            : `WHERE p.author_id = $${userParamIdx} AND p.author_org_id IS NULL AND p.visibility = 'private' AND p.is_active = TRUE AND (p.is_removed IS FALSE OR p.is_removed IS NULL)`;

        if (search && search.trim() !== "") {
            whereClause += ` AND p.content ILIKE $${idx} `;
            params.push(`%${search.trim()}%`);
            idx++;
        }

        if (cursorCreatedAt && cursorPostId) {
            whereClause += ` AND (p.created_at, p.post_id) < ($${idx}, $${idx + 1}) `;
            params.push(cursorCreatedAt, cursorPostId);
            idx += 2;
        }

        params.push(limit);
        const limitIdx = idx;

        const query = `
        SELECT
            p.post_id,
            p.content,
            p.created_at,
            p.visibility,
            p.post_type,
            COALESCE(p.author_org_id, u.user_id) AS author_id,
            COALESCE(comp.name, u.full_name) AS author_name,
            CASE WHEN p.author_org_id IS NOT NULL THEN comp.logo_url ELSE u.avatar_url END AS author_avatar,
            COALESCE(comp.slug, u.account_name) AS author_slug,
            CASE WHEN p.author_org_id IS NOT NULL THEN comp.headline ELSE u.headline END AS author_headline,
            (p.author_org_id IS NOT NULL) AS is_organization_post,
            pc.name AS category_name,
            p.location,
            COALESCE(pm.media, '[]'::json) AS media,
            COALESCE(lc.like_count, 0) AS like_count,
            EXISTS(SELECT 1 FROM active_post_likes pl_me WHERE pl_me.post_id = p.post_id AND (
                ${isOrgActor ? `pl_me.org_id = $${orgParamIdx}::uuid` : `pl_me.user_id = $${userParamIdx} AND pl_me.org_id IS NULL`}
            )) AS is_liked,
            EXISTS(SELECT 1 FROM active_post_comments pc_me WHERE pc_me.post_id = p.post_id AND (
                ${isOrgActor ? `pc_me.author_org_id = $${orgParamIdx}::uuid` : `pc_me.author_id = $${userParamIdx} AND pc_me.author_org_id IS NULL`}
            )) AS is_commented,
            EXISTS(SELECT 1 FROM saved_post sp_me WHERE sp_me.post_id = p.post_id AND (
                ${isOrgActor ? `sp_me.org_id = $${orgParamIdx}::uuid` : `sp_me.user_id = $${userParamIdx} AND sp_me.org_id IS NULL`}
            )) AS is_saved,
            COALESCE(cc.comment_count, 0) AS comment_count
        FROM posts p
        JOIN active_users u ON u.user_id = p.author_id
        LEFT JOIN organizations comp ON comp.org_id = p.author_org_id
        LEFT JOIN post_categories pc ON pc.category_id = p.category_id
        LEFT JOIN (
            SELECT pm.post_id, json_agg(json_build_object('media_id', pm.media_id, 'url', pm.url, 'media_type', pm.media_type)) AS media
            FROM post_media pm GROUP BY pm.post_id
        ) pm ON pm.post_id = p.post_id
        LEFT JOIN (SELECT post_id, COUNT(*) AS like_count FROM active_post_likes GROUP BY post_id) lc ON lc.post_id = p.post_id
        LEFT JOIN (SELECT post_id, COUNT(*) AS comment_count FROM active_post_comments GROUP BY post_id) cc ON cc.post_id = p.post_id
        ${whereClause}
        ORDER BY p.created_at DESC, p.post_id DESC
        LIMIT $${limitIdx}
        `;

        const { rows } = await pool.query(query, params);
        const last = rows[rows.length - 1];

        const hydratedRows = await hydrateShareCounts(rows);
        res.json({
            posts: hydratedRows,
            nextCursor: last ? { cursorCreatedAt: last.created_at, cursorPostId: last.post_id } : null,
        });
    } catch (err) {
        console.error("Get private posts error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};
*/

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
//       JOIN active_users u ON u.user_id = p.author_id
//       LEFT JOIN post_categories pc ON pc.category_id = p.category_id

//       LEFT JOIN (
//         SELECT post_id, json_agg(pm.* ORDER BY pm.created_at) AS media
//         FROM post_media pm
//         GROUP BY post_id
//       ) pm ON pm.post_id = p.post_id

//       LEFT JOIN (
//         SELECT post_id, COUNT(*) AS like_count
//         FROM active_post_likes
//         GROUP BY post_id
//       ) lc ON lc.post_id = p.post_id

//       LEFT JOIN (
//         SELECT post_id, COUNT(*) AS comment_count
//         FROM active_post_comments
//         GROUP BY post_id
//       ) cc ON cc.post_id = p.post_id

//       LEFT JOIN (
//         SELECT
//           pp.post_id,
//           json_build_object(
//             'poll_id', pp.poll_id,
//             'duration', COALESCE(pp.duration, '1 day'),
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
    let actorScope;

    try {
        actorScope = getContentActorScope(req, req.body?.companyId || null);
    } catch (err) {
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }

    const { userId, orgId: companyId } = actorScope;
    let { content, category, visibility, media_urls, post_type, title, poll_options, poll_duration, is_broadcast, location, achievement_image_id, status } = req.body; // category is name, media_urls is array

    if (media_urls && typeof media_urls === 'string') {
        try {
            media_urls = JSON.parse(media_urls);
        } catch (e) { }
    }

    if (status !== undefined && status !== "published" && status !== "draft") {
        return res.status(400).json({ message: "Invalid status. Allowed values: 'published', 'draft'" });
    }

    let isCommunityArticle = false;
    if (req.body.is_community_article !== undefined) {
        isCommunityArticle = req.body.is_community_article === true || req.body.is_community_article === 'true';
    }

    status = status || ((post_type === "article" && isCommunityArticle) ? "draft" : "published");

    // Extract uploaded files. "media" holds inline content / post images-videos,
    // "cover_media" (article posts only) holds the explicitly chosen cover image -
    // kept on its own field so we never have to guess which upload is the cover.
    const mediaFiles = (req.files && req.files.media) || [];
    const coverFiles = (req.files && req.files.cover_media) || [];
    const uploadedFiles = [...mediaFiles, ...coverFiles];
    const imageFiles = uploadedFiles.filter(f => f.mimetype.startsWith('image/'));
    const videoFiles = uploadedFiles.filter(f => f.mimetype.startsWith('video/'));

    const fs = require('fs');
    const cleanupFiles = (files) => {
        files.forEach(f => {
            try {
                if (fs.existsSync(f.path)) {
                    fs.unlinkSync(f.path);
                }
            } catch (err) {
                console.error("[CreatePost] Local file cleanup error:", err);
            }
        });
    };

    // Custom file validations
    if (videoFiles.length > 1) {
        cleanupFiles(uploadedFiles);
        return res.status(400).json({
            message: "Only one video file is allowed"
        });
    }

    if (videoFiles.length > 0 && imageFiles.length > 0) {
        cleanupFiles(uploadedFiles);
        return res.status(400).json({
            message: "Cannot upload video and images together"
        });
    }

    if (imageFiles.length > 12) {
        cleanupFiles(uploadedFiles);
        return res.status(400).json({
            message: "Maximum 12 images allowed"
        });
    }

    // Image file size validation for post creation:
    // - Per-image limit: 10MB max per single image file
    // - Total post upload limit: 120MB max cumulative size across all uploaded images (up to 12 images x 10MB)
    const MAX_SINGLE_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB per single image limit
    const MAX_TOTAL_IMAGE_SIZE = 120 * 1024 * 1024; // 120MB total post images limit

    // Reject any single image larger than 10MB
    const oversizedImage = imageFiles.find(f => f.size > MAX_SINGLE_IMAGE_SIZE);
    if (oversizedImage) {
        cleanupFiles(uploadedFiles);
        return res.status(400).json({
            message: `Image "${oversizedImage.originalname || 'file'}" exceeds the 10MB limit.`
        });
    }

    // Reject cumulative image upload size larger than 120MB
    const totalImageSize = imageFiles.reduce((sum, f) => sum + (f.size || 0), 0);
    if (totalImageSize > MAX_TOTAL_IMAGE_SIZE) {
        cleanupFiles(uploadedFiles);
        return res.status(400).json({
            message: "Total image upload size cannot exceed 120MB."
        });
    }

    // Map uploaded files to media URLs directly (already streamed by Multer middleware)
    if (post_type === 'article') {
        // Cover comes unambiguously from the dedicated field when the caller sends one
        // (the Channels article editor always does). Callers that don't (e.g. the
        // simpler personal "write article" composer, which has no inline content
        // images and no cover_media field) keep the legacy "unmatched file = cover"
        // fallback below so their behavior is unchanged.
        let coverFileUrl = coverFiles.length > 0
            ? (coverFiles[0].path || coverFiles[0].secure_url || '').replace(/\\/g, "/")
            : (media_urls && media_urls.length > 0 ? media_urls[0] : null);
        // Everything in "media" is an inline content image/video - rewrite its blob
        // src to the real URL. Match on the basename without extension since blob:
        // URLs (e.g. "blob:http://host/<uuid>") carry no file extension.
        mediaFiles.forEach(file => {
            const fileUrl = (file.path || file.secure_url || '').replace(/\\/g, "/");
            const baseName = file.originalname.replace(/\.[^/.]+$/, '');

            if (content && baseName && content.includes(baseName)) {
                const regex = new RegExp(`src="[^"]*${baseName}[^"]*"`, 'g');
                content = content.replace(regex, `src="${fileUrl}"`);
            } else if (!coverFileUrl) {
                coverFileUrl = fileUrl;
            }
        });
        if (coverFileUrl) {
            media_urls = [coverFileUrl];
        } else if (!media_urls) {
            media_urls = [];
        }
    } else if (uploadedFiles.length > 0) {
        let parsedMediaMetadata = [];
        if (req.body.media_metadata) {
            try {
                parsedMediaMetadata = typeof req.body.media_metadata === 'string' ? JSON.parse(req.body.media_metadata) : req.body.media_metadata;
            } catch (e) {
                console.error('Failed to parse media_metadata', e);
            }
        }
        
        const fileObjects = uploadedFiles.map((file, idx) => ({
            url: (file.path || file.secure_url || '').replace(/\\/g, "/"),
            width: (parsedMediaMetadata[idx] && parsedMediaMetadata[idx].width) || file.width || null,
            height: (parsedMediaMetadata[idx] && parsedMediaMetadata[idx].height) || file.height || null
        }));
        if (videoFiles.length > 0) {
            media_urls = [fileObjects[0]];
        } else if (imageFiles.length > 0) {
            media_urls = fileObjects;
        }
    }

    // Sanitize user-generated content
    if (post_type !== 'article') {
        content = sanitizeContent(content);
    } else {
        content = sanitizeArticleContent(content);
    }
    title = sanitizeContent(title);
    if (poll_options && Array.isArray(poll_options)) {
        poll_options = poll_options.map(opt => sanitizeContent(opt));
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 0. If reposting, check if original is Personal or already reposted
        if (req.body.shared_post_id) {
            if (companyId) {
                const canRepost = await checkOrgPermission(client, companyId, userId, ['CREATE_POST', 'CREATE_CONTENT']);
                if (!canRepost) {
                    await client.query('ROLLBACK');
                    return res.status(403).json({
                        message: "You do not have permission to repost on behalf of this organization."
                    });
                }
            }

            // Check if Personal or already a repost
            const originalPostCheck = await client.query(
                `SELECT pc.name, p.shared_post_id, p.content FROM posts p 
                 LEFT JOIN post_categories pc ON p.category_id = pc.category_id 
                 WHERE p.post_id = $1`,
                [req.body.shared_post_id]
            );
            if (originalPostCheck.rowCount > 0) {
                if (originalPostCheck.rows[0].name === 'Personal') {
                    await client.query('ROLLBACK');
                    return res.status(403).json({ message: "Personal posts cannot be reposted." });
                }
                let currentTarget = originalPostCheck.rows[0];
                while (currentTarget && currentTarget.shared_post_id !== null) {
                    const targetContent = currentTarget.content;
                    const targetHasThoughts = targetContent && targetContent.replace(/<[^>]*>?/gm, '').replace(/&nbsp;|\u200B|\u00A0|&#8203;|&#160;|&zwnj;/g, '').replace(/\s/g, '').trim() !== '';

                    if (!targetHasThoughts) {
                        // Automatically redirect/unwrap to parent post
                        req.body.shared_post_id = currentTarget.shared_post_id;
                        const nextCheck = await client.query(
                            `SELECT pc.name, p.shared_post_id, p.content FROM posts p 
                             LEFT JOIN post_categories pc ON p.category_id = pc.category_id 
                             WHERE p.post_id = $1`,
                            [req.body.shared_post_id]
                        );
                        currentTarget = nextCheck.rowCount > 0 ? nextCheck.rows[0] : null;
                        if (currentTarget && currentTarget.name === 'Personal') {
                            await client.query('ROLLBACK');
                            return res.status(403).json({ message: "Personal posts cannot be reposted." });
                        }
                    } else {
                        if (content && content.replace(/<[^>]*>?/gm, '').replace(/&nbsp;|\u200B|\u00A0|&#8203;|&#160;|&zwnj;/g, '').replace(/\s/g, '').trim() !== '') {
                            await client.query('ROLLBACK');
                            return res.status(403).json({ message: "Nested reposts with thoughts are not allowed." });
                        }
                        break;
                    }
                }
            }

            // Check for Duplicate (Direct Repost toggle)
            const duplicateCheck = await client.query(
                `SELECT post_id
                 FROM posts
                 WHERE shared_post_id = $1
                   AND (
                        ($3::uuid IS NOT NULL AND author_org_id = $3::uuid)
                        OR
                        ($3::uuid IS NULL AND author_id = $2 AND author_org_id IS NULL)
                   )
                   AND (content IS NULL OR content = '')
                   AND is_active = TRUE
                   AND (is_removed IS FALSE OR is_removed IS NULL)`,
                [req.body.shared_post_id, userId, companyId || null]
            );
            if (duplicateCheck.rowCount > 0 && (!content || content.trim() === '')) {
                const existingPostId = duplicateCheck.rows[0].post_id;
                await client.query(`DELETE FROM posts WHERE post_id = $1`, [existingPostId]);
                await client.query('COMMIT');
                return res.status(200).json({ reposted: false, message: "Repost removed" });
            } else if (duplicateCheck.rowCount > 0) {
                // If they are trying to do a direct repost but somehow bypassed, or quote repost exists?
                // Actually, if it's a quote repost we allow multiple, but let's prevent duplicate direct reposts.
                await client.query('ROLLBACK');
                return res.status(409).json({ message: "You have already shared this post." });
            }
        }


        // Infer post_type if not provided
        if (!post_type) {
            if (poll_options && poll_options.length > 0) {
                post_type = 'poll';
            } else if (media_urls && Array.isArray(media_urls) && media_urls.length > 0) {
                const firstUrl = media_urls[0];
                post_type = firstUrl.toLowerCase().match(/\.(mp4|webm|mov)(\?|#|$)/) ? 'video' : 'image';
            } else {
                post_type = 'text';
            }
        }

        // Post content validation for normal text posts
        if (post_type === 'text' && !req.body.shared_post_id && !req.body.shared_job_id) {
            if (!content || content.trim().length === 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ message: "Post content cannot be empty" });
            }
        }

        // 1. Get Category ID
        let categoryId = null;
        if (!category) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: "Category is required" });
        } else {
            const catRes = await client.query(`SELECT category_id FROM post_categories WHERE name = $1`, [category]);
            if (catRes.rowCount > 0) {
                categoryId = catRes.rows[0].category_id;
            } else {
                await client.query('ROLLBACK');
                return res.status(400).json({ message: "Invalid category" });
            }

            // --- CONTEXT-AWARE CATEGORY VALIDATION ---
            const userAllowed = ['Personal', 'Professional', 'Achievement'];
            const companyAllowed = ['Update', 'Hiring', 'Milestone', 'Insight', 'Professional', 'Article'];
            const institutionAllowed = ['Professional', 'Announcement', 'Academic', 'Admission', 'Campus Life', 'Research', 'Club Activity', 'General'];

            if (companyId) {
                // Determine if it's a COMPANY or INSTITUTION
                const orgRes = await client.query('SELECT entity_type FROM organizations WHERE org_id = $1', [companyId]);
                const entityType = orgRes.rows[0]?.entity_type;

                if (entityType === 'INSTITUTION') {
                    if (!institutionAllowed.includes(category)) {
                        await client.query('ROLLBACK');
                        return res.status(400).json({
                            message: `Invalid category for Institution posts. Allowed: ${institutionAllowed.join(', ')}`
                        });
                    }

                    // Category-level RBAC check
                    const categoryPermissionMap = {
                        'Professional': 'CREATE_CONTENT',
                        'Announcement': 'POST_ANNOUNCEMENT',
                        'Academic': 'CREATE_ACADEMIC_CONTENT',
                        'Research': 'CREATE_ACADEMIC_CONTENT',
                        'Admission': 'POST_ANNOUNCEMENT',
                        'Campus Life': 'CREATE_GENERAL_CONTENT',
                        'Club Activity': 'CREATE_GENERAL_CONTENT',
                        'General': 'CREATE_GENERAL_CONTENT'
                    };

                    const requiredPerm = categoryPermissionMap[category];
                    const canPost = await checkOrgPermission(client, companyId, userId, [requiredPerm, 'MANAGE_COMPANY', 'CREATE_CONTENT', 'CREATE_POST']);

                    if (!canPost) {
                        // Allow Students to post in General freely
                        // The test script role has CREATE_GENERAL_CONTENT mapped to 'Student' and 'Student Moderator'
                        // So the auth check `checkOrgPermission` should handle it if passed the right permissions.
                        // Wait: checkOrgPermission signature is `(orgId, userId, requiredPermissions)`
                        await client.query('ROLLBACK');
                        return res.status(403).json({
                            message: `You do not have permission to post in category: ${category}`
                        });
                    }

                } else {
                    // Normal Company Post
                    const canPost = await checkOrgPermission(client, companyId, userId, ['CREATE_POST', 'CREATE_CONTENT']);
                    if (!canPost) {
                        await client.query('ROLLBACK');
                        return res.status(403).json({
                            message: "You do not have permission to post on behalf of this organization."
                        });
                    }
                }
            } else {
                // User Post
                if (!['Personal', 'Professional', 'Achievement'].includes(category)) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ message: `Invalid category for User posts. Allowed: Personal, Professional, Achievement` });
                }
            }
        }

        if (achievement_image_id) {
            const aiCheck = await client.query(`SELECT id FROM achievement_images WHERE id = $1 AND is_active = TRUE`, [achievement_image_id]);
            if (aiCheck.rowCount === 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ message: "Invalid or inactive achievement image selected." });
            }
        }


        // 1b. Broadcast guards
        if (is_broadcast) {
            // Guard 1: must be org context
            if (!companyId) {
                await client.query('ROLLBACK');
                return res.status(400).json({ message: "Broadcasts can only be sent by organizations." });
            }

            // Guard 2: must have MANAGE_COMPANY permission
            const canBroadcast = await checkOrgPermission(client, companyId, userId, ['MANAGE_COMPANY']);
            if (!canBroadcast) {
                await client.query('ROLLBACK');
                return res.status(403).json({ message: "Only organization admins can send broadcasts." });
            }

            // Guard 3: org must have at least one child
            const childrenRes = await client.query(
                `SELECT COUNT(*) FROM organizations WHERE parent_org_id = $1 AND is_deleted = FALSE`,
                [companyId]
            );
            if (parseInt(childrenRes.rows[0].count) === 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ message: "Your organization has no sub-organizations to broadcast to." });
            }

            // Guard 4: rate limit — 1 broadcast per 10 minutes
            const recentBroadcast = await client.query(
                `SELECT 1 FROM posts
                 WHERE author_org_id = $1 AND is_broadcast = TRUE
                 AND created_at > NOW() - INTERVAL '30 seconds'
                 LIMIT 1`,
                [companyId]
            );
            if (recentBroadcast.rowCount > 0) {
                await client.query('ROLLBACK');
                return res.status(429).json({ message: "You recently sent a broadcast. Please wait 30 seconds before sending another." });
            }
        }

        isCommunityArticle = false;
        if (req.body.is_community_article !== undefined) {
            isCommunityArticle = req.body.is_community_article === true || req.body.is_community_article === 'true';
        }

        // 2. Insert Post
        const postResult = await client.query(
            ` INSERT INTO posts (author_id, category_id, content, visibility, post_type, title, shared_post_id, shared_job_id, author_org_id, is_broadcast, broadcast_scope, location, achievement_image_id, status, is_community_article)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING post_id, created_at
      `, [userId, categoryId, content, visibility || 'public', post_type, title, req.body.shared_post_id || null, req.body.shared_job_id || null, companyId || null, is_broadcast ? true : false, is_broadcast ? 'CHILDREN' : null, location || null, achievement_image_id || null, status || 'published', isCommunityArticle]
        );

        const postId = postResult.rows[0].post_id;

        // Removed event outbox insert for POST_CREATED
        let pollId;
        if (post_type === 'poll' && poll_options) {
            const pollRes = await client.query(
                `INSERT INTO post_polls (post_id, duration) VALUES ($1, $2) RETURNING poll_id`,
                [postId, poll_duration || '1 days'] // e.g., '1 day', '1 week'
            );

            pollId = pollRes.rows[0].poll_id;

            // Insert each option and collect them
            const insertedOptions = [];
            for (const opt of poll_options) {
                const optRes = await client.query(
                    `INSERT INTO poll_options (poll_id, option_text) VALUES ($1, $2) RETURNING option_id, option_text`,
                    [pollId, opt]
                );
                insertedOptions.push(optRes.rows[0]);
            }
            poll_options = insertedOptions; // Replace string array with object array
        }

        let type;
        // 3. Insert Media (Parallel Optimized)
        if (media_urls && Array.isArray(media_urls) && media_urls.length > 0) {
            const mediaPromises = media_urls.map(mediaItem => {
                const url = typeof mediaItem === 'string' ? mediaItem : mediaItem.url;
                const width = mediaItem.width || null;
                const height = mediaItem.height || null;
                let currentType = url.toLowerCase().match(/\.(mp4|webm|mov)(\?|#|$)/) ? 'video' : 'image';
                type = currentType; // Keep a reference to one type for response (legacy behavior)
                return client.query(
                    `INSERT INTO post_media (post_id, url, media_type, width, height) VALUES ($1, $2, $3, $4, $5)`,
                    [postId, url, currentType, width, height]
                );
            });
            await Promise.all(mediaPromises);
        }

        // 4. Handle Repost Notification
        if (req.body.shared_post_id) {
            const originalPostRes = await client.query(`SELECT author_id, author_org_id FROM posts WHERE post_id = $1`, [req.body.shared_post_id]);
            if (originalPostRes.rowCount > 0) {
                const originalAuthorId = originalPostRes.rows[0].author_id;
                const originalCompanyId = originalPostRes.rows[0].author_org_id;

                // Determine Reposter Identity
                let reposterName, reposterAvatar;
                if (companyId) {
                    const companyRes = await client.query(`SELECT name, logo_url FROM organizations WHERE org_id = $1`, [companyId]);
                    reposterName = companyRes.rows[0].name;
                    reposterAvatar = companyRes.rows[0].logo_url;
                } else {
                    const reposterRes = await client.query(`SELECT full_name, avatar_url FROM users WHERE user_id = $1`, [userId]);
                    reposterName = reposterRes.rows[0].full_name;
                    reposterAvatar = reposterRes.rows[0].avatar_url;
                }

                // Don't notify if reposting own post (User-User, Company-Company)
                let isSelfRepost = false;
                if (!companyId && !originalCompanyId && userId === originalAuthorId) isSelfRepost = true;
                if (companyId && originalCompanyId && companyId === originalCompanyId) isSelfRepost = true;

                if (!isSelfRepost) {
                    const notificationText = "reposted your post";

                    const meta = {
                        org_id: companyId, // Sender company
                        post_id: postId
                    };

                    // Insert notification
                    await client.query(
                        `INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata, recipient_org_id) 
                          VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                        [originalAuthorId, userId, "repost", notificationText, postId, JSON.stringify(meta), originalCompanyId]
                    );

                    // Emit socket event
                    socketService.notifyUser(originalAuthorId, "notification", {
                        type: "repost",
                        text: notificationText,
                        from: userId,
                        senderName: reposterName,
                        senderAvatar: reposterAvatar,
                        referenceId: postId,
                        metadata: meta,
                        time: "Just now",
                        recipient_org_id: originalCompanyId
                    });
                }
            }
        }

        if (companyId) {
            // PERMISSION CHECK START: Allow any active company member
            const memberCheck = await client.query(
                `SELECT 1 FROM organization_members 
                 WHERE org_id = $1 AND user_id = $2 AND status = 'ACTIVE' 
                   AND (expires_at IS NULL OR expires_at > NOW())`,
                [companyId, userId]
            );
            if (memberCheck.rowCount === 0) {
                await client.query('ROLLBACK');
                return res.status(403).json({ message: "Unauthorized to create posts for this company" });
            }
            // PERMISSION CHECK END

            let originalAuthorName = null;
            let originalAuthorId = null;
            if (req.body.shared_post_id) {
                const origAuthorRes = await client.query(
                    `SELECT COALESCE(o.name, u.full_name) AS author_name,
                            COALESCE(p.author_org_id, p.author_id) AS author_id
                     FROM posts p
                     LEFT JOIN organizations o ON p.author_org_id = o.org_id
                     LEFT JOIN users u ON p.author_id = u.user_id
                     WHERE p.post_id = $1`,
                    [req.body.shared_post_id]
                );
                if (origAuthorRes.rowCount > 0) {
                    originalAuthorName = origAuthorRes.rows[0].author_name;
                    originalAuthorId = origAuthorRes.rows[0].author_id;
                }
            }

            await logAudit(client, {
                entityId: companyId,
                actorId: userId,
                actorRole: req.actor?.roleName || null,
                action: req.body.shared_post_id ? 'REPOST' : 'CREATE_POST',
                metadata: {
                    type: 'post',
                    id: postId,
                    postId: postId,
                    sharedPostId: req.body.shared_post_id || null,
                    authorName: originalAuthorName,
                    authorId: originalAuthorId,
                    targetName: originalAuthorName,
                    title: title || (content ? content.substring(0, 20) : '')
                }
            });
        }

        await client.query('COMMIT');

        // Mentions in post content (fire-and-forget, after commit)
        if (content && typeof content === 'string') {
            const mentionedUsernames = [];
            const regex1 = /@\[[^\]]+\]\(([^)]+)\)/g;
            let m;
            while ((m = regex1.exec(content)) !== null) {
                if (!mentionedUsernames.includes(m[1])) mentionedUsernames.push(m[1]);
            }
            const regex2 = /(?:^|\s)@(\w+)(?!\w)/g;
            while ((m = regex2.exec(content)) !== null) {
                if (!mentionedUsernames.includes(m[1])) mentionedUsernames.push(m[1]);
            }

            if (mentionedUsernames.length > 0) {
                
                // Fetch actor details
                let actorName = "Someone";
                let actorAvatar = null;
                if (companyId) {
                    const orgRes = await pool.query(`SELECT name, logo_url FROM organizations WHERE org_id = $1`, [companyId]);
                    if (orgRes.rowCount > 0) {
                        actorName = orgRes.rows[0].name;
                        actorAvatar = orgRes.rows[0].logo_url;
                    }
                } else {
                    const userRes = await pool.query(`SELECT full_name, avatar_url FROM users WHERE user_id = $1`, [userId]);
                    if (userRes.rowCount > 0) {
                        actorName = userRes.rows[0].full_name;
                        actorAvatar = userRes.rows[0].avatar_url;
                    }
                }

                for (const handle of mentionedUsernames) {
                    let userRes;
                    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
                    if (UUID_REGEX.test(handle)) {
                        userRes = await pool.query(`SELECT user_id FROM users WHERE user_id = $1`, [handle]);
                    } else {
                        userRes = await pool.query(`SELECT user_id FROM users WHERE LOWER(account_name) = LOWER($1)`, [handle]);
                    }
                    if (userRes.rowCount > 0) {
                        const mentionedUserId = userRes.rows[0].user_id;
                        let isSelf = (!companyId && mentionedUserId === userId);

                        if (!isSelf) {
                            if (!companyId) {
                                const isBlockedByMentioned = await checkBlockStatus(mentionedUserId, userId);
                                const hasBlockedMentioned = await checkBlockStatus(userId, mentionedUserId);
                                if (isBlockedByMentioned || hasBlockedMentioned) continue;
                            }

                            const notifText = `${actorName} mentioned you in a post`;
                            const meta = { post_id: postId, org_id: companyId };
                            
                            const mentionNotifRes = await pool.query(
                                `INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata) 
                                 VALUES ($1, $2, $3, $4, $5, $6) RETURNING notification_id, created_at`,
                                [mentionedUserId, userId, 'mention', notifText, postId, JSON.stringify(meta)]
                            );

                            socketService.notifyUser(mentionedUserId, "notification", {
                                notification_id: mentionNotifRes.rows[0].notification_id,
                                type: 'mention',
                                text: notifText,
                                from: userId,
                                senderName: actorName,
                                senderAvatar: actorAvatar,
                                referenceId: postId,
                                metadata: meta,
                                time: "Just now",
                                created_at: mentionNotifRes.rows[0].created_at.toISOString(),
                                is_read: false
                            });

                            sendPush(mentionedUserId, actorName, notifText, { type: 'mention', referenceId: postId, postId }).catch(() => {});
                        }
                    }
                }
            }
        }


        // Notify followers with 'posts' preference enabled (fire-and-forget, after commit)
        if (companyId) {
            // Real-time channel article update notification for subscribers
            if (post_type === 'article' && status === 'published') {
                const newPostCreatedAt = postResult.rows[0].created_at;
                const previewText = title || 'a new article';

                broadcastChannelArticlePublished(companyId, {
                    id: postId,
                    title: title,
                    createdAt: newPostCreatedAt,
                    preview: previewText
                }).catch(err => console.error("Error in broadcastChannelArticlePublished:", err));
            } else {
                const companyNameRes = await pool.query(`SELECT name FROM organizations WHERE org_id = $1`, [companyId]);
                const cName = companyNameRes.rows[0]?.name || 'An organization';
                notifyOrgFollowers(companyId, "posts", {
                    type: "organization_post",
                    text: `${cName} published a new post`,
                    referenceId: postId,
                    metadata: { post_title: title || content?.substring(0, 50) },
                }).catch(err => console.error("Post notification error:", err));
            }

            // Broadcast: notify all members of all child orgs (fire-and-forget)
            if (is_broadcast) {
                notifyBroadcastToChildOrgs(companyId, postId, content).catch(err => console.error("Broadcast notification error:", err));
            }
        }

        // Handle Hashtags asynchronously without outbox
        const { processHashtags } = require("../../workers/eventOutboxWorker");
        processHashtags(pool, 'POST_CREATED', postId).catch(err => console.error("Hashtag process error:", err));

        // 🎯 Intent Layer: Log Create Post
        logIntentActivity({ userId, action: "create_post", metadata: { postId, postType: post_type, category } });

        res.status(201).json({
            message: "Post created",
            postId,
            id: postId,
            title: title,
            content: content,
            category: category,
            visibility: visibility,
            postType: post_type,
            mediaUrls: media_urls,
            mediaType: type,
            status: status || 'published',
            poll: {
                pollId: pollId,
                duration: poll_duration,
                isActive: true,
                options: poll_options
            }
        });

        // 📝 Log Activity: Repost
        if (req.body.shared_post_id || req.body.shared_job_id) {
            logActivity(userId, 'repost_post', 'post', postId, {
                shared_post_id: req.body.shared_post_id,
                shared_job_id: req.body.shared_job_id,
                is_broadcast: !!is_broadcast
            });
            // 🎯 Intent Layer: Log Share Post
            logIntentActivity({ userId, action: "share_post", metadata: { postId, sharedPostId: req.body.shared_post_id, sharedJobId: req.body.shared_job_id } });
        }
    } catch (err) {
        if (client) {
            try {
                await client.query('ROLLBACK');
            } catch (rollbackErr) {
                console.error("Rollback error:", rollbackErr);
            }
        }
        cleanupFiles(uploadedFiles);
        console.error("Create post error:", err);
        res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    } finally {
        if (client) {
            client.release();
        }
    }
};

exports.getPostById = async (req, res) => {
    const postId = req.params.id;
    const { companyId: requestedCompanyId } = req.query;

    try {
        const { userId, orgId: companyId } = getContentActorScope(req, requestedCompanyId || null);
        const query = `SELECT 
    p.*, 
    COALESCE(comp.name, u.full_name) AS author_name,
    CASE WHEN p.author_org_id IS NOT NULL THEN comp.logo_url ELSE u.avatar_url END AS author_avatar,
    COALESCE(comp.slug, u.account_name) AS author_slug,
    CASE WHEN p.author_org_id IS NOT NULL THEN comp.headline ELSE u.headline END AS author_headline,
    (p.author_org_id IS NOT NULL) AS is_organization_post,
    (SELECT community_id FROM communities WHERE org_id = p.author_org_id AND is_active = TRUE LIMIT 1) AS community_id,
    c.name AS category_name,
    p.location,
    ai.cloudinary_url AS achievement_image_url,
    ai.key AS achievement_image_key,
    COALESCE(ai.title, CASE WHEN c.name = 'Achievement' AND p.post_type = 'image' THEN p.title ELSE NULL END) AS achievement_image_title,
    COALESCE(
        (SELECT json_agg(json_build_object(
            'id', COALESCE(u_tag.user_id, o_tag.org_id),
            'full_name', COALESCE(u_tag.full_name, o_tag.name),
            'account_name', COALESCE(u_tag.account_name, o_tag.slug),
            'avatar_url', COALESCE(u_tag.avatar_url, o_tag.logo_url),
            'type', CASE WHEN o_tag.org_id IS NOT NULL THEN 'company' ELSE 'user' END
        ))
        FROM post_tags pt 
        LEFT JOIN active_users u_tag ON pt.tagged_user_id = u_tag.user_id
        LEFT JOIN organizations o_tag ON pt.tagged_user_id = o_tag.org_id AND o_tag.is_deleted = FALSE
        WHERE pt.post_id = p.post_id 
          AND pt.is_active_tag = true
          AND (u_tag.user_id IS NOT NULL OR o_tag.org_id IS NOT NULL)),
        '[]'::json
    ) AS tags,

    (
        SELECT COALESCE(json_agg(json_build_object(
            'id', COALESCE(u_mention.user_id, o_mention.org_id),
            'user_id', COALESCE(u_mention.user_id, o_mention.org_id),
            'org_id', o_mention.org_id,
            'full_name', COALESCE(u_mention.full_name, o_mention.name),
            'account_name', COALESCE(u_mention.account_name, o_mention.slug),
            'is_company', (o_mention.org_id IS NOT NULL),
            'type', CASE WHEN o_mention.org_id IS NOT NULL THEN 'COMPANY' ELSE 'USER' END,
            'slug', o_mention.slug
        )), '[]'::json)
        FROM (
            SELECT DISTINCT (regexp_matches(COALESCE(p.content, ''), '@\\[[^\\]]+\\]\\(([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\\)', 'g'))[1]::uuid AS mentioned_id
        ) mentions
        LEFT JOIN active_users u_mention ON u_mention.user_id = mentions.mentioned_id
        LEFT JOIN organizations o_mention ON o_mention.org_id = mentions.mentioned_id
        WHERE u_mention.user_id IS NOT NULL OR o_mention.org_id IS NOT NULL
    ) AS mentioned_users,

    -- Like Count
    (SELECT COUNT(*) FROM active_post_likes pl WHERE pl.post_id = p.post_id)::int AS like_count,

    (
        SELECT COALESCE(comp_like.name, comp_like.slug, u_like.full_name, u_like.account_name)
        FROM active_post_likes pl_sample
        LEFT JOIN active_users u_like ON u_like.user_id = pl_sample.user_id
        LEFT JOIN organizations comp_like ON comp_like.org_id = pl_sample.org_id
        WHERE pl_sample.post_id = p.post_id
        AND NOT (
            ($3::uuid IS NOT NULL AND pl_sample.org_id IS NOT NULL AND pl_sample.org_id = $3::uuid)
            OR
            ($3::uuid IS NULL AND pl_sample.user_id = $2 AND pl_sample.org_id IS NULL)
        )
        ${companyId ? `
        AND NOT EXISTS (
            SELECT 1 FROM blocks b 
            WHERE (b.is_org_block = true AND pl_sample.org_id IS NULL AND ((b.blocker_id = $3 AND b.blocked_id = pl_sample.user_id) OR (b.blocker_id = pl_sample.user_id AND b.blocked_id = $3)))
               OR (b.is_org_block = true AND pl_sample.org_id IS NOT NULL AND ((b.blocker_id = pl_sample.org_id AND b.blocked_id = $3) OR (b.blocker_id = $3 AND b.blocked_id = pl_sample.org_id)))
        )
        ` : `
        AND NOT EXISTS (
            SELECT 1 FROM blocks b 
            WHERE (b.is_org_block = false AND pl_sample.org_id IS NULL AND ((b.blocker_id = $2 AND b.blocked_id = pl_sample.user_id) OR (b.blocker_id = pl_sample.user_id AND b.blocked_id = $2)))
               OR (b.is_org_block = true AND pl_sample.org_id IS NOT NULL AND ((b.blocker_id = pl_sample.org_id AND b.blocked_id = $2) OR (b.blocker_id = $2 AND b.blocked_id = pl_sample.org_id)))
        )
        `}
        ORDER BY
            (
                $2::uuid IS NOT NULL AND
                (
                    (pl_sample.user_id IS NOT NULL AND EXISTS (
                        SELECT 1 FROM followers f
                        WHERE f.follower_id = $2 AND f.following_id = pl_sample.user_id
                    ))
                    OR
                    (pl_sample.org_id IS NOT NULL AND EXISTS (
                        SELECT 1 FROM organization_followers ofol
                        WHERE ofol.user_id = $2 AND ofol.org_id = pl_sample.org_id
                    ))
                )
            ) DESC,
            pl_sample.created_at DESC
        LIMIT 1
    ) AS sample_liker_username,

    -- Comment Count
    (SELECT COUNT(*) FROM active_post_comments pc WHERE pc.post_id = p.post_id)::int AS comment_count,

    -- Repost & Share Counts
    (SELECT COUNT(*) FROM posts sp_share WHERE sp_share.shared_post_id = p.post_id AND sp_share.is_active = TRUE AND (sp_share.is_removed IS FALSE OR sp_share.is_removed IS NULL))::int AS "rePostCount",
    (SELECT COUNT(*) FROM shares s WHERE s.entity_type IN ('post', 'article') AND s.entity_id = p.post_id::text)::int AS "sharePostCount",

    -- Is Liked (Identity Aware)
    EXISTS(
        SELECT 1 FROM active_post_likes pl 
        WHERE pl.post_id = p.post_id 
        AND (
            ($3::uuid IS NOT NULL AND pl.org_id = $3::uuid)
            OR
            ($3::uuid IS NULL AND pl.user_id = $2 AND pl.org_id IS NULL)
        )
    ) AS is_liked,

    EXISTS(
        SELECT 1 FROM posts sp_rep
        WHERE sp_rep.shared_post_id = p.post_id 
        AND (
            ($3::uuid IS NOT NULL AND sp_rep.author_org_id = $3::uuid)
            OR
            ($3::uuid IS NULL AND sp_rep.author_id = $2 AND sp_rep.author_org_id IS NULL)
        )
        AND sp_rep.is_active = TRUE
        AND (sp_rep.is_removed IS FALSE OR sp_rep.is_removed IS NULL)
    ) AS is_reposted,
        EXISTS(
        SELECT 1 FROM posts sp_rep
        WHERE sp_rep.shared_post_id = p.post_id 
        AND (
            ($3::uuid IS NOT NULL AND sp_rep.author_org_id = $3::uuid)
            OR
            ($3::uuid IS NULL AND sp_rep.author_id = $2 AND sp_rep.author_org_id IS NULL)
        )
        AND sp_rep.is_active = TRUE
        AND (sp_rep.is_removed IS FALSE OR sp_rep.is_removed IS NULL)
    AND sp_rep.content IS NOT NULL AND TRIM(sp_rep.content) != ''
        ) AS is_reposted_with_thoughts,

    (
        SELECT sp_rep.post_id FROM posts sp_rep
        WHERE sp_rep.shared_post_id = p.post_id 
        AND (
            ($3::uuid IS NOT NULL AND sp_rep.author_org_id = $3::uuid)
            OR
            ($3::uuid IS NULL AND sp_rep.author_id = $2 AND sp_rep.author_org_id IS NULL)
        )
        AND sp_rep.is_active = TRUE
        AND (sp_rep.is_removed IS FALSE OR sp_rep.is_removed IS NULL)
        LIMIT 1
    ) AS repost_id,

    (
        SELECT COALESCE(
            json_agg(json_build_object(
                'username', COALESCE(comp_like.name, comp_like.slug, u_like.full_name, u_like.account_name),
                'avatar_url', COALESCE(comp_like.logo_url, u_like.avatar_url),
                'is_company', (sub.org_id IS NOT NULL),
                'is_organization', (sub.org_id IS NOT NULL)
            )),
            '[]'::json
        )
        FROM (
            SELECT pl_sample.user_id, pl_sample.org_id
            FROM active_post_likes pl_sample
            WHERE pl_sample.post_id = p.post_id
              AND NOT (
                  ($3::uuid IS NOT NULL AND pl_sample.org_id IS NOT NULL AND pl_sample.org_id = $3::uuid)
                  OR
                  ($3::uuid IS NULL AND pl_sample.user_id = $2 AND pl_sample.org_id IS NULL)
              )
              ${companyId ? `
              AND NOT EXISTS (
                  SELECT 1 FROM blocks b 
                  WHERE (b.is_org_block = true AND pl_sample.org_id IS NULL AND ((b.blocker_id = $3 AND b.blocked_id = pl_sample.user_id) OR (b.blocker_id = pl_sample.user_id AND b.blocked_id = $3)))
                     OR (b.is_org_block = true AND pl_sample.org_id IS NOT NULL AND ((b.blocker_id = pl_sample.org_id AND b.blocked_id = $3) OR (b.blocker_id = $3 AND b.blocked_id = pl_sample.org_id)))
              )
              ` : `
              AND NOT EXISTS (
                  SELECT 1 FROM blocks b 
                  WHERE (b.is_org_block = false AND pl_sample.org_id IS NULL AND ((b.blocker_id = $2 AND b.blocked_id = pl_sample.user_id) OR (b.blocker_id = pl_sample.user_id AND b.blocked_id = $2)))
                     OR (b.is_org_block = true AND pl_sample.org_id IS NOT NULL AND ((b.blocker_id = pl_sample.org_id AND b.blocked_id = $2) OR (b.blocker_id = $2 AND b.blocked_id = pl_sample.org_id)))
              )
              `}
            ORDER BY pl_sample.created_at DESC
            LIMIT 3
        ) sub
        LEFT JOIN active_users u_like ON u_like.user_id = sub.user_id
        LEFT JOIN organizations comp_like ON comp_like.org_id = sub.org_id
    ) AS liked_users,

    EXISTS(
        SELECT 1 FROM active_post_comments pc_me 
        WHERE pc_me.post_id = p.post_id 
        AND (
            ($3::uuid IS NOT NULL AND pc_me.author_org_id = $3::uuid)
            OR
            ($3::uuid IS NULL AND pc_me.author_id = $2 AND pc_me.author_org_id IS NULL)
        )
    ) AS is_commented,

    EXISTS(
        SELECT 1 FROM saved_post sp_me 
        WHERE sp_me.post_id = p.post_id 
        AND (
            ($3::uuid IS NOT NULL AND sp_me.org_id = $3::uuid)
            OR
            ($3::uuid IS NULL AND sp_me.user_id = $2 AND sp_me.org_id IS NULL)
        )
    ) AS is_saved,

    EXISTS(
        SELECT 1 FROM reports r_rep 
        WHERE r_rep.target_type = 'POST' 
        AND (
            r_rep.target_id = p.post_id 
            OR (
                p.shared_post_id IS NOT NULL 
                AND (p.content IS NULL OR TRIM(p.content) = '') 
                AND r_rep.target_id = p.shared_post_id
            )
        )
        AND (
            ($3::uuid IS NOT NULL AND r_rep.reporter_org_id = $3::uuid)
            OR
            ($3::uuid IS NULL AND r_rep.reporter_id = $2 AND r_rep.reporter_org_id IS NULL)
        )
    ) AS is_reported,

    -- Media (array)
    COALESCE(
        (
            SELECT json_agg(
                json_build_object(
                    'media_id', pm.media_id,
                    'url', pm.url,
                    'media_type', pm.media_type,
                    'width', pm.width,
                    'height', pm.height
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
            'duration', COALESCE(pp.duration, '1 day'),
            'total_votes', (SELECT COUNT(*) FROM poll_votes pv WHERE pv.poll_id = pp.poll_id)::int,
            'user_vote', (
                SELECT pv_u.option_id FROM poll_votes pv_u 
                WHERE pv_u.poll_id = pp.poll_id 
                AND (
                    ($3::uuid IS NOT NULL AND pv_u.org_id = $3::uuid)
                    OR
                    ($3::uuid IS NULL AND pv_u.voter_id = $2 AND pv_u.org_id IS NULL)
                )
                LIMIT 1
            ),
            'is_active', (pp.created_at + COALESCE(pp.duration, '1 day')::interval > NOW()),
            'options',
            COALESCE(
                (
                    SELECT json_agg(
                        json_build_object(
                            'option_id', po.option_id,
                            'option_text', po.option_text,
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
        LIMIT 1
    ) AS poll,

    -- Shared Post Data
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
            -- 1. Private: Author only
            (sp.visibility = 'private' AND sp.author_id = $2)
            OR
            -- 2. Public + Personal: Connections only
            (sp.visibility = 'public' AND sp_cat.name = 'Personal' AND (
                sp.author_id = $2
                OR EXISTS (
                    SELECT 1 FROM followers f1 
                    JOIN followers f2 ON f1.follower_id = f2.following_id AND f1.following_id = f2.follower_id 
                    WHERE f1.follower_id = $2 AND f1.following_id = sp.author_id
                )
            ))
            OR
            -- 3. Public + Other: Everyone
            (sp.visibility = 'public' AND (sp_cat.name != 'Personal' OR sp_cat.name IS NULL))
        ) THEN
            json_build_object(
                'is_accessible', true,
                'post_id', sp.post_id,
                'content', sp.content,
                'location', sp.location,
                'created_at', sp.created_at,
                'author', json_build_object(
                    'user_id', COALESCE(sp.author_org_id, sp_u.user_id),
                    'full_name', COALESCE(sp_comp.name, sp_u.full_name),
                    'avatar_url', CASE WHEN sp.author_org_id IS NOT NULL THEN sp_comp.logo_url ELSE sp_u.avatar_url END,
                    'author_headline', CASE WHEN sp.author_org_id IS NOT NULL THEN sp_comp.headline ELSE sp_u.headline END,
                    'author_slug', COALESCE(sp_comp.slug, sp_u.account_name),
                    'is_organization_post', (sp.author_org_id IS NOT NULL)
                ),
                'mentioned_users', (
                    SELECT COALESCE(json_agg(json_build_object(
                        'id', COALESCE(u_mention.user_id, o_mention.org_id),
                        'user_id', COALESCE(u_mention.user_id, o_mention.org_id),
                        'org_id', o_mention.org_id,
                        'full_name', COALESCE(u_mention.full_name, o_mention.name),
                        'account_name', COALESCE(u_mention.account_name, o_mention.slug),
                        'is_company', (o_mention.org_id IS NOT NULL),
                        'type', CASE WHEN o_mention.org_id IS NOT NULL THEN 'COMPANY' ELSE 'USER' END,
                        'slug', o_mention.slug
                    )), '[]'::json)
                    FROM (
                        SELECT DISTINCT (regexp_matches(COALESCE(sp.content, ''), '@\\[[^\\]]+\\]\\(([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\\)', 'g'))[1]::uuid AS mentioned_id
                    ) mentions
                    LEFT JOIN active_users u_mention ON u_mention.user_id = mentions.mentioned_id
                    LEFT JOIN organizations o_mention ON o_mention.org_id = mentions.mentioned_id
                    WHERE u_mention.user_id IS NOT NULL OR o_mention.org_id IS NOT NULL
                ),
                'media', COALESCE(sp_media.media, '[]'::json),
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
                                 'avatar_url', CASE WHEN sp_sp.author_org_id IS NOT NULL THEN sp_sp_comp.logo_url ELSE sp_sp_u.avatar_url END,
                                 'author_slug', COALESCE(sp_sp_comp.slug, sp_sp_u.account_name),
                                 'is_organization_post', (sp_sp.author_org_id IS NOT NULL)
                             ),
                             'mentioned_users', (
                                 SELECT COALESCE(json_agg(json_build_object(
                                     'id', COALESCE(u_mention.user_id, o_mention.org_id),
                                     'user_id', COALESCE(u_mention.user_id, o_mention.org_id),
                                     'org_id', o_mention.org_id,
                                     'full_name', COALESCE(u_mention.full_name, o_mention.name),
                                     'account_name', COALESCE(u_mention.account_name, o_mention.slug),
                                     'is_company', (o_mention.org_id IS NOT NULL),
                                     'type', CASE WHEN o_mention.org_id IS NOT NULL THEN 'COMPANY' ELSE 'USER' END,
                                     'slug', o_mention.slug
                                 )), '[]'::json)
                                 FROM (
                                     SELECT DISTINCT (regexp_matches(COALESCE(sp_sp.content, ''), '@\\[[^\\]]+\\]\\(([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\\)', 'g'))[1]::uuid AS mentioned_id
                                 ) mentions
                                 LEFT JOIN active_users u_mention ON u_mention.user_id = mentions.mentioned_id
                                 LEFT JOIN organizations o_mention ON o_mention.org_id = mentions.mentioned_id
                                 WHERE u_mention.user_id IS NOT NULL OR o_mention.org_id IS NOT NULL
                             ),
                             'media', COALESCE((SELECT json_agg(json_build_object('url', pm.url, 'media_type', pm.media_type, 'width', pm.width, 'height', pm.height)) FROM post_media pm WHERE pm.post_id = sp_sp.post_id), '[]'::json)
                         )
                         FROM posts sp_sp
                         LEFT JOIN active_users sp_sp_u ON sp_sp_u.user_id = sp_sp.author_id
                         LEFT JOIN organizations sp_sp_comp ON sp_sp_comp.org_id = sp_sp.author_org_id
                         WHERE sp_sp.post_id = sp.shared_post_id
                     )
                     ELSE NULL
                 END,
                'like_count', (SELECT COUNT(*) FROM active_post_likes pl WHERE pl.post_id = sp.post_id)::int,
                'comment_count', (SELECT COUNT(*) FROM active_post_comments pc WHERE pc.post_id = sp.post_id)::int,
                'rePostCount', (SELECT COUNT(*) FROM posts sp_share2 WHERE sp_share2.shared_post_id = sp.post_id AND sp_share2.is_active = TRUE AND (sp_share2.is_removed IS FALSE OR sp_share2.is_removed IS NULL))::int,
                'sharePostCount', (SELECT COUNT(*) FROM shares s WHERE s.entity_type IN ('post', 'article') AND s.entity_id = sp.post_id::text)::int,
                'is_liked', EXISTS(
                    SELECT 1 FROM active_post_likes pl 
                    WHERE pl.post_id = sp.post_id 
                    AND (
                        ($3::uuid IS NOT NULL AND pl.org_id = $3::uuid)
                        OR
                        ($3::uuid IS NULL AND pl.user_id = $2 AND pl.org_id IS NULL)
                    )
                ),
                'is_reposted', EXISTS(
                    SELECT 1 FROM posts sp_rep
                    WHERE sp_rep.shared_post_id = sp.post_id 
                    AND (
                        ($3::uuid IS NOT NULL AND sp_rep.author_org_id = $3::uuid)
                        OR
                        ($3::uuid IS NULL AND sp_rep.author_id = $2 AND sp_rep.author_org_id IS NULL)
                    )
                    AND sp_rep.is_active = TRUE
                    AND (sp_rep.is_removed IS FALSE OR sp_rep.is_removed IS NULL)
                ),
              'is_reposted_with_thoughts', EXISTS(
                    SELECT 1 FROM posts sp_rep
                    WHERE sp_rep.shared_post_id = sp.post_id 
                    AND (
                        ($3::uuid IS NOT NULL AND sp_rep.author_org_id = $3::uuid)
                        OR
                        ($3::uuid IS NULL AND sp_rep.author_id = $2 AND sp_rep.author_org_id IS NULL)
                    )
                    AND sp_rep.is_active = TRUE
                    AND (sp_rep.is_removed IS FALSE OR sp_rep.is_removed IS NULL)
                AND sp_rep.content IS NOT NULL AND TRIM(sp_rep.content) != ''
              ),
                'repost_id', (
                    SELECT sp_rep.post_id FROM posts sp_rep
                    WHERE sp_rep.shared_post_id = sp.post_id 
                    AND (
                        ($3::uuid IS NOT NULL AND sp_rep.author_org_id = $3::uuid)
                        OR
                        ($3::uuid IS NULL AND sp_rep.author_id = $2 AND sp_rep.author_org_id IS NULL)
                    )
                    AND sp_rep.is_active = TRUE
                    AND (sp_rep.is_removed IS FALSE OR sp_rep.is_removed IS NULL)
                    LIMIT 1
                ),
                'liked_users', (
                    SELECT COALESCE(
                        json_agg(json_build_object(
                            'username', COALESCE(comp_like.name, comp_like.slug, u_like.full_name, u_like.account_name),
                            'avatar_url', COALESCE(comp_like.logo_url, u_like.avatar_url),
                            'is_company', (sub.org_id IS NOT NULL),
                            'is_organization', (sub.org_id IS NOT NULL)
                        )),
                        '[]'::json
                    )
                    FROM (
                        SELECT pl_sample.user_id, pl_sample.org_id
                        FROM active_post_likes pl_sample
                        WHERE pl_sample.post_id = sp.post_id
                          AND NOT (
                              ($3::uuid IS NOT NULL AND pl_sample.org_id IS NOT NULL AND pl_sample.org_id = $3::uuid)
                              OR
                              ($3::uuid IS NULL AND pl_sample.user_id = $2 AND pl_sample.org_id IS NULL)
                          )
                          ${companyId ? `
                          AND NOT EXISTS (
                              SELECT 1 FROM blocks b 
                              WHERE (b.is_org_block = true AND pl_sample.org_id IS NULL AND ((b.blocker_id = $3 AND b.blocked_id = pl_sample.user_id) OR (b.blocker_id = pl_sample.user_id AND b.blocked_id = $3)))
                                 OR (b.is_org_block = true AND pl_sample.org_id IS NOT NULL AND ((b.blocker_id = pl_sample.org_id AND b.blocked_id = $3) OR (b.blocker_id = $3 AND b.blocked_id = pl_sample.org_id)))
                          )
                          ` : `
                          AND NOT EXISTS (
                              SELECT 1 FROM blocks b 
                              WHERE (b.is_org_block = false AND pl_sample.org_id IS NULL AND ((b.blocker_id = $2 AND b.blocked_id = pl_sample.user_id) OR (b.blocker_id = pl_sample.user_id AND b.blocked_id = $2)))
                                 OR (b.is_org_block = true AND pl_sample.org_id IS NOT NULL AND ((b.blocker_id = pl_sample.org_id AND b.blocked_id = $2) OR (b.blocker_id = $2 AND b.blocked_id = pl_sample.org_id)))
                          )
                          `}
                        ORDER BY pl_sample.created_at DESC
                        LIMIT 3
                    ) sub
                    LEFT JOIN active_users u_like ON u_like.user_id = sub.user_id
                    LEFT JOIN organizations comp_like ON comp_like.org_id = sub.org_id
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
                                ($3::uuid IS NOT NULL AND pv_u.org_id = $3::uuid)
                                OR
                                ($3::uuid IS NULL AND pv_u.voter_id = $2 AND pv_u.org_id IS NULL)
                            )
                            LIMIT 1
                        ),
                        'is_active', (pp.created_at + COALESCE(pp.duration, '1 day')::interval > NOW()),
                        'options',
                        COALESCE(
                            (
                                SELECT json_agg(
                                    json_build_object(
                                        'option_id', po.option_id,
                                        'option_text', po.option_text,
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
                    WHERE pp.post_id = sp.post_id
                )
            )
        -- Failure Analysis
        WHEN sp.visibility = 'private' THEN json_build_object(
            'is_accessible', false, 
            'reason', 'private',
            'author', json_build_object(
                'user_id', COALESCE(sp.author_org_id, sp_u.user_id),
                'full_name', COALESCE(sp_comp.name, sp_u.full_name),
                'avatar_url', CASE WHEN sp.author_org_id IS NOT NULL THEN sp_comp.logo_url ELSE sp_u.avatar_url END
            )
        )
        WHEN (sp.visibility = 'public' AND sp_cat.name = 'Personal') THEN json_build_object(
            'is_accessible', false, 
            'reason', 'personal_connection',
            'author', json_build_object(
                'user_id', COALESCE(sp.author_org_id, sp_u.user_id),
                'full_name', COALESCE(sp_comp.name, sp_u.full_name),
                'avatar_url', CASE WHEN sp.author_org_id IS NOT NULL THEN sp_comp.logo_url ELSE sp_u.avatar_url END
            )
        )
        ELSE 
            json_build_object('is_accessible', false, 'reason', 'unknown')
    END AS shared_post

FROM posts p
JOIN active_users u ON u.user_id = p.author_id
LEFT JOIN organizations comp ON comp.org_id = p.author_org_id
LEFT JOIN post_categories c ON p.category_id = c.category_id
LEFT JOIN achievement_images ai ON p.achievement_image_id = ai.id

-- Shared Post Joins
LEFT JOIN posts sp ON p.shared_post_id = sp.post_id
LEFT JOIN active_users sp_u ON sp.author_id = sp_u.user_id
LEFT JOIN organizations sp_comp ON sp_comp.org_id = sp.author_org_id
LEFT JOIN post_categories sp_cat ON sp.category_id = sp_cat.category_id
        LEFT JOIN jobs sj ON p.shared_job_id = sj.job_id
        LEFT JOIN organizations sj_comp ON sj.org_id = sj_comp.org_id
LEFT JOIN (
    SELECT post_id, json_agg(json_build_object('url', url, 'media_type', media_type)) as media
    FROM post_media
    GROUP BY post_id
) sp_media ON sp.post_id = sp_media.post_id

WHERE p.post_id = $1 
  AND p.is_active = TRUE 
  AND (p.is_removed IS FALSE OR p.is_removed IS NULL)
  AND (
      (p.author_org_id IS NULL AND u.is_deactivated = FALSE AND (u.is_deleted IS NULL OR u.is_deleted = FALSE))
      OR 
      (p.author_org_id IS NOT NULL AND comp.is_deleted = FALSE AND comp.deletion_execute_at IS NULL AND comp.is_deactivated = FALSE)
  )
  AND (
      p.shared_post_id IS NULL 
      OR (
          (sp.author_org_id IS NULL AND sp_u.is_deactivated = FALSE AND (sp_u.is_deleted IS NULL OR sp_u.is_deleted = FALSE))
          OR
          (sp.author_org_id IS NOT NULL AND sp_comp.is_deleted = FALSE AND sp_comp.is_deactivated = FALSE)
      )
  );
`

        const result = await pool.query(query, [postId, userId, companyId || null]);

        if (result.rows.length === 0) {
            return res.status(404).json({ message: "Post not found" });
        }

        // STRICT BLOCK CHECK (identity-aware)
        // Use the active identity (companyId when acting as company, userId when personal)
        // so personal blocks don't leak into company profile context
        const post = result.rows[0];
        if (userId) {
            const activeActorId = companyId || userId;
            if (post.author_org_id) {
                const isBlocked = await BlockModel.isAnyBlocked(activeActorId, post.author_org_id);
                if (isBlocked) {
                    return res.status(404).json({ message: "Post not found" });
                }
            } else if (post.author_id && post.author_id !== userId) {
                const isBlocked = await BlockModel.isAnyBlocked(activeActorId, post.author_id);
                if (isBlocked) {
                    return res.status(404).json({ message: "Post not found" });
                }
            }
        }

        // Check if the user is authorized because the post is shared in a conversation they participate in
        let isSharedWithUser = false;
        if (userId) {
            const shareCheck = await pool.query(
                `SELECT 1 FROM messages m
                 JOIN conversation_participants cp ON m.conversation_id = cp.conversation_id
                 WHERE (m.shared_post_id = $1 OR m.text_content LIKE $4) AND (cp.user_id = $2 OR (cp.org_id IS NOT NULL AND cp.org_id = $3))`,
                [postId, userId, companyId || null, `%${postId}%`]
            );
            if (shareCheck.rowCount > 0) {
                isSharedWithUser = true;
            }
        }

        // STRICT VISIBILITY CHECK
        if (post.visibility === 'private' && !isSharedWithUser) {
            if (!userId) {
                return res.status(403).json({ message: "You are not authorized to view this private post." });
            }
            if (post.author_org_id) {
                if (!companyId || companyId !== post.author_org_id) {
                    const checkMember = await pool.query(
                        `SELECT 1 FROM organization_members WHERE org_id = $1 AND user_id = $2 AND status = 'ACTIVE'`,
                        [post.author_org_id, userId]
                    );
                    if (checkMember.rowCount === 0) {
                        return res.status(403).json({ message: "You are not authorized to view this private post." });
                    }
                }
            } else {
                if (post.author_id !== userId) {
                    return res.status(403).json({ message: "You are not authorized to view this private post." });
                }
            }
        }

        if (post.visibility === 'public' && post.category_name === 'Personal' && !isSharedWithUser) {
            if (!userId) {
                return res.status(403).json({ message: "This post is only visible to connections." });
            }
            if (post.author_id !== userId) {
                const connectionCheck = await pool.query(
                    `SELECT 1 FROM followers f1 
                     JOIN followers f2 ON f1.follower_id = f2.following_id AND f1.following_id = f2.follower_id 
                     WHERE f1.follower_id = $1 AND f1.following_id = $2`,
                    [userId, post.author_id]
                );
                if (connectionCheck.rowCount === 0) {
                    return res.status(403).json({ message: "This post is only visible to connections." });
                }
            }
        }

        // STRICT DRAFT STATUS CHECK
        if (post.is_community_article && post.status === 'draft' && !isSharedWithUser) {
            if (!post.author_org_id) {
                if (post.author_id !== userId) {
                    return res.status(403).json({ message: "Forbidden: You cannot view this draft" });
                }
            } else {
                const checkMember = await pool.query(
                    `SELECT 1 FROM organization_members WHERE org_id = $1 AND user_id = $2 AND status = 'ACTIVE'`,
                    [post.author_org_id, userId]
                );
                if (checkMember.rowCount === 0) {
                    return res.status(403).json({ message: "Forbidden: You cannot view this draft" });
                }
            }
        }

        const hydratedArray = await hydrateShareCounts([post]);
        const finalPost = hydratedArray[0];

        const mappedPost = {
            ...finalPost,
            id: finalPost.post_id,
            channelId: finalPost.author_org_id,
            created_by_user_id: finalPost.author_id,
            coverImage: (post.media && post.media.length > 0) ? post.media[0].url : null,
            publishedAt: post.created_at,
            updatedAt: post.updated_at
        };

        // If this is a community article, check if the requesting user is subscribed
        if (post.is_community_article && post.community_id && userId) {
            const subCheck = await pool.query(
                `SELECT 1 FROM community_subscriptions
                 WHERE community_id = $1 AND user_id = $2 AND status = 'SUBSCRIBED'`,
                [post.community_id, userId]
            );
            mappedPost.isSubscribed = subCheck.rowCount > 0;
            mappedPost.is_subscribed = mappedPost.isSubscribed;
        } else if (post.is_community_article) {
            // Not logged in or no community → default to false
            mappedPost.isSubscribed = false;
            mappedPost.is_subscribed = false;
        }

        res.status(200).json(mappedPost);
    } catch (err) {
        console.error("Get post error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.updatePostById = async (req, res) => {
    const postId = req.params.id;
    let { content, category, visibility, media_urls, post_type, title, poll_options, location, status } = req.body;
    // "media" is inline content images/videos; "cover_media" (article posts only) is
    // the explicitly chosen cover - kept on its own field so we never have to guess.
    const mediaFiles = (req.files && req.files.media) || [];
    const coverFiles = (req.files && req.files.cover_media) || [];

    if (status !== undefined && status !== "published" && status !== "draft") {
        return res.status(400).json({ message: "Invalid status. Allowed values: 'published', 'draft'" });
    }

    // Sanitize user-generated content
    if (post_type !== 'article') {
        content = sanitizeContent(content);
    } else {
        content = sanitizeArticleContent(content);
    }
    title = sanitizeContent(title);
    if (poll_options && Array.isArray(poll_options)) {
        poll_options = poll_options.map(opt => sanitizeContent(opt));
    }
    let actorScope;

    try {
        actorScope = getContentActorScope(req, req.body?.companyId || null);
    } catch (err) {
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }

    const { userId, orgId } = actorScope;

    if (!postId || !userId) {
        return res.status(400).json({ message: "postId and userId are required" });
    }

    const client = await pool.connect(); // Use transaction for media consistency
    try {
        await client.query('BEGIN');

        // 1. Safety check for polls
        if (post_type === 'poll') {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: "You cannot edit a poll once created" });
        }

        // 2. Fetch Post & Check Permissions (CRITICAL FIX)
        const postCheck = await client.query(`SELECT author_id, author_org_id, post_type, shared_post_id, shared_job_id, is_removed, is_deleted, is_unlisted, content FROM posts WHERE post_id = $1`, [postId]);
        if (postCheck.rowCount === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ message: "Post not found" });
        }
        const { author_id, author_org_id, post_type: currentPostType, shared_post_id, shared_job_id, is_removed, is_deleted, is_unlisted, content: currentContent } = postCheck.rows[0];

        // Infer / resolve new post_type
        let newPostType = post_type;
        if (!newPostType && Array.isArray(media_urls) && currentPostType !== 'poll' && currentPostType !== 'article') {
            if (media_urls.length === 0) {
                newPostType = 'text';
            } else {
                const firstItem = media_urls[0];
                const firstUrl = typeof firstItem === 'object' && firstItem !== null ? firstItem.url : firstItem;
                if (firstUrl) {
                    newPostType = firstUrl.toLowerCase().match(/\.(mp4|webm|mov)(\?|#|$)/i) ? 'video' : 'image';
                }
            }
        }

        const effectivePostType = newPostType || currentPostType;
        if (effectivePostType === 'article') {
            // Cover comes unambiguously from the dedicated field when the caller sends
            // one (the Channels article editor always does) - no more guessing, and no
            // more accidentally clobbering the media_urls the client already sent.
            // Callers that don't send cover_media (e.g. the personal "write article"
            // composer) keep the legacy "unmatched file = cover" fallback below.
            let coverFileUrl = coverFiles.length > 0
                ? (coverFiles[0].path || coverFiles[0].secure_url || '').replace(/\\/g, "/")
                : null;
            // Everything in "media" is an inline content image/video - rewrite its blob
            // src to the real URL. Match on the basename without extension since blob:
            // URLs (e.g. "blob:http://host/<uuid>") carry no file extension.
            mediaFiles.forEach(file => {
                const fileUrl = (file.path || file.secure_url || '').replace(/\\/g, "/");
                const baseName = file.originalname.replace(/\.[^/.]+$/, '');

                if (content && baseName && content.includes(baseName)) {
                    const regex = new RegExp(`src="[^"]*${baseName}[^"]*"`, 'g');
                    content = content.replace(regex, `src="${fileUrl}"`);
                } else if (coverFiles.length === 0) {
                    coverFileUrl = fileUrl;
                }
            });
            if (coverFileUrl) {
                media_urls = [coverFileUrl];
            }
        }

        if (is_removed || is_deleted || is_unlisted) {
            await client.query("ROLLBACK");
            return res.status(403).json({ message: "Cannot edit a post that has been removed by moderation." });
        }

        let canEdit = false;

        if (author_org_id) {
            if (orgId && author_org_id === orgId) {
                // ===========================================================================
                // [SCRUM-1367]
                // Previously:
                // if (author_id === userId) {
                //     canEdit = true;
                // } else {
                //     const hasPerm = await checkOrgPermission(client, orgId, userId, ["MANAGE_CONTENT", "MANAGE_ORGANIZATION", "MANAGE_ORGANIZATION_DETAILS", "MANAGE_COMPANY", "MANAGE_COMPANY_DETAILS"]);
                //     const isOrgOwner = await client.query(`SELECT 1 FROM organizations WHERE org_id = $1 AND created_by = $2`, [orgId, userId]);
                //     if (hasPerm || isOrgOwner.rowCount > 0) canEdit = true;
                // }
                //
                // Reason for update:
                // MANAGE_COMPANY_DETAILS (Profile Management) previously granted post edit/delete.
                // Per SCRUM-1367, company post editing is strictly controlled by Post Interactions
                // (CREATE_POST / CREATE_CONTENT / MANAGE_CONTENT) along with Owner and Admin roles.
                // Team members without Post Interactions are not permitted to edit company posts.
                // ===========================================================================
                const isOrgOwner = await client.query(`SELECT 1 FROM organizations WHERE org_id = $1 AND created_by = $2`, [orgId, userId]);
                const isOwner = isOrgOwner.rowCount > 0 || req.actor?.roleName === 'Owner' || (req.actor?.permissions && req.actor?.permissions.includes('*'));
                const isAdmin = (req.actor?.roleName || '').toUpperCase() === 'ADMIN' || isOwner;

                // Post Interactions permission: CREATE_POST or CREATE_CONTENT
                const { checkOrgPermission } = require("../../core/utils/rbac");
                const hasPostInteractions = await checkOrgPermission(client, orgId, userId, ["CREATE_POST", "CREATE_CONTENT", "MANAGE_CONTENT"]);

                if (isOwner || isAdmin || hasPostInteractions) {
                    canEdit = true;
                }
            }
        } else {
            if (!orgId && author_id === userId) {
                canEdit = true;
            }
        }

        if (!canEdit) {
            await client.query("ROLLBACK");
            return res.status(403).json({ message: "You do not have post interaction permissions to edit company posts" });
        }


        // 3. Resolve category ID
        const updates = [];
        const values = [];
        let index = 1;

        // post_type
        if (newPostType !== undefined) {
            // Prevent changing to or from poll or article via standard update
            if (currentPostType !== 'poll' && currentPostType !== 'article') {
                if (newPostType !== 'poll' && newPostType !== 'article') {
                    let normalizedType = newPostType;
                    if (normalizedType === 'carousel' || normalizedType === 'photo') {
                        normalizedType = 'image';
                    }
                    updates.push(`post_type = $${index++}`);
                    values.push(normalizedType);
                }
            }
        }

        // title
        if (title !== undefined) {
            // Prevent wiping out the poll question if title is empty string
            if (effectivePostType === 'poll' && title.trim() === '') {
                // Ignore the empty title update for polls to preserve the question
            } else {
                updates.push(`title = $${index++}`);
                values.push(title);
            }
        }

        // content
        if (content !== undefined) {
            if (effectivePostType === 'text' && !shared_post_id && !shared_job_id) {
                if (!content || content.trim().length === 0) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ message: "Post content cannot be empty" });
                }
            }
            updates.push(`content = $${index++}`);
            values.push(content);
        } else if (effectivePostType === 'text' && currentPostType !== 'text' && !shared_post_id && !shared_job_id) {
            if (!currentContent || currentContent.trim().length === 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ message: "Post content cannot be empty" });
            }
        }

        // location
        if (location !== undefined) {
            updates.push(`location = $${index++}`);
            values.push(location);
        }

        // status
        if (status !== undefined) {
            updates.push(`status = $${index++}`);
            values.push(status);
        }

        // visibility
        if (visibility !== undefined) {
            // Repost privacy lock logic
            const currentPostRes = await client.query('SELECT shared_post_id FROM posts WHERE post_id = $1', [postId]);
            const sharedPostId = currentPostRes.rows[0]?.shared_post_id;

            if (sharedPostId && visibility === 'public') {
                const originalPostRes = await client.query(`
                    SELECT p.visibility, c.name as category_name 
                    FROM posts p 
                    LEFT JOIN post_categories c ON p.category_id = c.category_id 
                    WHERE p.post_id = $1
                `, [sharedPostId]);

                if (originalPostRes.rows.length > 0) {
                    const original = originalPostRes.rows[0];
                    if (original.visibility === 'private' || original.category_name === 'Personal') {
                        await client.query('ROLLBACK');
                        return res.status(403).json({
                            message: "You cannot make this repost public because the original post is private or restricted."
                        });
                    }
                }
            }

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
            if (catRes.rows.length > 0) {
                updates.push(`category_id = $${index++}`);
                values.push(catRes.rows[0].category_id);
            }
        }

        if (updates.length === 0 && !media_urls) {
            await client.query('ROLLBACK'); // Ensure rollback if early exit
            return res.status(400).json({ message: "No fields provided to update" });
        }

        // 4. Update main post content
        if (updates.length > 0) {
            // Add the ID and UserID to the values array
            values.push(postId);
            const postIndex = values.length;

            const updateQuery = `
        UPDATE posts
        SET ${updates.join(", ")}, updated_at = NOW()
        WHERE post_id = $${postIndex}
    `;
            const postUpdate = await client.query(updateQuery, values);

            if (postUpdate.rowCount === 0) {
                await client.query("ROLLBACK");
                return res.status(404).json({ message: "Post not found or unauthorized" });
            }

            // Removed event outbox insert for POST_UPDATED
        }


        let type;
        let parsedMediaMetadata = [];
        if (req.body.media_metadata) {
            try {
                parsedMediaMetadata = typeof req.body.media_metadata === 'string' ? JSON.parse(req.body.media_metadata) : req.body.media_metadata;
            } catch (e) {
                console.error('Failed to parse media_metadata in update', e);
            }
        }

        // 5. Update Media: The "Sync" approach
        if (Array.isArray(media_urls)) {
            const oldMediaRes = await client.query(`SELECT url FROM post_media WHERE post_id = $1`, [postId]);
            const oldUrls = oldMediaRes.rows.map(r => r.url).filter(Boolean);

            await client.query(`DELETE FROM post_media WHERE post_id = $1`, [postId]);

            const newUrls = [];
            for (let i = 0; i < media_urls.length; i++) {
                const item = media_urls[i];
                const url = typeof item === 'object' && item !== null ? item.url : item;
                if (!url) continue;
                newUrls.push(url);
                
                const width = (parsedMediaMetadata[i] && parsedMediaMetadata[i].width) || (typeof item === 'object' && item !== null ? item.width : null);
                const height = (parsedMediaMetadata[i] && parsedMediaMetadata[i].height) || (typeof item === 'object' && item !== null ? item.height : null);
                
                const type = url.match(/\.(mp4|webm|mov)(\?|#|$)/i) ? "video" : "image";
                await client.query(
                    `INSERT INTO post_media (post_id, url, media_type, width, height)
       VALUES ($1, $2, $3, $4, $5)`,
                    [postId, url, type, width, height]
                );
            }

            const removedUrls = oldUrls.filter(u => !newUrls.includes(u));
            if (removedUrls.length > 0) {
                deleteR2Assets(removedUrls).catch(err => console.error("[updatePostById] R2 cleanup error:", err.message));
            }
        }



        if (author_org_id) {
            const auditClient = await pool.connect();
            try {
                await logAudit(auditClient, {
                    entityId: author_org_id,
                    actorId: userId,
                    actorRole: req.actor?.roleName || null,
                    action: 'EDIT_POST',
                    metadata: {
                        type: 'post',
                        id: postId,
                        title: title || content?.substring(0, 20) || "Updated Post"
                    }
                });
            } finally {
                auditClient.release();
            }
        }

        await client.query('COMMIT');

        // Handle Hashtags asynchronously without outbox
        const { processHashtags } = require("../../workers/eventOutboxWorker");
        processHashtags(pool, 'POST_UPDATED', postId).catch(err => console.error("Hashtag process error:", err));

        const query = `
SELECT 
    p.*, 
    c.name AS category_name,
    -- Media Subquery
    COALESCE(
        (SELECT json_agg(json_build_object(
            'media_id', pm.media_id,
            'url', pm.url,
            'media_type', pm.media_type,
            'width', pm.width,
            'height', pm.height
        )) FROM post_media pm WHERE pm.post_id = p.post_id),
        '[]'::json
    ) AS media,
    -- Corrected Poll Subquery
    (SELECT json_build_object(
        'poll_id', pp.poll_id,
        'duration', COALESCE(pp.duration, '1 day'),
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

        const post = result.rows[0];

        // Real-time channel article update notification for subscribers
        if (post.author_org_id && post.post_type === 'article' && post.status === 'published') {
            broadcastChannelArticlePublished(post.author_org_id, {
                id: post.post_id,
                title: post.title,
                createdAt: post.created_at
            }).catch(err => console.error("Error in broadcastChannelArticlePublished:", err));
        }

        // Mentions in post content (fire-and-forget, after commit)
        if (content && typeof content === 'string') {
            const mentionedUsernames = [];
            const regex1 = /@\[[^\]]+\]\(([^)]+)\)/g;
            let m;
            while ((m = regex1.exec(content)) !== null) {
                if (!mentionedUsernames.includes(m[1])) mentionedUsernames.push(m[1]);
            }
            const regex2 = /(?:^|\s)@(\w+)(?!\w)/g;
            while ((m = regex2.exec(content)) !== null) {
                if (!mentionedUsernames.includes(m[1])) mentionedUsernames.push(m[1]);
            }

            if (mentionedUsernames.length > 0) {
                console.log("[updatePostById] Mentions detected:", mentionedUsernames);
                // Fetch actor details
                let actorName = "Someone";
                let actorAvatar = null;
                if (orgId) {
                    const orgRes = await pool.query(`SELECT name, logo_url FROM organizations WHERE org_id = $1`, [orgId]);
                    if (orgRes.rowCount > 0) {
                        actorName = orgRes.rows[0].name;
                        actorAvatar = orgRes.rows[0].logo_url;
                    }
                } else {
                    const userRes = await pool.query(`SELECT full_name, avatar_url FROM users WHERE user_id = $1`, [userId]);
                    if (userRes.rowCount > 0) {
                        actorName = userRes.rows[0].full_name;
                        actorAvatar = userRes.rows[0].avatar_url;
                    }
                }

                for (const handle of mentionedUsernames) {
                    let userRes;
                    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
                    if (UUID_REGEX.test(handle)) {
                        userRes = await pool.query(`SELECT user_id FROM users WHERE user_id = $1`, [handle]);
                    } else {
                        userRes = await pool.query(`SELECT user_id FROM users WHERE LOWER(account_name) = LOWER($1)`, [handle]);
                    }
                    if (userRes.rowCount > 0) {
                        const mentionedUserId = userRes.rows[0].user_id;
                        let isSelf = (!orgId && mentionedUserId === userId);

                        if (!isSelf) {
                            if (!orgId) {
                                const isBlockedByMentioned = await checkBlockStatus(mentionedUserId, userId);
                                const hasBlockedMentioned = await checkBlockStatus(userId, mentionedUserId);
                                if (isBlockedByMentioned || hasBlockedMentioned) continue;
                            }

                            // Check if a notification already exists for this mention in this post
                            const existingNotif = await pool.query(
                                `SELECT notification_id FROM notifications WHERE user_id = $1 AND reference_id = $2 AND type = 'mention'`,
                                [mentionedUserId, postId]
                            );

                            if (existingNotif.rowCount === 0) {
                                const notifText = `${actorName} mentioned you in a post`;
                                const meta = { post_id: postId, org_id: orgId || null };
                                
                                const mentionNotifRes = await pool.query(
                                    `INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata) 
                                     VALUES ($1, $2, $3, $4, $5, $6) RETURNING notification_id, created_at`,
                                    [mentionedUserId, userId, 'mention', notifText, postId, JSON.stringify(meta)]
                                );

                                socketService.notifyUser(mentionedUserId, "notification", {
                                    notification_id: mentionNotifRes.rows[0].notification_id,
                                    type: 'mention',
                                    text: notifText,
                                    from: userId,
                                    senderName: actorName,
                                    senderAvatar: actorAvatar,
                                    referenceId: postId,
                                    metadata: meta,
                                    time: "Just now",
                                    created_at: mentionNotifRes.rows[0].created_at.toISOString(),
                                    is_read: false
                                });

                                sendPush(mentionedUserId, actorName, notifText, { type: 'mention', referenceId: postId, postId }).catch(() => {});
                            }
                        }
                    }
                }
            }
        }

        const mappedPost = {
            ...post,
            id: post.post_id,
            channelId: post.author_org_id,
            created_by_user_id: post.author_id,
            coverImage: (post.media && post.media.length > 0) ? post.media[0].url : null,
            publishedAt: post.created_at,
            updatedAt: post.updated_at
        };

        res.status(200).json(mappedPost);

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Update post error:", err);
        res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    } finally {
        client.release();
    }
};

// checkCompanyPermission imported from utils/rbac

exports.deletePost = async (req, res) => {
    const postId = req.params.id;
    let actorScope;

    try {
        actorScope = getContentActorScope(req, req.body?.companyId || req.query?.companyId || null);
    } catch (err) {
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }

    const { userId, orgId } = actorScope;

    if (!postId || !userId) {
        return res.status(400).json({ message: "postId and userId are required" });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Fetch Post Ownership Info
        const postRes = await client.query(
            `SELECT author_id, author_org_id FROM posts WHERE post_id = $1`,
            [postId]
        );

        if (postRes.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: "Post not found" });
        }

        const { author_id, author_org_id } = postRes.rows[0];
        let canDelete = false;

        // 2. Check Permissions
        if (author_org_id) {
            // Case A: The request is made in the context of the org that owns the post.
            if (orgId && author_org_id === orgId) {
                // ===========================================================================
                // [SCRUM-1367]
                // Previously:
                // if (author_id === userId) {
                //     canDelete = true;
                // } else {
                //     const hasPerm = await checkOrgPermission(client, orgId, userId, ["MANAGE_CONTENT", "MANAGE_ORGANIZATION", "MANAGE_ORGANIZATION_DETAILS", "MANAGE_COMPANY", "MANAGE_COMPANY_DETAILS"]);
                //     const isOrgOwner = await client.query(`SELECT 1 FROM organizations WHERE org_id = $1 AND created_by = $2`, [orgId, userId]);
                //     if (hasPerm || isOrgOwner.rowCount > 0) canDelete = true;
                // }
                //
                // Reason for update:
                // MANAGE_COMPANY_DETAILS (Profile Management) previously granted post deletion.
                // Per SCRUM-1367, company post deletion is strictly controlled by Post Interactions
                // (CREATE_POST / CREATE_CONTENT / MANAGE_CONTENT) along with Owner and Admin roles.
                // Team members without Post Interactions are not permitted to delete company posts.
                // ===========================================================================
                const isOrgOwner = await client.query(`SELECT 1 FROM organizations WHERE org_id = $1 AND created_by = $2`, [orgId, userId]);
                const isOwner = isOrgOwner.rowCount > 0 || req.actor?.roleName === 'Owner' || (req.actor?.permissions && req.actor?.permissions.includes('*'));
                const isAdmin = (req.actor?.roleName || '').toUpperCase() === 'ADMIN' || isOwner;

                // Post Interactions permission: CREATE_POST or CREATE_CONTENT
                const { checkOrgPermission } = require("../../core/utils/rbac");
                const hasPostInteractions = await checkOrgPermission(client, orgId, userId, ["CREATE_POST", "CREATE_CONTENT", "MANAGE_CONTENT"]);

                if (isOwner || isAdmin || hasPostInteractions) {
                    canDelete = true;
                }
            }
        } else {
            if (!orgId && author_id === userId) {
                canDelete = true;
            }
        }

        if (!canDelete) {
            await client.query('ROLLBACK');
            return res.status(403).json({ message: "You do not have post interaction permissions to delete company posts" });
        }

        // 3. Delete

        // Log Audit BEFORE delete (so we still have access if needed, though we already fetched info)
        if (author_org_id) {
            const auditClient = await pool.connect();
            try {
                await logAudit(auditClient, {
                    entityId: author_org_id,
                    actorId: userId,
                    actorRole: req.actor?.roleName || null,
                    action: 'DELETE_POST', // Consistent naming
                    metadata: {
                        type: 'post',
                        id: postId,
                        title: "Deleted Post"
                    }
                });
            } finally {
                auditClient.release();
            }
        }

        // Fetch post media for CDN/R2 cleanup
        const mediaRes = await client.query(
            `SELECT url FROM post_media WHERE post_id = $1`,
            [postId]
        );
        const postUrls = mediaRes.rows.map(r => r.url).filter(Boolean);

        await client.query(
            `UPDATE posts SET is_active = FALSE WHERE post_id = $1 OR shared_post_id = $1`,
            [postId]
        );

        await client.query('COMMIT');

        // Clean up media from Cloudflare R2
        if (postUrls.length > 0) {
            deleteR2Assets(postUrls).catch(err => console.error("[deletePost] R2 cleanup error:", err.message));
        }

        res.status(200).json({ message: "Post deleted", deletedPostId: postId, id: postId });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Delete post error:", err);
        res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    } finally {
        client.release();
    }
}

// --- APPEALS ---
exports.submitPostAppeal = async (req, res) => {
    const postId = req.params.id;
    const { reason } = req.body;

    let actorScope;
    try {
        actorScope = getContentActorScope(req, req.body?.companyId || null);
    } catch (err) {
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }

    const { userId } = actorScope;

    if (!postId || !reason) {
        return res.status(400).json({ message: "postId and reason are required" });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Verify post exists and is unlisted
        const postRes = await client.query(
            `SELECT author_id, is_unlisted FROM posts WHERE post_id = $1`,
            [postId]
        );

        if (postRes.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: "Post not found" });
        }

        const post = postRes.rows[0];

        // Ensure user is the author
        if (post.author_id !== userId) {
            await client.query('ROLLBACK');
            return res.status(403).json({ message: "You can only appeal your own posts" });
        }

        if (!post.is_unlisted) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: "Post is not unlisted, appeal not required" });
        }

        // Check for existing pending appeal
        const existingAppeal = await client.query(
            `SELECT appeal_id FROM post_appeals WHERE post_id = $1 AND status = 'pending'`,
            [postId]
        );

        if (existingAppeal.rowCount > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: "An appeal is already pending for this post" });
        }

        // Create appeal
        await client.query(
            `INSERT INTO post_appeals (post_id, user_id, appeal_reason, status) VALUES ($1, $2, $3, 'pending')`,
            [postId, userId, reason]
        );

        await client.query('COMMIT');
        res.status(201).json({ success: true, message: "Appeal submitted successfully" });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Submit appeal error:", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
}

// --- POLL INTERACTION ---
exports.voteInPoll = async (req, res) => {
    const { id: postId } = req.params;
    const { option_id } = req.body;

    let actorScope;

    try {
        actorScope = getContentActorScope(req, req.body?.companyId || null);
    } catch (err) {
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }

    const { userId, orgId: companyId } = actorScope;

    try {
        // RBAC check: if acting as an organization, ensure member has permission
        if (companyId) {
            const hasPermission = await checkOrgPermission(pool, companyId, userId, ['CREATE_POST', 'CREATE_CONTENT']);
            if (!hasPermission) {
                return res.status(403).json({ message: "You do not have permission to interact with posts for this organization" });
            }
        }

        // 1. Check if poll exists and if it's still active using DB logic
        const pollRes = await pool.query(
            `SELECT pp.poll_id, 
             (pp.created_at + COALESCE(pp.duration, '1 day')::interval > NOW()) as is_active 
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

        // 3. Cast Vote with Identity Isolation
        if (companyId) {
            await pool.query(
                `INSERT INTO poll_votes (voter_id, poll_id, option_id, org_id) 
                 VALUES ($1, $2, $3, $4) 
                 ON CONFLICT (poll_id, org_id) WHERE org_id IS NOT NULL
                 DO UPDATE SET option_id = $3`,
                [userId, poll_id, option_id, companyId]
            );
        } else {
            await pool.query(
                `INSERT INTO poll_votes (voter_id, poll_id, option_id) 
                 VALUES ($1, $2, $3) 
                 ON CONFLICT (poll_id, voter_id) WHERE org_id IS NULL
                 DO UPDATE SET option_id = $3`,
                [userId, poll_id, option_id]
            );
        }

        res.status(200).json({ message: "Vote recorded successfully" });

        // 🎯 Intent Layer: Log Poll Vote
        logIntentActivity({ userId, action: "vote_poll", metadata: { postId, pollId: poll_id, optionId: option_id } });

        // 📝 Log Activity: Poll Vote
        logActivity(userId, 'vote_poll', 'poll', poll_id, { option_id, post_id: postId });

    } catch (err) {

        console.error("Vote error:", err);
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }
}

exports.removeVote = async (req, res) => {
    const { id: postId } = req.params;
    let actorScope;

    try {
        actorScope = getContentActorScope(req, req.body?.companyId || null);
    } catch (err) {
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }

    const { userId, orgId: companyId } = actorScope;

    try {
        // RBAC check: if acting as an organization, ensure member has permission
        if (companyId) {
            const hasPermission = await checkOrgPermission(pool, companyId, userId, ['CREATE_POST', 'CREATE_CONTENT']);
            if (!hasPermission) {
                return res.status(403).json({ message: "You do not have permission to interact with posts for this organization" });
            }
        }

        const pollRes = await pool.query(
            `SELECT poll_id, (created_at + COALESCE(duration, '1 day')::interval > NOW()) as is_active 
             FROM post_polls WHERE post_id = $1`,
            [postId]
        );

        if (pollRes.rowCount === 0) return res.status(404).json({ message: "Poll not found" });
        const { poll_id, is_active } = pollRes.rows[0];

        if (!is_active) {
            return res.status(403).json({ message: "Cannot change votes on an ended poll" });
        }

        if (companyId) {
            await pool.query(
                `DELETE FROM poll_votes WHERE org_id = $1 AND poll_id = $2`,
                [companyId, poll_id]
            );
        } else {
            await pool.query(
                `DELETE FROM poll_votes WHERE voter_id = $1 AND poll_id = $2 AND org_id IS NULL`,
                [userId, poll_id]
            );
        }

        res.status(200).json({ message: "Vote removed successfully" });

        // 📝 Remove Activity: Poll Vote
        removeActivity(userId, 'vote_poll', poll_id);
    } catch (err) {

        console.error("Remove vote error:", err);
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }
};

// --- SOCIAL ENGAGEMENT ---
exports.toggleLike = async (req, res) => {
    const postId = req.params.id;
    let actorScope;

    try {
        actorScope = getContentActorScope(req, req.body?.companyId || null);
    } catch (err) {
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }

    const { userId, orgId: companyId } = actorScope;

    try {
        if (companyId) {
            const hasPerm = await checkOrgPermission(pool, companyId, userId, ['CREATE_POST', 'CREATE_CONTENT']);
            if (!hasPerm) {
                return res.status(403).json({ message: "You do not have permission to interact with posts on behalf of this organization." });
            }
        }

        // 1️⃣ Check if already liked
        let alreadyLiked;
        if (companyId) {
            alreadyLiked = await pool.query(
                "SELECT 1 FROM active_post_likes WHERE post_id = $1 AND org_id = $2",
                [postId, companyId]
            );
        } else {
            alreadyLiked = await pool.query(
                "SELECT 1 FROM active_post_likes WHERE post_id = $1 AND user_id = $2 AND org_id IS NULL",
                [postId, userId]
            );
        }

        let liked;

        if (alreadyLiked.rowCount > 0) {
            // 2️⃣ Unlike
            if (companyId) {
                await pool.query(
                    "DELETE FROM post_likes WHERE post_id = $1 AND org_id = $2",
                    [postId, companyId]
                );
            } else {
                await pool.query(
                    "DELETE FROM post_likes WHERE post_id = $1 AND user_id = $2 AND org_id IS NULL",
                    [postId, userId]
                );
            }
            liked = false;

            // 📝 Remove Activity: Like Post
            removeActivity(userId, 'like_post', postId);
        } else {

            // 3️⃣ Like
            if (companyId) {
                await pool.query(
                    "INSERT INTO post_likes (post_id, user_id, org_id) VALUES ($1, $2, $3)",
                    [postId, userId, companyId]
                );
                let authorName = null;
                let authorId = null;
                let authorType = 'user';
                try {
                    const postAuthorRes = await pool.query(
                        `SELECT p.author_id, p.author_org_id, 
                                COALESCE(o.name, u.full_name) AS author_name
                         FROM posts p
                         LEFT JOIN organizations o ON p.author_org_id = o.org_id
                         LEFT JOIN users u ON p.author_id = u.user_id
                         WHERE p.post_id = $1`,
                        [postId]
                    );
                    if (postAuthorRes.rowCount > 0) {
                        const row = postAuthorRes.rows[0];
                        authorName = row.author_name;
                        authorId = row.author_org_id || row.author_id;
                        authorType = row.author_org_id ? 'organization' : 'user';
                    }
                } catch (e) {
                    console.error("Error resolving post author for like audit log:", e);
                }

                await logAudit(pool, {
                    entityId: companyId,
                    actorId: userId,
                    actorRole: req.actor?.roleName || null,
                    action: 'LIKE',
                    metadata: { 
                        postId,
                        authorName,
                        targetName: authorName,
                        authorId,
                        authorType
                    }
                });
            } else {
                await pool.query(
                    "INSERT INTO post_likes (post_id, user_id) VALUES ($1, $2)",
                    [postId, userId]
                );
            }
            liked = true;

            // 📝 Log Activity: Like Post
            logActivity(userId, 'like_post', 'post', postId);
        }


        // 4️⃣ Get UPDATED count and actor's username
        const countResult = await pool.query(
            "SELECT COUNT(*) FROM active_post_likes WHERE post_id = $1",
            [postId]
        );

        const likeCount = Number(countResult.rows[0].count);

        let actorInfo = {
            userId: null,
            username: null,
            fullName: null,
            avatar: null
        };
        if (companyId) {
            const orgResult = await pool.query(
                "SELECT org_id, slug, name, logo_url FROM organizations WHERE org_id = $1",
                [companyId]
            );
            if (orgResult.rowCount > 0) {
                const org = orgResult.rows[0];
                actorInfo = {
                    userId: org.org_id,
                    username: org.slug,
                    fullName: org.name,
                    avatar: org.logo_url
                };
            }
        } else {
            const userResult = await pool.query(
                "SELECT user_id, account_name, full_name, avatar_url FROM users WHERE user_id = $1",
                [userId]
            );
            if (userResult.rowCount > 0) {
                const user = userResult.rows[0];
                actorInfo = {
                    userId: user.user_id,
                    username: user.account_name,
                    fullName: user.full_name,
                    avatar: user.avatar_url
                };
            }
        }

        // 🔔 Notify Author (In-App unconditional, Push conditional)
        if (liked) {
            const postRes = await pool.query("SELECT author_id, author_org_id FROM posts WHERE post_id = $1", [postId]);
            if (postRes.rowCount > 0) {
                const authorId = postRes.rows[0].author_id;
                const authorCompanyId = postRes.rows[0].author_org_id;

                // Don't notify if self
                let isSelf = (!companyId && !authorCompanyId && authorId === userId);
                if (companyId && authorCompanyId && companyId === authorCompanyId) isSelf = true;

                if (!isSelf) {
                    const notificationText = `liked your post`;

                    // Persist DB Notification unconditionally
                    const notifRes = await pool.query(
                        `INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata, recipient_org_id) 
                         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING notification_id, created_at`,
                        [
                            authorId, 
                            userId, 
                            "like", 
                            notificationText, 
                            postId, 
                            JSON.stringify({ org_id: companyId, post_id: postId }), 
                            authorCompanyId
                        ]
                    );

                    const dbNotification = notifRes.rows[0];

                    const likeNotifPayload = {
                        notification_id: dbNotification.notification_id,
                        type: "like",
                        text: notificationText,
                        reference_id: postId,
                        is_read: false,
                        created_at: dbNotification.created_at.toISOString(),
                        actor_name: actorInfo.fullName,
                        actor_avatar: actorInfo.avatar,
                        actor_slug: actorInfo.username,
                        is_company_actor: !!companyId,
                        targetProfileType: authorCompanyId ? 'COMPANY' : 'USER',
                        targetCompanyId: authorCompanyId || null,
                        recipient_org_id: authorCompanyId || null,
                        from: userId,
                        metadata: { org_id: companyId, post_id: postId }
                    };

                    // Emit real-time: notify org room if post belongs to an org, else notify user
                    const ioService = require("../../core/infrastructure/socket.service");
                    if (authorCompanyId && ioService && ioService.notifyOrg) {
                        ioService.notifyOrg(authorCompanyId, "notification", likeNotifPayload);
                    } else if (ioService && ioService.notifyUser) {
                        ioService.notifyUser(authorId, "notification", likeNotifPayload);
                    }

                    // Push notification conditionally based on thresholds EXACTLY as in image
                    const likeThresholds = [6, 10, 40, 70, 100, 150, 200, 500, 750, 1000];
                    if (likeThresholds.includes(likeCount)) {
                        const pushText = `"${actorInfo.fullName}" and ${likeCount - 1} others liked your post`;
                        sendPush(authorId, "New like on your post", pushText, { type: 'like', referenceId: postId }).catch(() => {});
                    }
                }
            }
        }

        const ioService = require("../../core/infrastructure/socket.service");
        if (ioService && ioService.notifyPost) {
            ioService.notifyPost(postId, "post_like_updated", {
                postId,
                liked,
                likeCount,
                liker: actorInfo
            });
        }

        return res.status(200).json({
            postId,
            liked,
            likeCount,
            username: actorInfo.username,
            liker: actorInfo
        });

    } catch (err) {
        console.error("Toggle like error:", err);
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }
};

exports.addComment = async (req, res) => {
    const fs = require('fs');
    const postId = req.params.id;
    let { content, parent_id } = req.body; // Added companyId

    // Sanitize user-generated content
    content = sanitizeContent(content);
    let actorScope;

    try {
        actorScope = getContentActorScope(req, req.body?.companyId || null);
    } catch (err) {
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }

    const { userId, orgId: companyId } = actorScope;

    if (companyId) {
        const hasPerm = await checkOrgPermission(pool, companyId, userId, ['CREATE_POST', 'CREATE_CONTENT']);
        if (!hasPerm) {
            return res.status(403).json({ message: "You do not have permission to interact with posts on behalf of this organization." });
        }
    }

    if (!postId || !userId || !content || !content.trim()) {
        console.error('[addComment] Missing required fields', { postId, userId, hasContent: !!content });
        return res.status(400).json({ message: "all fields are required" })
    }

    if (content.length > 1000) {
        console.error('[addComment] Comment too long', { length: content.length });
        return res.status(400).json({ message: "Comment too long (max 1000 characters)" })
    }

    try {
        const post = await pool.query(`select post_id, shared_post_id, content, author_id, author_org_id, post_type, is_community_article from posts where post_id = $1`, [postId]);

        if (post.rowCount === 0) {
            return res.status(404).json({ message: "Post not found" });
        }

        let effectivePostId = postId;
        if (post.rows[0].shared_post_id && (!post.rows[0].content || post.rows[0].content.trim() === '')) {
            effectivePostId = post.rows[0].shared_post_id;
        }

        const postAuthorId = post.rows[0].author_id;
        const postCompanyId = post.rows[0].author_org_id;
        const postType = post.rows[0].post_type;
        const isCommunityArticle = post.rows[0].is_community_article;

        // Thoughts subscription check (only for community articles)
        if (isCommunityArticle && postCompanyId) {
            const communityCheck = await pool.query(
                `SELECT community_id FROM communities WHERE org_id = $1 AND is_active = TRUE`,
                [postCompanyId]
            );
            if (communityCheck.rowCount > 0) {
                const communityId = communityCheck.rows[0].community_id;
                const subscriptionCheck = await pool.query(
                    `SELECT status FROM community_subscriptions 
                     WHERE community_id = $1 AND user_id = $2 AND status = 'SUBSCRIBED'`,
                    [communityId, userId]
                );
                const ownerCheck = await pool.query(
                    `SELECT 1 FROM organizations 
                     WHERE org_id = $1 AND created_by = $2`,
                    [postCompanyId, userId]
                );
                const isCompanyCommentingOnOwnPost = companyId && (companyId === postCompanyId);
                if (!isCompanyCommentingOnOwnPost && subscriptionCheck.rowCount === 0 && ownerCheck.rowCount === 0) {
                    return res.status(403).json({
                        message: "You must subscribe to the community to post thoughts"
                    });
                }
            }
        }

        // Identity-Aware Block Check: Post Author
        const activeActorId = companyId || userId;
        if (postCompanyId) {
            const isBlocked = await BlockModel.isAnyBlocked(activeActorId, postCompanyId);
            if (isBlocked) {
                return res.status(403).json({ message: "You cannot comment on this post" });
            }
        } else if (postAuthorId && postAuthorId !== userId) {
            const isBlocked = await BlockModel.isAnyBlocked(activeActorId, postAuthorId);
            if (isBlocked) {
                return res.status(403).json({ message: "You cannot comment on this post" });
            }
        }

        let insertParentId = parent_id || null;

        // Validate parent_id if provided
        if (parent_id) {
            const parentComment = await pool.query(
                `SELECT comment_id, post_id, parent_id FROM active_post_comments WHERE comment_id = $1`,
                [parent_id]
            );

            if (parentComment.rowCount === 0) {
                return res.status(404).json({ message: "Parent comment not found" });
            }

            if (parentComment.rows[0].post_id.toString() !== postId.toString()) {
                return res.status(400).json({ message: "Parent comment belongs to different post" });
            }

            // Block Check: Parent Comment Author
            const parentAuthorRes = await pool.query(
                `SELECT author_id, author_org_id FROM active_post_comments WHERE comment_id = $1`,
                [parent_id]
            );
            if (parentAuthorRes.rowCount > 0) {
                const parentAuthorId = parentAuthorRes.rows[0].author_id;
                const parentAuthorOrgId = parentAuthorRes.rows[0].author_org_id;

                if (parentAuthorOrgId) {
                    const isBlocked = await BlockModel.isAnyBlocked(activeActorId, parentAuthorOrgId);
                    if (isBlocked) {
                        return res.status(403).json({ message: "You cannot reply to this comment" });
                    }
                } else if (parentAuthorId && parentAuthorId !== userId) {
                    const isBlocked = await BlockModel.isAnyBlocked(activeActorId, parentAuthorId);
                    if (isBlocked) {
                        return res.status(403).json({ message: "You cannot reply to this comment" });
                    }
                }
            }

            // Always reply to the root comment of a thread (Instagram-style)
            insertParentId = parentComment.rows[0].parent_id || parent_id;
        }

        const result = await pool.query(
            `INSERT INTO post_comments (post_id, author_id, content, parent_id, author_org_id)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING comment_id, author_id, content, parent_id, author_org_id, created_at`,
            [effectivePostId, userId, content.trim(), insertParentId, companyId || null]
        );

        const newComment = result.rows[0];

        if (companyId) {
            await logAudit(pool, {
                entityId: companyId,
                actorId: userId,
                actorRole: req.actor?.roleName || null,
                action: 'COMMENT',
                metadata: { postId, commentId: newComment.comment_id, content: content.trim() }
            });
        }

        // --- NOTIFICATIONS & SOCKETS ---

        // Fetch actor details (User or Company)
        let actorName, actorAvatar;

        if (companyId) {
            const companyRes = await pool.query(`SELECT name, logo_url FROM organizations WHERE org_id = $1`, [companyId]);
            const company = companyRes.rows[0];
            actorName = company.name;
            actorAvatar = company.logo_url;
        } else {
            const actorRes = await pool.query(`SELECT full_name, avatar_url FROM users WHERE user_id = $1`, [userId]);
            const actor = actorRes.rows[0];
            actorName = actor.full_name;
            actorAvatar = actor.avatar_url;
        }

        // Regex for mentions: @[Name](handle) or @Username
        const mentionedUsernames = [];
        const regex1 = /@\[[^\]]+\]\(([^)]+)\)/g;
        let m;
        while ((m = regex1.exec(content)) !== null) {
            if (!mentionedUsernames.includes(m[1])) mentionedUsernames.push(m[1]);
        }
        const regex2 = /(?:^|\s)@(\w+)(?!\w)/g;
        while ((m = regex2.exec(content)) !== null) {
            if (!mentionedUsernames.includes(m[1])) mentionedUsernames.push(m[1]);
        }

        // Notify Post Owner
        // If Company comments, we notify post owner (User). 
        // If User comments on own post -> Skip.
        // If Company comments on own post (if possible?) -> Skip. 
        // Note: Posts are strictly User-owned currently. Companies don't own posts in this schema yet (except shared posts maybe?).

        let shouldNotifyPostOwner = true;
        if (!companyId && postAuthorId === userId) shouldNotifyPostOwner = false;

        // Skip 'comment' notification if the post owner is explicitly mentioned (they will get 'mention' notification instead)
        if (shouldNotifyPostOwner && mentionedUsernames.length > 0) {
            const postOwnerHandleRes = await pool.query(`SELECT account_name FROM users WHERE user_id = $1`, [postAuthorId]);
            if (postOwnerHandleRes.rowCount > 0 && mentionedUsernames.some(u => u.toLowerCase() === postOwnerHandleRes.rows[0].account_name.toLowerCase())) {
                shouldNotifyPostOwner = false;
            }
        }

        if (shouldNotifyPostOwner) {
            // Count total comments on post
            const countResult = await pool.query(
                "SELECT COUNT(*) FROM active_post_comments WHERE post_id = $1",
                [postId]
            );
            const commentCount = Number(countResult.rows[0].count);

            let cleanedContent = content.replace(/@\[([^\]]+)\]\(([^)]+)\)/g, '$1').replace(/@\w+\s*/g, '').trim();
            let preview = cleanedContent.substring(0, 40);
            if (cleanedContent.length > 40) preview += "...";
            
            let notificationText = `${actorName} commented: ${preview}`;

            // Notification Metadata
            const meta = {
                comment_id: newComment.comment_id,
                org_id: companyId,
                post_id: postId
            };

            const notifRes = await pool.query(
                `INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata, recipient_org_id) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING notification_id, created_at`,
                [postAuthorId, userId, 'comment', notificationText, postId, JSON.stringify(meta), postCompanyId]
            );

            const dbNotification = notifRes.rows[0];

            const commentNotifPayload = {
                notification_id: dbNotification.notification_id,
                type: 'comment',
                text: notificationText,
                reference_id: postId,
                is_read: false,
                created_at: dbNotification.created_at.toISOString(),
                actor_name: actorName,
                actor_avatar: actorAvatar,
                actor_slug: null, // Could fetch if needed
                is_company_actor: !!companyId,
                targetProfileType: postCompanyId ? 'COMPANY' : 'USER',
                targetCompanyId: postCompanyId || null,
                recipient_org_id: postCompanyId || null,
                from: userId,
                metadata: meta
            };

            // Emit real-time: notify org room if post belongs to an org, else notify user
            if (postCompanyId) {
                socketService.notifyOrg(postCompanyId, "notification", commentNotifPayload);
            } else {
                socketService.notifyUser(postAuthorId, "notification", commentNotifPayload);
            }

            // Push notification conditionally based on thresholds EXACTLY as in image
            const commentThresholds = [40, 55, 70, 85, 100, 150, 200, 500, 750, 1000];
            if (commentThresholds.includes(commentCount)) {
                let pushText = `${actorName} and ${commentCount - 1} others commented: ${preview}`;
                sendPush(postAuthorId, "New comment on your post", pushText, { type: 'comment', referenceId: postId }).catch(() => {});
            }
        }

        const notifiedReplyUserIds = new Set();
        if (parent_id) {
            // Get parent comment author AND company
            const parentAuthorRes = await pool.query(
                `SELECT author_id, author_org_id FROM active_post_comments WHERE comment_id = $1`,
                [parent_id]
            );

            if (parentAuthorRes.rowCount > 0) {
                const parentAuthorId = parentAuthorRes.rows[0].author_id;
                const parentCompanyId = parentAuthorRes.rows[0].author_org_id;

                // Notify parent author (if not self and not post owner already notified)
                let isSelfReply = (!companyId && parentAuthorId === userId);

                // Only skip if parent author is post owner AND not representing a company (because company nots are separate)
                let isPostOwner = (parentAuthorId === postAuthorId && !parentCompanyId);

                // Note: If parent is company, we should notify even if "isSelfReply" logic might seem ambiguous.
                // If I am User A, and I reply to my own Company C comment, I SHOULD notify Company C (so A sees it in C's view).
                // So "isSelfReply" should strictly be: Acting as X replying to X.
                if (companyId && parentCompanyId && companyId === parentCompanyId) isSelfReply = true;
                if (!companyId && !parentCompanyId && parentAuthorId === userId) isSelfReply = true;

                if (!isSelfReply && !isPostOwner) {
                    let cleanedContent = content.replace(/@\[[^\]]+\](?:\([^)]*\))?\s*/g, '').replace(/@\w+\s*/g, '').trim();
                    let preview = cleanedContent.substring(0, 40);
                    if (cleanedContent.length > 40) preview += "...";
                    const replyText = `${actorName} replied to your comment: ${preview}`;
                    const meta = {
                        comment_id: newComment.comment_id,
                        parent_id,
                        org_id: companyId
                    };

                    const notifRes = await pool.query(
                        `INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata, recipient_org_id) 
                         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING notification_id, created_at`,
                        [parentAuthorId, userId, 'reply', replyText, postId, JSON.stringify(meta), parentCompanyId]
                    );

                    const dbNotification = notifRes.rows[0];

                    const replyNotifPayload = {
                        notification_id: dbNotification.notification_id,
                        type: 'reply',
                        text: replyText,
                        from: userId,
                        senderName: actorName,
                        senderAvatar: actorAvatar,
                        referenceId: postId,
                        metadata: meta,
                        time: "Just now",
                        created_at: dbNotification.created_at.toISOString(),
                        targetProfileType: parentCompanyId ? 'COMPANY' : 'USER',
                        targetCompanyId: parentCompanyId || null,
                        recipient_org_id: parentCompanyId || null
                    };

                    // Push notification for offline devices
                    sendPush(parentAuthorId, actorName, replyNotifPayload.text, { type: 'reply', postId }).catch(() => {});

                    // Emit real-time: notify org room if parent comment was from an org, else notify user
                    if (parentCompanyId) {
                        socketService.notifyOrg(parentCompanyId, "notification", replyNotifPayload);
                    } else {
                        socketService.notifyUser(parentAuthorId, "notification", replyNotifPayload);
                    }

                    notifiedReplyUserIds.add(parentAuthorId);
                }
            }
        }

        if (mentionedUsernames.length > 0) {
            for (const handle of mentionedUsernames) {
                const userRes = await pool.query(`SELECT user_id FROM users WHERE LOWER(account_name) = LOWER($1)`, [handle]);
                if (userRes.rowCount > 0) {
                    const mentionedUserId = userRes.rows[0].user_id;

                    // Don't notify if self
                    let isSelf = (!companyId && mentionedUserId === userId);

                    if (!isSelf && !notifiedReplyUserIds.has(mentionedUserId)) {
                        if (!companyId) {
                            const isBlockedByMentioned = await checkBlockStatus(mentionedUserId, userId);
                            const hasBlockedMentioned = await checkBlockStatus(userId, mentionedUserId);
                            if (isBlockedByMentioned || hasBlockedMentioned) continue;
                        }

                        const notifText = `${actorName} mentioned you in a comment`;
                        const meta = {
                            comment_id: newComment.comment_id,
                            org_id: companyId
                        };

                        const mentionNotifRes = await pool.query(
                            `INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata) 
                             VALUES ($1, $2, $3, $4, $5, $6) RETURNING notification_id, created_at`,
                            [mentionedUserId, userId, 'mention', notifText, postId, JSON.stringify(meta)]
                        );

                        socketService.notifyUser(mentionedUserId, "notification", {
                            notification_id: mentionNotifRes.rows[0].notification_id,
                            type: 'mention',
                            text: notifText,
                            from: userId,
                            senderName: actorName,
                            senderAvatar: actorAvatar,
                            referenceId: postId,
                            metadata: meta,
                            time: "Just now",
                            created_at: mentionNotifRes.rows[0].created_at.toISOString(),
                            is_read: false
                        });
                        // Push notification for offline devices
                        sendPush(mentionedUserId, actorName, notifText, { type: 'mention', postId }).catch(() => {});
                    }
                }
            }
        }

        // 📝 Log Activity: Comment Post
        logActivity(userId, 'comment_post', 'post', postId, {
            comment_id: newComment.comment_id,
            comment: content.slice(0, 100)
        });

        // 🎯 Intent Layer: Log Comment
        logIntentActivity({ userId, action: "comment_post", metadata: { postId, commentId: newComment.comment_id } });

        // 4️⃣ Return FULL comment object with author JOINs for immediate frontend mapping
        const fullCommentRes = await pool.query(
            `
      SELECT 
        c.comment_id,
        c.content,
        c.parent_id,
        c.created_at,
        c.updated_at,
        COALESCE(c.is_edited, false) AS is_edited,
        c.is_pinned,
        c.pinned_at,
        c.pinned_by,
        u.user_id AS author_id,
        
        CASE 
            WHEN c.author_org_id IS NOT NULL THEN comp.name 
            ELSE u.display_name 
        END AS full_name,

        CASE 
            WHEN c.author_org_id IS NOT NULL THEN comp.slug 
            ELSE u.display_username 
        END AS account_name,

        CASE 
            WHEN c.author_org_id IS NOT NULL THEN comp.logo_url 
            ELSE u.display_avatar 
        END AS avatar_url,
        COALESCE(comp.slug, u.display_username) AS author_slug,
        (c.author_org_id IS NOT NULL) AS is_organization_comment,
        CASE 
            WHEN c.author_org_id IS NOT NULL THEN comp.slogan 
            ELSE u.display_headline 
        END AS headline,

        c.author_org_id,
        0 AS like_count,
        false AS is_liked
      FROM active_post_comments c
      JOIN user_display_profiles u ON c.author_id = u.user_id
      LEFT JOIN organizations comp ON c.author_org_id = comp.org_id
      WHERE c.comment_id = $1
      `,
            [newComment.comment_id]
        );

        const commentRow = fullCommentRes.rows[0];
        const mappedComment = {
            ...commentRow,
            id: commentRow.comment_id,
            parentId: commentRow.parent_id,
            createdAt: commentRow.created_at,
            updatedAt: commentRow.updated_at,
            isEdited: Boolean(commentRow.is_edited),
            is_edited: Boolean(commentRow.is_edited),
            authorId: commentRow.author_id,
            authorOrgId: commentRow.author_org_id,
            authorName: commentRow.full_name,
            authorAvatarUrl: commentRow.avatar_url,
            isPinned: commentRow.is_pinned,
            pinnedAt: commentRow.pinned_at,
            pinnedBy: commentRow.pinned_by
        };

        const ioService = require("../../core/infrastructure/socket.service");
        if (ioService && ioService.notifyPost) {
            ioService.notifyPost(postId, "post_comment_added", {
                postId,
                comment: mappedComment
            });
        }

        return res.status(200).json({
            message: "comment added",
            comment: mappedComment
        });



    } catch (err) {
        console.error("Add comment error:", err);
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" })
    }
}

exports.updateComment = async (req, res) => {
    const commentId = req.params.commentId;
    let { content } = req.body;

    // Sanitize user-generated content
    content = sanitizeContent(content);
    let actorScope;

    try {
        actorScope = getContentActorScope(req, req.body?.companyId || null);
    } catch (err) {
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }

    const { userId, orgId: companyId } = actorScope;

    if (!commentId) {
        return res.status(400).json({ message: "commentId is required" });
    }

    if (!content || !content.trim()) {
        return res.status(400).json({ message: "Content is required" });
    }

    if (content.length > 1000) {
        return res.status(400).json({ message: "Comment too long (max 1000 characters)" })
    }

    try {
        let query, params;
        if (companyId) {
            query = `
                UPDATE post_comments
                SET content = $1, updated_at = NOW(), is_edited = TRUE
                WHERE comment_id = $2 AND author_org_id = $3
                RETURNING comment_id, post_id, author_id, author_org_id, parent_id, content, created_at, updated_at, is_edited
            `;
            params = [content.trim(), commentId, companyId];
        } else {
            query = `
                UPDATE post_comments
                SET content = $1, updated_at = NOW(), is_edited = TRUE
                WHERE comment_id = $2 AND author_id = $3 AND author_org_id IS NULL
                RETURNING comment_id, post_id, author_id, author_org_id, parent_id, content, created_at, updated_at, is_edited
            `;
            params = [content.trim(), commentId, userId];
        }

        const result = await pool.query(query, params);

        if (result.rowCount === 0) {
            // Either comment doesn't exist OR user is not the author
            // Double check existence to give better error
            const check = await pool.query(`select * from post_comments where comment_id = $1`, [commentId])
            if (check.rowCount === 0) {
                return res.status(404).json({ message: "Comment not found" });
            }
            return res.status(403).json({ message: "Not authorized to edit this comment" });
        }

        const updatedRow = result.rows[0];
        const mappedUpdatedComment = {
            ...updatedRow,
            id: updatedRow.comment_id,
            postId: updatedRow.post_id,
            parentId: updatedRow.parent_id,
            authorId: updatedRow.author_id,
            createdAt: updatedRow.created_at,
            updatedAt: updatedRow.updated_at,
            updated_at: updatedRow.updated_at,
            isEdited: true,
            is_edited: true
        };

        const ioService = require("../../core/infrastructure/socket.service");
        if (ioService && ioService.notifyPost && updatedRow.post_id) {
            ioService.notifyPost(updatedRow.post_id, "post_comment_updated", {
                postId: updatedRow.post_id,
                commentId: updatedRow.comment_id,
                content: updatedRow.content,
                updatedAt: updatedRow.updated_at,
                updated_at: updatedRow.updated_at,
                isEdited: true,
                is_edited: true,
                comment: mappedUpdatedComment
            });
        }

        return res.status(200).json({
            message: "Comment updated",
            comment: mappedUpdatedComment
        });

    } catch (err) {
        console.error("Update comment error:", err);
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }
};

exports.deleteComment = async (req, res) => {
    const commentId = req.params.commentId;
    let actorScope;

    try {
        actorScope = getContentActorScope(req, req.body?.companyId || null);
    } catch (err) {
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }

    const { userId, orgId: companyId } = actorScope;

    if (!userId || !commentId) {
        return res.status(400).json({ message: "userId and commentId are required" });
    }

    try {
        const commentCheck = await pool.query(`SELECT * FROM active_post_comments WHERE comment_id = $1`, [commentId]);
        if (commentCheck.rowCount === 0) {
            return res.status(404).json({ message: "Comment not found" });
        }
        const comment = commentCheck.rows[0];

        const postCheck = await pool.query(`SELECT author_id, author_org_id FROM posts WHERE post_id = $1`, [comment.post_id]);
        if (postCheck.rowCount === 0) {
            return res.status(404).json({ message: "Associated post not found" });
        }
        const post = postCheck.rows[0];

        let canDelete = false;

        if (companyId) {
            // Acting as organization: Can delete if they authored the comment OR own the post
            const isCommentAuthor = comment.author_org_id === companyId;
            const isPostOwner = post.author_org_id === companyId;
            canDelete = isCommentAuthor || isPostOwner;
        } else {
            // Acting as user: Can delete if they authored the comment OR own the post (personal scope)
            const isCommentAuthor = (comment.author_id === userId && comment.author_org_id === null);
            const isPostOwner = (post.author_id === userId && post.author_org_id === null);
            canDelete = isCommentAuthor || isPostOwner;
        }

        if (!canDelete) {
            return res.status(403).json({ message: "Not authorized to delete this comment" });
        }

        // The instruction provided a code block for `deletePost` but asked to insert it into `deleteComment`.
        // To maintain syntactic correctness and avoid introducing undefined variables (`post`, `postId`),
        // I am inserting a placeholder for `logAudit` that would be appropriate for `deleteComment`.
        // If the original instruction intended to modify a `deletePost` function that is not present in the provided context,
        // please provide the `deletePost` function's content.
        // For now, I'm assuming the user wants an audit log for comment deletion.
        // If `logAudit` is expected to be called, it needs to be imported or defined.
        // Assuming `logAudit` is available in this scope.
        // Also assuming `comment.author_org_id` exists if company-level auditing is needed for comments.
        if (comment.author_org_id) {
            const auditClient = await pool.connect();
            try {
                await logAudit(auditClient, {
                    entityId: comment.author_org_id, // Using comment's company ID
                    actorId: userId,
                    action: 'DELETE_COMMENT', // Action changed to DELETE_COMMENT
                    metadata: {
                        type: 'comment',
                        id: commentId,
                        post_id: comment.post_id,
                        // Potentially include comment content if needed for audit, but it's being deleted.
                        // For now, just ID and post_id.
                    }
                });
            } finally {
                auditClient.release();
            }
        }


        await pool.query(`DELETE FROM post_comments WHERE comment_id = $1`, [commentId]);

        res.status(200).json({ message: "Comment deleted", deletedCommentId: commentId });
    } catch (err) {
        console.error("Delete comment error:", err);
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }
};

exports.toggleCommentLike = async (req, res) => {
    const { commentId } = req.params;
    let actorScope;

    try {
        actorScope = getContentActorScope(req, req.body?.companyId || null);
    } catch (err) {
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }

    const { userId, orgId: companyId } = actorScope;

    if (!commentId || !userId) {
        return res.status(400).json({ message: "Comment ID and user ID are required" });
    }

    try {
        // Check if comment exists
        const commentCheck = await pool.query(
            `SELECT comment_id, author_id, author_org_id, post_id FROM active_post_comments WHERE comment_id = $1`,
            [commentId]
        );

        if (commentCheck.rowCount === 0) {
            return res.status(404).json({ message: "Comment not found" });
        }

        const comment = commentCheck.rows[0];

        // Check if user (or company) already liked this comment
        let existingLike;
        if (companyId) {
            existingLike = await pool.query(
                `SELECT * FROM active_comment_likes WHERE org_id = $1 AND comment_id = $2`,
                [companyId, commentId]
            );
        } else {
            existingLike = await pool.query(
                `SELECT * FROM active_comment_likes WHERE user_id = $1 AND comment_id = $2 AND org_id IS NULL`,
                [userId, commentId]
            );
        }

        let liked;
        if (existingLike.rowCount > 0) {
            // Unlike
            if (companyId) {
                await pool.query(
                    `DELETE FROM comment_likes WHERE org_id = $1 AND comment_id = $2`,
                    [companyId, commentId]
                );
            } else {
                await pool.query(
                    `DELETE FROM comment_likes WHERE user_id = $1 AND comment_id = $2 AND org_id IS NULL`,
                    [userId, commentId]
                );
            }
            liked = false;
        } else {
            // Like
            if (companyId) {
                await pool.query(
                    `INSERT INTO comment_likes (user_id, comment_id, org_id) VALUES ($1, $2, $3)`,
                    [userId, commentId, companyId]
                );
            } else {
                await pool.query(
                    `INSERT INTO comment_likes (user_id, comment_id) VALUES ($1, $2)`,
                    [userId, commentId]
                );
            }
            liked = true;

            // --- NOTIFICATION LOGIC ---
            const authorId = comment.author_id;
            const authorCompanyId = comment.author_org_id;

            // Determine if self-like
            let isSelf = (!companyId && authorId === userId);
            if (companyId && authorCompanyId && companyId === authorCompanyId) isSelf = true;
            if (!companyId && !authorCompanyId && authorId === userId) isSelf = true;

            if (!isSelf) {
                let senderName, senderAvatar;

                if (companyId) {
                    const companyRes = await pool.query("SELECT name, logo_url FROM organizations WHERE org_id = $1", [companyId]);
                    senderName = companyRes.rows[0].name;
                    senderAvatar = companyRes.rows[0].logo_url;
                } else {
                    const userRes = await pool.query("SELECT full_name, avatar_url FROM users WHERE user_id = $1", [userId]);
                    senderName = userRes.rows[0].full_name;
                    senderAvatar = userRes.rows[0].avatar_url;
                }

                // Persist notification
                const meta = {
                    comment_id: commentId,
                    org_id: companyId,
                    post_id: comment.post_id
                };

                await pool.query(
                    `INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata, recipient_org_id) 
                     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [authorId, userId, "like", `${senderName} liked your comment`, comment.post_id, JSON.stringify(meta), authorCompanyId]
                );

                // Emit real-time
                const commentLikePayload = {
                    type: "like",
                    text: `${senderName} liked your comment`,
                    senderName: senderName,
                    senderAvatar: senderAvatar,
                    referenceId: comment.post_id, // Link to post
                    metadata: meta,
                    targetProfileType: authorCompanyId ? 'COMPANY' : 'USER',
                    targetCompanyId: authorCompanyId || null,
                    recipient_org_id: authorCompanyId || null,
                    from: userId
                };

                // Emit real-time: notify org room if comment was from an org, else notify user
                if (authorCompanyId) {
                    socketService.notifyOrg(authorCompanyId, "notification", commentLikePayload);
                } else {
                    socketService.notifyUser(authorId, "notification", commentLikePayload);
                }
            }
        }

        // Get updated like count
        const likeCountResult = await pool.query(
            `SELECT COUNT(*)::int as like_count FROM active_comment_likes WHERE comment_id = $1`,
            [commentId]
        );

        const likeCount = likeCountResult.rows[0].like_count;

        const ioService = require("../../core/infrastructure/socket.service");
        if (ioService && ioService.notifyPost) {
            ioService.notifyPost(comment.post_id, "post_comment_like_updated", {
                postId: comment.post_id,
                commentId,
                liked,
                likeCount
            });
        }

        res.status(200).json({
            liked,
            likeCount,
            message: liked ? "Comment liked" : "Comment unliked"
        });
    } catch (err) {
        console.error("Toggle comment like error:", err);
        res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }
};

// Toggle pin on a comment (post owner only)
exports.toggleCommentPin = async (req, res) => {
    const { commentId } = req.params;
    let actorScope;

    try {
        actorScope = getContentActorScope(req, req.body?.companyId || null);
    } catch (err) {
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }

    const { userId, orgId: companyId } = actorScope;

    if (!commentId || !userId) {
        return res.status(400).json({ message: "Comment ID and user ID are required" });
    }

    try {
        // Get comment and verify it exists
        const commentResult = await pool.query(
            `SELECT c.comment_id, c.post_id, c.is_pinned, p.author_id as post_author_id, p.author_org_id as post_author_org_id
             FROM active_post_comments c
             JOIN posts p ON c.post_id = p.post_id
             WHERE c.comment_id = $1`,
            [commentId]
        );

        if (commentResult.rowCount === 0) {
            return res.status(404).json({ message: "Comment not found" });
        }

        const comment = commentResult.rows[0];

        // Verify user is the post owner (Identity Aware)
        let isOwner = false;
        if (companyId) {
            isOwner = comment.post_author_org_id === companyId;
        } else {
            isOwner = (comment.post_author_id === userId && comment.post_author_org_id === null);
        }

        if (!isOwner) {
            return res.status(403).json({ message: "Only post owner can pin comments" });
        }

        let pinned;
        if (comment.is_pinned) {
            // Unpin: Remove pin
            await pool.query(
                `UPDATE post_comments 
                 SET is_pinned = false, pinned_at = NULL, pinned_by = NULL
                 WHERE comment_id = $1`,
                [commentId]
            );
            pinned = false;
        } else {
            // Pin: Add pin
            await pool.query(
                `UPDATE post_comments 
                 SET is_pinned = true, pinned_at = NOW(), pinned_by = $1, pinned_by_org_id = $2
                 WHERE comment_id = $3`,
                [userId, companyId || null, commentId]
            );
            pinned = true;
        }

        res.status(200).json({
            pinned,
            message: pinned ? "Comment pinned" : "Comment unpinned"
        });
    } catch (err) {
        console.error("Toggle comment pin error:", err);
        res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }
};

exports.getComments = async (req, res) => {
    const postId = req.params.id;
    const { companyId: requestedCompanyId } = req.query;

    if (!postId) {
        return res.status(400).json({ message: "postId is required" })
    }
    try {
        const { userId, orgId: companyId } = getContentActorScope(req, requestedCompanyId || null);
        const targetCommentId = req.query.target_comment_id || null;

        const post = await pool.query(`select post_id, shared_post_id, content, author_org_id, post_type, is_community_article from posts where post_id = $1`, [postId]);
        if (post.rowCount === 0) {
            return res.status(404).json({ message: "Post not found" });
        }

        // If this is a repost without additional thoughts, fetch comments of the original post
        let effectivePostId = postId;
        if (post.rows[0].shared_post_id && (!post.rows[0].content || post.rows[0].content.trim() === '')) {
            effectivePostId = post.rows[0].shared_post_id;
        }

        const postCompanyId = post.rows[0].author_org_id;
        const postType = post.rows[0].post_type;
        const isCommunityArticle = post.rows[0].is_community_article;

        // Thoughts subscription check (only for community articles)
        if (isCommunityArticle && postCompanyId) {
            const communityCheck = await pool.query(
                `SELECT community_id FROM communities WHERE org_id = $1 AND is_active = TRUE`,
                [postCompanyId]
            );
            if (communityCheck.rowCount > 0) {
                const communityId = communityCheck.rows[0].community_id;
                const subscriptionCheck = await pool.query(
                    `SELECT status FROM community_subscriptions 
                     WHERE community_id = $1 AND user_id = $2 AND status = 'SUBSCRIBED'`,
                    [communityId, userId]
                );
                const ownerCheck = await pool.query(
                    `SELECT 1 FROM organizations 
                     WHERE org_id = $1 AND created_by = $2`,
                    [postCompanyId, userId]
                );
                const memberCheck = await pool.query(
                    `SELECT 1 FROM organization_members 
                     WHERE org_id = $1 AND user_id = $2 AND status = 'ACTIVE'`,
                    [postCompanyId, userId]
                );
                if (subscriptionCheck.rowCount === 0 && ownerCheck.rowCount === 0 && memberCheck.rowCount === 0) {
                    return res.status(200).json([]);
                }
            }
        }
        const comments = await pool.query(
            `
      WITH target_root AS (
        SELECT COALESCE(parent_id, comment_id) as root_id 
        FROM active_post_comments 
        WHERE comment_id = $4
      )
      SELECT 
        c.comment_id,
        c.content,
        c.parent_id,
        c.created_at,
        c.updated_at,
        COALESCE(c.is_edited, false) AS is_edited,
        c.is_pinned,
        c.pinned_at,
        c.pinned_by,
        u.user_id AS author_id,
        
        CASE 
            WHEN c.author_org_id IS NOT NULL THEN comp.name 
            ELSE u.display_name 
        END AS full_name,

        CASE 
            WHEN c.author_org_id IS NOT NULL THEN comp.slug 
            ELSE u.display_username 
        END AS account_name,

        CASE 
            WHEN c.author_org_id IS NOT NULL THEN comp.logo_url 
            ELSE u.display_avatar 
        END AS avatar_url,
        COALESCE(comp.slug, u.display_username) AS author_slug,
        (c.author_org_id IS NOT NULL) AS is_organization_post,
        CASE 
            WHEN c.author_org_id IS NOT NULL THEN comp.slogan 
            ELSE u.display_headline 
        END AS headline,

        c.author_org_id,
        
        (
            SELECT COALESCE(json_agg(json_build_object(
                'user_id', u_mention.user_id,
                'full_name', u_mention.full_name,
                'account_name', u_mention.account_name
            )), '[]'::json)
            FROM (
                SELECT DISTINCT (regexp_matches(COALESCE(c.content, ''), '@\\[[^\\]]+\\]\\(([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\\)', 'g'))[1]::uuid AS mentioned_id
            ) mentions
            JOIN active_users u_mention ON u_mention.user_id = mentions.mentioned_id
        ) AS mentioned_users,

        COALESCE(
          (SELECT COUNT(*)::int FROM active_comment_likes cl WHERE cl.comment_id = c.comment_id),
          0
        ) AS like_count,
        COALESCE(
          (SELECT COUNT(*)::int FROM active_post_comments pc WHERE pc.parent_id = c.comment_id),
          0
        ) AS reply_count,
        COALESCE(
          (SELECT EXISTS(SELECT 1 FROM active_comment_likes cl 
           WHERE cl.comment_id = c.comment_id 
           AND (
               ($3::uuid IS NOT NULL AND cl.org_id = $3::uuid) 
               OR 
               ($3::uuid IS NULL AND cl.user_id = $2 AND cl.org_id IS NULL)
           )
          )),
          false
        ) AS is_liked
      FROM active_post_comments c
      JOIN active_users au ON c.author_id = au.user_id
      JOIN user_display_profiles u ON c.author_id = u.user_id
      LEFT JOIN active_organizations comp ON c.author_org_id = comp.org_id
      WHERE c.post_id = $1
      AND (c.author_org_id IS NULL OR comp.org_id IS NOT NULL)
      -- 1. Exclude blocked users
      ${companyId ? `
      AND NOT EXISTS (
        SELECT 1 FROM blocks b 
        WHERE (b.is_org_block = true AND c.author_org_id IS NULL AND ((b.blocker_id = $3 AND b.blocked_id = c.author_id) OR (b.blocker_id = c.author_id AND b.blocked_id = $3)))
           OR (b.is_org_block = true AND c.author_org_id IS NOT NULL AND ((b.blocker_id = c.author_org_id AND b.blocked_id = $3) OR (b.blocker_id = $3 AND b.blocked_id = c.author_org_id)))
      )
      ` : `
      AND NOT EXISTS (
        SELECT 1 FROM blocks b 
        WHERE (b.is_org_block = false AND c.author_org_id IS NULL AND ((b.blocker_id = $2 AND b.blocked_id = c.author_id) OR (b.blocker_id = c.author_id AND b.blocked_id = $2)))
           OR (b.is_org_block = true AND c.author_org_id IS NOT NULL AND ((b.blocker_id = c.author_org_id AND b.blocked_id = $2) OR (b.blocker_id = $2 AND b.blocked_id = c.author_org_id)))
      )
      `}
      -- 2. Exclude hidden comments (Hiding a comment or its parent hides the thread)
      AND NOT EXISTS (
        SELECT 1 FROM hidden_comments hc
        WHERE (hc.comment_id = c.comment_id OR hc.comment_id = c.parent_id)
        AND (
            ($3::uuid IS NOT NULL AND hc.org_id = $3::uuid)
            OR
            ($3::uuid IS NULL AND hc.user_id = $2 AND hc.org_id IS NULL)
        )
      )
      -- 3. Exclude reported comments (Reporting a comment or its parent hides the thread for the reporter)
      AND NOT EXISTS (
        SELECT 1 FROM reports r
        WHERE r.target_type = 'COMMENT'
        AND (r.target_id::uuid = c.comment_id OR r.target_id::uuid = c.parent_id)
        AND (
            ($3::uuid IS NOT NULL AND r.reporter_org_id = $3::uuid)
            OR
            ($3::uuid IS NULL AND r.reporter_id = $2 AND r.reporter_org_id IS NULL)
        )
      )
      ORDER BY 
        CASE 
          WHEN $4::uuid IS NOT NULL AND (c.comment_id = (SELECT root_id FROM target_root) OR c.parent_id = (SELECT root_id FROM target_root)) THEN 0 
          ELSE 1 
        END,
        c.is_pinned DESC NULLS LAST,
        c.pinned_at DESC NULLS LAST,
        c.created_at DESC
      `,
            [effectivePostId, userId, companyId || null, targetCommentId || null]
        );
        const mappedComments = comments.rows.map(row => ({
            ...row,
            id: row.comment_id,
            parentId: row.parent_id,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            updated_at: row.updated_at,
            isEdited: Boolean(row.is_edited),
            is_edited: Boolean(row.is_edited),
            authorId: row.author_id,
            authorName: row.full_name,
            authorAvatarUrl: row.avatar_url,
            isPinned: row.is_pinned,
            pinnedAt: row.pinned_at,
            pinnedBy: row.pinned_by
        }));
        return res.status(200).json(mappedComments);
    } catch (err) {
        console.error("Get comments error:", err);
        return res.status(500).json({ message: "Internal server error" })
    }
}

exports.hideComment = async (req, res) => {
    const { commentId } = req.params;
    let actorScope;

    try {
        actorScope = getContentActorScope(req, req.body?.companyId || null);
    } catch (err) {
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }

    const { userId, orgId: companyId } = actorScope;

    try {
        // Insert into hidden_comments
        if (companyId) {
            await pool.query(
                `INSERT INTO hidden_comments (user_id, org_id, comment_id) 
                 VALUES ($1, $2, $3) 
                 ON CONFLICT (org_id, comment_id) WHERE org_id IS NOT NULL DO NOTHING`,
                [userId, companyId, commentId]
            );
        } else {
            await pool.query(
                `INSERT INTO hidden_comments (user_id, comment_id) 
                 VALUES ($1, $2) 
                 ON CONFLICT (user_id, comment_id) WHERE org_id IS NULL DO NOTHING`,
                [userId, commentId]
            );
        }

        res.status(200).json({ message: "Comment hidden from your view", commentId });
    } catch (err) {
        console.error("Hide comment error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.unhideComment = async (req, res) => {
    const { commentId } = req.params;
    let actorScope;

    try {
        actorScope = getContentActorScope(req, req.body?.companyId || null);
    } catch (err) {
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }

    const { userId, orgId: companyId } = actorScope;

    try {
        if (companyId) {
            await pool.query(
                `DELETE FROM hidden_comments WHERE org_id = $1 AND comment_id = $2`,
                [companyId, commentId]
            );
        } else {
            await pool.query(
                `DELETE FROM hidden_comments WHERE user_id = $1 AND comment_id = $2 AND org_id IS NULL`,
                [userId, commentId]
            );
        }

        res.status(200).json({ message: "Comment restored to your view", commentId });
    } catch (err) {
        console.error("Unhide comment error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.getHiddenComments = async (req, res) => {
    let actorScope;
    const { companyId: requestedCompanyId } = req.query;

    try {
        actorScope = getContentActorScope(req, requestedCompanyId || null);
    } catch (err) {
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }

    const { userId, orgId: companyId } = actorScope;

    try {
        const query = `
            SELECT 
                c.comment_id,
                c.content,
                c.created_at,
                u.display_name as author_name,
                u.display_avatar as author_avatar
            FROM active_post_comments c
            JOIN hidden_comments hc ON c.comment_id = hc.comment_id
            JOIN user_display_profiles u ON c.author_id = u.user_id
            WHERE 
                (
                    ($2::uuid IS NOT NULL AND hc.org_id = $2::uuid)
                    OR
                    ($2::uuid IS NULL AND hc.user_id = $1 AND hc.org_id IS NULL)
                )
            ORDER BY hc.created_at DESC
        `;

        const { rows } = await pool.query(query, [userId, companyId || null]);
        res.status(200).json(rows);
    } catch (err) {
        console.error("Get hidden comments error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

//--- STORIES INTEGRATION ---
exports.getStories = async (req, res) => {
    let userId;
    let companyId;
    const { companyId: requestedCompanyId } = req.query;

    try {
        const actorScope = getContentActorScope(req, requestedCompanyId || null);
        userId = actorScope.userId;
        companyId = actorScope.orgId;
    } catch (err) {
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }

    try {
        // Fetch following IDs (including companies)
        const followingRes = await pool.query(`
            SELECT following_id as id FROM followers WHERE follower_id = $1
            UNION
            SELECT org_id as id FROM organization_followers WHERE user_id = $1
        `, [userId]);

        const followingIds = followingRes.rows.map(r => r.id);
        followingIds.push(userId); // Always include own stories

        const result = await pool.query(
            `
            SELECT 
                s.*, 
                COALESCE(comp.name, u.full_name) AS author_name, 
                CASE 
                    WHEN s.author_org_id IS NOT NULL THEN comp.logo_url 
                    ELSE u.avatar_url 
                END AS author_avatar,
                -- 1. Check if the current entity has viewed this story
                EXISTS (
                    SELECT 1 FROM story_views sv 
                    WHERE sv.story_id = s.story_id AND 
                    (
                        ($3::uuid IS NOT NULL AND sv.viewer_org_id = $3::uuid) OR
                        ($3::uuid IS NULL AND sv.viewer_id = $1 AND sv.viewer_org_id IS NULL)
                    )
                ) AS has_viewed,
                -- 2. Check if the current entity has liked this story
                EXISTS (
                    SELECT 1 FROM story_reactions sr 
                    WHERE sr.story_id = s.story_id AND sr.reaction_type = 'true' AND
                    (
                        ($3::uuid IS NOT NULL AND sr.reactor_org_id = $3::uuid) OR
                        ($3::uuid IS NULL AND sr.user_id = $1 AND sr.reactor_org_id IS NULL)
                    )
                ) AS has_liked,
                -- 3. Identity flag for UI changes
                (s.author_id = $1) AS is_author,
                (s.author_org_id IS NOT NULL) AS is_company,
                -- 4. Counts
                (SELECT COUNT(*) FROM story_views sv WHERE sv.story_id = s.story_id)::int AS view_count,
                (SELECT COUNT(*) FROM story_reactions sr WHERE sr.story_id = s.story_id AND sr.reaction_type = 'true')::int AS like_count,
                -- Shared Post Data
                CASE 
                    WHEN s.shared_post_id IS NULL THEN NULL
                    WHEN (
                        -- 1. Private: Author only
                        (sp.visibility = 'private' AND sp.author_id = $1)
                        OR
                        -- 2. Public + Personal: Connections only
                        (sp.visibility = 'public' AND sp_cat.name = 'Personal' AND (
                            sp.author_id = $1
                            OR EXISTS (
                                SELECT 1 FROM followers f1 
                                JOIN followers f2 ON f1.follower_id = f2.following_id AND f1.following_id = f2.follower_id 
                                WHERE f1.follower_id = $1 AND f1.following_id = sp.author_id
                            )
                        ))
                        OR
                        -- 3. Public + Other: Everyone
                        (sp.visibility = 'public' AND (sp_cat.name != 'Personal' OR sp_cat.name IS NULL))
                    ) THEN
                        json_build_object(
                            'is_accessible', true,
                            'post_id', sp.post_id,
                            'content', sp.content,
                            'author', json_build_object(
                                'user_id', sp_u.user_id,
                                'full_name', sp_u.full_name,
                                'avatar_url', sp_u.avatar_url
                            ),
                            'media', (SELECT json_agg(json_build_object('url', url, 'media_type', media_type)) FROM post_media WHERE post_id = sp.post_id)
                        )
                    -- Failure Analysis
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
                END AS "sharedPost"
            FROM stories s
            JOIN active_users u ON s.author_id = u.user_id
            LEFT JOIN organizations comp ON s.author_org_id = comp.org_id
            LEFT JOIN posts sp ON s.shared_post_id = sp.post_id
            LEFT JOIN active_users sp_u ON sp.author_id = sp_u.user_id
            LEFT JOIN post_categories sp_cat ON sp.category_id = sp_cat.category_id
        LEFT JOIN jobs sj ON sp.shared_job_id = sj.job_id
        LEFT JOIN organizations sj_comp ON sj.org_id = sj_comp.org_id
            WHERE s.expires_at > now()
            AND (
                s.author_id = ANY($2)
                OR s.author_org_id = ANY($2)
            )
            ORDER BY s.created_at DESC
            `,
            [userId, followingIds, companyId || null]
        );
        res.json(result.rows);
    } catch (err) {
        console.error("Get stories error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.getGroupedStories = async (req, res) => {
    let userId;
    let companyId;
    const { companyId: requestedCompanyId } = req.query;

    try {
        const actorScope = getContentActorScope(req, requestedCompanyId || null);
        userId = actorScope.userId;
        companyId = actorScope.orgId;
    } catch (err) {
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }

    try {
        let currentEntityId = userId;
        let currentEntityName = "You";
        let currentEntityAvatar = null;
        let isCompanyContext = false;

        // 1. Determine Context (Company vs User)
        if (companyId) {
            const compRes = await pool.query(`SELECT org_id, name, logo_url FROM organizations WHERE org_id = $1`, [companyId]);
            if (compRes.rowCount > 0) {
                const comp = compRes.rows[0];
                currentEntityId = comp.org_id;
                currentEntityName = "Your Company"; // UI can override
                currentEntityAvatar = comp.logo_url;
                isCompanyContext = true;
            }
        }

        if (!isCompanyContext) {
            const userRes = await pool.query(
                `SELECT user_id, full_name, avatar_url FROM users WHERE user_id = $1`,
                [userId]
            );
            if (userRes.rowCount > 0) {
                const currentUser = userRes.rows[0];
                currentEntityId = currentUser.user_id;
                currentEntityAvatar = currentUser.avatar_url;
            }
        }

        // Fetch following IDs
        let followingQuery = "SELECT following_id as id FROM followers WHERE follower_id = $1";
        if (!isCompanyContext) {
            followingQuery = `
                SELECT following_id as id FROM followers WHERE follower_id = $1
                UNION
                SELECT org_id as id FROM organization_followers WHERE user_id = $1
            `;
        }

        const followingRes = await pool.query(followingQuery, [currentEntityId]);
        const followingIds = followingRes.rows.map(r => r.id);
        followingIds.push(currentEntityId);

        // 2. Fetch all active stories with author details (prefer company info if acting as company)
        const result = await pool.query(
            `
            SELECT 
                s.*, 
                COALESCE(comp.name, u.full_name) AS author_name, 
                CASE 
                    WHEN s.author_org_id IS NOT NULL THEN comp.logo_url 
                    ELSE u.avatar_url 
                END AS author_avatar,
                COALESCE(s.author_org_id, s.author_id) AS group_key,
                -- Shared Post Data
                CASE 
                    WHEN s.shared_post_id IS NULL THEN NULL
                    WHEN (
                        -- 1. Private: Author only
                        (sp.visibility = 'private' AND sp.author_id = $1)
                        OR
                        -- 2. Public + Personal: Connections only
                        (sp.visibility = 'public' AND sp_cat.name = 'Personal' AND (
                            sp.author_id = $1
                            OR EXISTS (
                                SELECT 1 FROM followers f1 
                                JOIN followers f2 ON f1.follower_id = f2.following_id AND f1.following_id = f2.follower_id 
                                WHERE f1.follower_id = $1 AND f1.following_id = sp.author_id
                            )
                        ))
                        OR
                        -- 3. Public + Other: Everyone
                        (sp.visibility = 'public' AND (sp_cat.name != 'Personal' OR sp_cat.name IS NULL))
                    ) THEN
                        json_build_object(
                            'is_accessible', true,
                            'post_id', sp.post_id,
                            'content', sp.content,
                            'author', json_build_object(
                                'user_id', sp_u.user_id,
                                'full_name', sp_u.full_name,
                                'avatar_url', sp_u.avatar_url
                            ),
                            'media', (SELECT json_agg(json_build_object('url', url, 'media_type', media_type)) FROM post_media WHERE post_id = sp.post_id)
                        )
                    -- Failure Analysis
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
                END AS shared_post,
                s.story_metadata,

                -- Check if viewed/liked using context
                EXISTS (
                    SELECT 1 FROM story_views sv 
                    WHERE sv.story_id = s.story_id AND 
                    (
                        ($4::uuid IS NOT NULL AND sv.viewer_org_id = $4::uuid) OR
                        ($4::uuid IS NULL AND sv.viewer_id = $1 AND sv.viewer_org_id IS NULL)
                    )
                ) AS has_viewed,
                EXISTS (
                    SELECT 1 FROM story_reactions sr 
                    WHERE sr.story_id = s.story_id AND sr.reaction_type = 'true' AND
                    (
                        ($4::uuid IS NOT NULL AND sr.reactor_org_id = $4::uuid) OR
                        ($4::uuid IS NULL AND sr.user_id = $1 AND sr.reactor_org_id IS NULL)
                    )
                ) AS has_liked,
                (s.author_id = $1) AS is_author,
                (s.author_org_id IS NOT NULL) AS is_company,
                -- Aggregate counts
                (SELECT COUNT(*) FROM story_views sv WHERE sv.story_id = s.story_id)::int AS view_count,
                (SELECT COUNT(*) FROM story_reactions sr WHERE sr.story_id = s.story_id AND sr.reaction_type = 'true')::int AS like_count
            FROM stories s
            JOIN active_users u ON s.author_id = u.user_id
            LEFT JOIN organizations comp ON s.author_org_id = comp.org_id
            LEFT JOIN posts sp ON s.shared_post_id = sp.post_id
            LEFT JOIN active_users sp_u ON sp.author_id = sp_u.user_id
            LEFT JOIN post_categories sp_cat ON sp.category_id = sp_cat.category_id
        LEFT JOIN jobs sj ON sp.shared_job_id = sj.job_id
        LEFT JOIN organizations sj_comp ON sj.org_id = sj_comp.org_id
            WHERE s.expires_at > now()
            AND (
                s.author_id = $2
                OR s.author_org_id = $2
                OR s.author_id = ANY($3)
                OR s.author_org_id = ANY($3)
            )
            AND NOT EXISTS (
                SELECT 1 FROM blocks b 
                WHERE (b.blocker_id = $1 AND b.blocked_id = s.author_id)
                   OR (b.blocker_id = s.author_id AND b.blocked_id = $1)
            )
            ORDER BY s.created_at ASC
            `,
            [userId, currentEntityId, followingIds, companyId || null]
        );

        const stories = result.rows;
        const groupsMap = new Map();

        // Initialize Current Entity Group always (User or Company)
        groupsMap.set(currentEntityId, {
            author: {
                id: currentEntityId,
                name: currentEntityName,
                avatar: currentEntityAvatar,
                is_company: isCompanyContext
            },
            is_current_user: true,
            latest_story_at: null, // Will update if stories exist
            stories: []
        });

        // Group stories
        for (const story of stories) {
            const groupKey = story.group_key;

            if (!groupsMap.has(groupKey)) {
                groupsMap.set(groupKey, {
                    author: {
                        id: groupKey,
                        name: story.author_name,
                        avatar: story.author_avatar
                    },
                    // is_current_user is true for the active context (User or Company)
                    is_current_user: groupKey === currentEntityId,
                    latest_story_at: story.created_at,
                    stories: []
                });
            }

            const group = groupsMap.get(groupKey);
            group.latest_story_at = story.created_at;

            group.stories.push({
                story_id: story.story_id,
                title: story.title,
                description: story.description,
                media_url: story.media_url,
                media_type: story.media_type,
                created_at: story.created_at,
                expires_at: story.expires_at,
                author_id: groupKey, // Use groupKey as author_id for grouping consistency
                author_name: story.author_name,
                author_avatar: story.author_avatar,
                is_author: story.is_author,
                is_company: story.is_company,
                has_viewed: story.has_viewed,
                has_liked: story.has_liked,
                view_count: story.view_count || 0,
                like_count: story.like_count || 0,
                shared_post: story.shared_post,
                story_metadata: story.story_metadata,
                // Derive thumbnail_url: for Cloudinary videos swap extension to .jpg
                // for images use the media_url directly
                thumbnail_url: (() => {
                    const url = story.media_url || '';
                    if (!url) return null;
                    if (story.media_type === 'video') {
                        if (url.includes('cloudinary')) {
                            // Swap any extension (e.g. .mp4) to .jpg for thumbnail
                            return url.replace(/\.[^/.?]+(\?.*)?$/, '.jpg$1');
                        }
                        return null; // Non-cloudinary video: no thumbnail available
                    }
                    return url; // Image: use media_url directly as thumbnail
                })()
            });
        }

        // Convert to array
        const groups = Array.from(groupsMap.values());

        // Sort Groups
        groups.sort((a, b) => {
            // Always keep current user first
            if (a.is_current_user) return -1;
            if (b.is_current_user) return 1;

            // Check if groups have unseen stories
            const aHasUnseen = a.stories.some(s => !s.has_viewed);
            const bHasUnseen = b.stories.some(s => !s.has_viewed);

            // Unseen stories should appear first
            if (aHasUnseen && !bHasUnseen) return -1;
            if (!aHasUnseen && bHasUnseen) return 1;

            // If both same (both seen or both unseen) sort by latest story
            if (a.latest_story_at && b.latest_story_at) {
                return new Date(b.latest_story_at) - new Date(a.latest_story_at);
            }
            return 0;
        });

        // Ensure current user name is correct if they have stories
        if (groups.length > 0 && groups[0].is_current_user) {
            groups[0].author.name = "You";
        }

        res.json(groups);

    } catch (err) {
        console.error("Get grouped stories error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.getStoryRecommendations = async (req, res) => {
    try {
        // Mocked response or empty array for now so frontend doesn't crash 
        // until recommendations logic is actually implemented for stories.
        return res.status(200).json([]);
    } catch (err) {
        console.error("Story recommendations error:", err);
        return res.status(500).json({ message: "Internal server error" });
    }
};

exports.createStory = async (req, res) => {
    // Extract user ID from JWT — support both .sub and .user_id
    let actorScope;
    const { companyId: requestedCompanyId } = req.query;

    try {
        actorScope = getContentActorScope(req, requestedCompanyId || null);
    } catch (err) {
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }

    const { userId, orgId: companyId } = actorScope;
    if (!userId) {
        return res.status(401).json({ message: "Unauthorized: user not identified" });
    }

    let {
        title,
        media_url,        // The baked snapshot URL (image or video) from Cloudinary
        description,
        media_type,
        public_id,        // Cloudinary public_id for cleanup
        shared_post_id,
        story_metadata,   // Optional: edit metadata for re-editing (hybrid approach)
    } = req.body;

    // Sanitize user-generated content
    title = sanitizeContent(title);
    description = sanitizeContent(description);

    // --- Validate required fields ---
    if (!media_url) {
        return res.status(400).json({ message: "media_url is required" });
    }

    try {
        const authorCompanyId = companyId || null;

        // Derive media_type from URL extension if not provided
        const type = media_type || (media_url.toLowerCase().match(/\.(mp4|webm|mov)(\?|#|$)/) ? 'video' : 'image');

        // Snapshot-based: everything is immediately ready (no server-side rendering)
        const result = await pool.query(
            `INSERT INTO stories
                (author_id, title, description, media_url, media_type,
                 expires_at, cld_public_id, shared_post_id,
                 story_metadata, author_org_id)
             VALUES ($1, $2, $3, $4, $5, now() + interval '24 hours', $6, $7, $8, $9)
             RETURNING story_id, created_at`,
            [
                userId,
                title ?? '',
                description || null,
                media_url,          // $4
                type,               // $5
                public_id || null,  // $6
                shared_post_id || null, // $7
                story_metadata ? JSON.parse(JSON.stringify(story_metadata)) : {}, // $8
                authorCompanyId || null  // $9
            ]
        );

        const { story_id } = result.rows[0];

        // Fetch a DTO that perfectly matches the Showcase API expectation 
        // (so the frontend optimistic insert works instantly)
        const mappedResult = await pool.query(
            `
            SELECT 
                s.*, 
                COALESCE(comp.name, u.full_name) AS author_name, 
                CASE 
                    WHEN s.author_org_id IS NOT NULL THEN comp.logo_url 
                    ELSE u.avatar_url 
                END AS author_avatar,
                false AS has_viewed,
                false AS has_liked,
                true AS is_author,
                (s.author_org_id IS NOT NULL) AS is_company,
                0 AS view_count,
                0 AS like_count,
                CASE 
                    WHEN s.shared_post_id IS NULL THEN NULL
                    ELSE json_build_object(
                        'is_accessible', true,
                        'post_id', sp.post_id,
                        'content', sp.content,
                        'location', sp.location,
                        'author', json_build_object(
                            'user_id', sp_u.user_id,
                            'full_name', sp_u.full_name,
                            'avatar_url', sp_u.avatar_url
                        ),
                        'media', (SELECT json_agg(json_build_object('url', url, 'media_type', media_type)) FROM post_media WHERE post_id = sp.post_id)
                    )
                END AS shared_post
            FROM stories s
            JOIN active_users u ON s.author_id = u.user_id
            LEFT JOIN organizations comp ON s.author_org_id = comp.org_id
            LEFT JOIN posts sp ON s.shared_post_id = sp.post_id
            LEFT JOIN active_users sp_u ON sp.author_id = sp_u.user_id
            WHERE s.story_id = $1
            `,
            [story_id]
        );

        res.status(201).json(mappedResult.rows[0]);

    } catch (err) {
        console.error("[createStory] Database error:", err.message);
        console.error("[createStory] Full error:", err);
        res.status(500).json({ message: "Internal server error", detail: err.message });
    }
};



exports.deleteStory = async (req, res) => {
    const storyId = req.params.id;
    let actorScope;
    const { companyId: requestedCompanyId } = req.query;

    try {
        actorScope = getContentActorScope(req, requestedCompanyId || null);
    } catch (err) {
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }

    const { userId, orgId } = actorScope;

    if (!storyId) {
        return res.status(400).json({ message: "storyId is required" });
    }

    try {
        // Delete from DB and get the Cloudinary public_id for cleanup
        // Allow deletion if:
        //   1. Acting as company AND story was authored by that company (author_org_id match)
        //   2. The underlying user is the story author (author_id match) — regardless of current profile context
        const result = await pool.query(
            `DELETE FROM stories
             WHERE story_id = $1
               AND (
                    ($3::uuid IS NOT NULL AND author_org_id = $3::uuid)
                    OR
                    (author_id = $2)
               )
             RETURNING story_id, cld_public_id, media_type`,
            [storyId, userId, orgId || null]
        );

        if (result.rowCount === 0) {
            console.warn(`[deleteStory] 404 — storyId=${storyId}, userId=${userId}, orgId=${orgId || 'null'}`);
            return res.status(404).json({ message: "Story not found or unauthorized", storyId, userId });
        }

        // Clean up storage asset in background (Cloudflare R2 or legacy Cloudinary)
        const { cld_public_id } = result.rows[0];
        if (cld_public_id) {
            const key = cld_public_id.startsWith("stories/") ? cld_public_id : `stories/${cld_public_id}`;
            deleteR2Asset(key).catch(err => console.error(`[deleteStory] R2 cleanup failed for ${cld_public_id}:`, err.message));
        }

        res.status(200).json({ message: "Story deleted", deletedStoryId: storyId });
    } catch (err) {
        console.error("Delete story error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.viewStory = async (req, res) => {
    const story_id = req.params.id;
    let actorScope;

    try {
        actorScope = getContentActorScope(req, req.body?.companyId || null);
    } catch (err) {
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }

    const viewer_id = actorScope.userId;
    const companyId = actorScope.orgId;

    try {
        const storyRes = await pool.query(
            `SELECT author_id FROM stories WHERE story_id = $1`, [story_id]
        );

        if (storyRes.rowCount === 0) {
            return res.status(404).json({ message: "Story not found" });
        }

        const author_id = storyRes.rows[0].author_id;

        // If viewing as Company
        if (companyId) {
            const result = await pool.query(
                `INSERT INTO story_views (story_id, viewer_id, viewer_org_id) 
                 VALUES ($1, $2, $3)
                 ON CONFLICT (story_id, viewer_org_id) WHERE viewer_org_id IS NOT NULL 
                 DO NOTHING
                 RETURNING *`,
                [story_id, viewer_id, companyId]
            );

            // Emit live seen event to author if it's a fresh view (not a duplicate)
            if (result.rowCount > 0) {
                const viewerRes = await pool.query(
                    `SELECT o.org_id as user_id, o.name as full_name, o.logo_url as avatar_url
                     FROM organizations o WHERE o.org_id = $1`,
                    [companyId]
                );
                if (viewerRes.rowCount > 0) {
                    const viewer = viewerRes.rows[0];
                    socketService.notifyUser(author_id, "story_seen", {
                        story_id,
                        user_id: viewer.user_id,
                        full_name: viewer.full_name,
                        avatar_url: viewer.avatar_url,
                        reaction_type: null,
                        viewed_at: new Date().toISOString(),
                        org_id: companyId,
                        is_company: true,
                    });
                }
            }

            return res.status(200).json({
                message: "Company view recorded",
                story_id: story_id
            });
        }

        // If viewing as User — only insert if the viewer is NOT the author
        if (viewer_id !== author_id) {
            const result = await pool.query(
                `INSERT INTO story_views (story_id, viewer_id, viewer_org_id) 
                 VALUES ($1, $2, NULL)
                 ON CONFLICT (story_id, viewer_id) WHERE viewer_org_id IS NULL
                 DO NOTHING
                 RETURNING *`,
                [story_id, viewer_id]
            );

            // Emit live seen event to author if it's a fresh view (not a duplicate)
            if (result.rowCount > 0) {
                const viewerRes = await pool.query(
                    `SELECT u.user_id, u.full_name, u.avatar_url
                     FROM users u WHERE u.user_id = $1`,
                    [viewer_id]
                );
                if (viewerRes.rowCount > 0) {
                    const viewer = viewerRes.rows[0];
                    socketService.notifyUser(author_id, "story_seen", {
                        story_id,
                        user_id: viewer.user_id,
                        full_name: viewer.full_name,
                        avatar_url: viewer.avatar_url,
                        reaction_type: null,
                        viewed_at: new Date().toISOString(),
                        org_id: null,
                        is_company: false,
                    });
                }
            }
        }

        res.status(200).json({
            message: viewer_id === author_id ? "Author viewing (not counted)" : "View recorded",
            story_id: story_id
        });

    } catch (err) {
        console.error("View story error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};





exports.reactToStory = async (req, res) => {
    const { id: storyId } = req.params;
    const { reaction, companyId: requestedCompanyId } = req.body; // true = like, false = undo
    let actorScope;

    try {
        actorScope = getContentActorScope(req, requestedCompanyId || null);
    } catch (err) {
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }

    const userId = actorScope.userId;
    const companyId = actorScope.orgId;

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        // 1. Determine Reactor (User or Company)
        let reactorCompanyId = null;
        let reactorUserId = userId; // Default to user

        if (companyId) {
            reactorCompanyId = companyId;
            reactorUserId = null; // Reactions are attributed to Company, not User+Company? 
            // DB schema: user_id is nullable? No, schema says `user_id UUID REFERENCES users`. I made it nullable in migration?
            // Wait, I did NOT make user_id nullable in migration. I only added reactor_org_id and dropped PK.
            // I need to ensure user_id is nullable in DB if I want to support "Company Only" reaction.
            // Actually, for now let's keep user_id as the "Actor" (who clicked) and reactor_org_id as the "Context".
            // But unique constraint `idx_story_reactions_company_unique` is on `(story_id, reactor_org_id)`.
            // So if User A acts as Comp X, and User B acts as Comp X, they collide. This IS correct for "Company Reaction".
            // So `reactorUserId` should be stored for audit, but uniqueness is on Company.
            // However, my partial index `idx_story_reactions_personal_unique` is `WHERE reactor_org_id IS NULL`.
            // So if I insert `user_id` AND `reactor_org_id`, it targets the Company Index. Correct.
        }

        // 2. Fetch Story & Media URL (for notification)
        const storyRes = await client.query(`SELECT author_id, media_url FROM stories WHERE story_id = $1`, [storyId]);
        if (storyRes.rowCount === 0) return res.status(404).json({ message: "Story not found" });
        const { author_id, media_url } = storyRes.rows[0];

        // 3. Toggle Like
        let liked = false;

        // Parse explicit reaction if provided
        const isExplicit = reaction !== undefined && reaction !== null;
        const reactionVal = isExplicit ? (reaction === true || reaction === 'true') : true;

        // Check existing reaction
        let query = "";
        let params = [];

        if (reactorCompanyId) {
            query = `SELECT * FROM story_reactions WHERE story_id = $1 AND reactor_org_id = $2`;
            params = [storyId, reactorCompanyId];
        } else {
            query = `SELECT * FROM story_reactions WHERE story_id = $1 AND user_id = $2 AND reactor_org_id IS NULL`;
            params = [storyId, reactorUserId];
        }

        const existingReaction = await client.query(query, params);
        const hasExisting = existingReaction.rowCount > 0;

        if (isExplicit) {
            if (reactionVal) {
                // Explicit LIKE
                if (!hasExisting) {
                    if (reactorCompanyId) {
                        await client.query(
                            `INSERT INTO story_reactions (story_id, user_id, reactor_org_id, reaction_type)
                             VALUES ($1, $2, $3, true)
                             ON CONFLICT (story_id, reactor_org_id) WHERE reactor_org_id IS NOT NULL
                             DO UPDATE SET reaction_type = true`,
                            [storyId, userId, reactorCompanyId]
                        );
                        await client.query(
                            `INSERT INTO story_views (story_id, viewer_id, viewer_org_id)
                             VALUES ($1, $2, $3)
                             ON CONFLICT (story_id, viewer_org_id) WHERE viewer_org_id IS NOT NULL
                             DO NOTHING`,
                            [storyId, userId, reactorCompanyId]
                        );
                    } else {
                        await client.query(
                            `INSERT INTO story_reactions (story_id, user_id, reaction_type)
                             VALUES ($1, $2, true)
                             ON CONFLICT (story_id, user_id) WHERE reactor_org_id IS NULL
                             DO UPDATE SET reaction_type = true`,
                            [storyId, userId]
                        );
                        await client.query(
                            `INSERT INTO story_views (story_id, viewer_id)
                             VALUES ($1, $2)
                             ON CONFLICT (story_id, viewer_id) WHERE viewer_org_id IS NULL
                             DO NOTHING`,
                            [storyId, userId]
                        );
                    }
                }
                liked = true;
            } else {
                // Explicit UNLIKE
                if (hasExisting) {
                    if (reactorCompanyId) {
                        await client.query("DELETE FROM story_reactions WHERE story_id = $1 AND reactor_org_id = $2", [storyId, reactorCompanyId]);
                    } else {
                        await client.query("DELETE FROM story_reactions WHERE story_id = $1 AND user_id = $2 AND reactor_org_id IS NULL", [storyId, reactorUserId]);
                    }
                }
                liked = false;
            }
        } else {
            // Toggle behavior
            if (hasExisting) {
                // UNLIKE
                if (reactorCompanyId) {
                    await client.query("DELETE FROM story_reactions WHERE story_id = $1 AND reactor_org_id = $2", [storyId, reactorCompanyId]);
                } else {
                    await client.query("DELETE FROM story_reactions WHERE story_id = $1 AND user_id = $2 AND reactor_org_id IS NULL", [storyId, reactorUserId]);
                }
                liked = false;
            } else {
                // LIKE
                if (reactorCompanyId) {
                    await client.query(
                        `INSERT INTO story_reactions (story_id, user_id, reactor_org_id, reaction_type)
                         VALUES ($1, $2, $3, true)
                         ON CONFLICT (story_id, reactor_org_id) WHERE reactor_org_id IS NOT NULL
                         DO UPDATE SET reaction_type = true`,
                        [storyId, userId, reactorCompanyId]
                    );
                    await client.query(
                        `INSERT INTO story_views (story_id, viewer_id, viewer_org_id)
                         VALUES ($1, $2, $3)
                         ON CONFLICT (story_id, viewer_org_id) WHERE viewer_org_id IS NOT NULL
                         DO NOTHING`,
                        [storyId, userId, reactorCompanyId]
                    );
                } else {
                    await client.query(
                        `INSERT INTO story_reactions (story_id, user_id, reaction_type)
                         VALUES ($1, $2, true)
                         ON CONFLICT (story_id, user_id) WHERE reactor_org_id IS NULL
                         DO UPDATE SET reaction_type = true`,
                        [storyId, userId]
                    );
                    await client.query(
                        `INSERT INTO story_views (story_id, viewer_id)
                         VALUES ($1, $2)
                         ON CONFLICT (story_id, viewer_id) WHERE viewer_org_id IS NULL
                         DO NOTHING`,
                        [storyId, userId]
                    );
                }
                liked = true;
            }
        }

        // Notification (Only if not self-reaction)
        // If Company reacts to User Story -> Notify User.
        // If User reacts to User Story -> Notify User.
        // If Author is same as Actor (User Context) -> Skip.
        // If Author is same as Actor (Company Context) -> Skip ? (Company reacting to own story?)

        let shouldNotify = true;
        if (!reactorCompanyId && author_id === userId) shouldNotify = false;
        // TODO: If Company owns the story, check against Company ID? (Stories don't have owner_org_id yet, presumed User is author)

        if (shouldNotify && liked) {
            const actorName = reactorCompanyId ? (await client.query("SELECT name FROM organizations WHERE org_id = $1", [reactorCompanyId])).rows[0].name : (await client.query("SELECT full_name FROM users WHERE user_id = $1", [userId])).rows[0].full_name;
            const actorAvatar = reactorCompanyId ? (await client.query("SELECT logo_url FROM organizations WHERE org_id = $1", [reactorCompanyId])).rows[0].logo_url : (await client.query("SELECT avatar_url FROM users WHERE user_id = $1", [userId])).rows[0].avatar_url;

            const notificationData = {
                type: "story_like",
                text: `${actorName} liked your story`,
                from: userId,
                senderName: actorName,
                senderAvatar: actorAvatar,
                referenceId: storyId,
                mediaUrl: media_url,
                metadata: { org_id: reactorCompanyId }
            };

            // Notify via socket - ensuring socketService is available
            try {
                // Check global or imported socketService
                const ioService = require('../../core/infrastructure/socket.service');
                if (ioService && ioService.notifyUser) {
                    ioService.notifyUser(author_id, "notification", notificationData);
                }
            } catch (e) {
                // console.warn("Socket notification failed:", e);
            }

            // Persist to DB
            await client.query(
                `INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata) 
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                [author_id, userId, "story_like", notificationData.text, storyId, notificationData.metadata]
            );
        }

        const likeCountRes = await client.query(
            `SELECT COUNT(*) as count FROM story_reactions WHERE story_id = $1 AND reaction_type = 'true'`,
            [storyId]
        );
        const likeCount = parseInt(likeCountRes.rows[0].count, 10);

        // Fetch Liker details for Socket payload
        let actorInfo = {
            userId: null,
            username: null,
            fullName: null,
            avatar: null
        };
        try {
            if (reactorCompanyId) {
                const orgResult = await client.query(
                    "SELECT org_id, slug, name, logo_url FROM organizations WHERE org_id = $1",
                    [reactorCompanyId]
                );
                if (orgResult.rowCount > 0) {
                    const org = orgResult.rows[0];
                    actorInfo = {
                        userId: org.org_id,
                        username: org.slug,
                        fullName: org.name,
                        avatar: org.logo_url
                    };
                }
            } else {
                const userResult = await client.query(
                    "SELECT user_id, account_name, full_name, avatar_url FROM users WHERE user_id = $1",
                    [userId]
                );
                if (userResult.rowCount > 0) {
                    const user = userResult.rows[0];
                    actorInfo = {
                        userId: user.user_id,
                        username: user.account_name,
                        fullName: user.full_name,
                        avatar: user.avatar_url
                    };
                }
            }
        } catch (fetchErr) {
            console.error("Error fetching liker details for socket:", fetchErr);
        }

        try {
            const ioService = require('../../core/infrastructure/socket.service');
            if (ioService) {
                if (ioService.notifyStory) {
                    ioService.notifyStory(storyId, "story_reaction_updated", {
                        storyId,
                        likeCount,
                        userId,
                        reactorCompanyId,
                        liked,
                        liker: actorInfo,
                        actorInfo: actorInfo
                    });
                }
                if (ioService.notifyUser) {
                    ioService.notifyUser(author_id, "story_seen", {
                        story_id: storyId,
                        user_id: actorInfo.userId || userId,
                        full_name: actorInfo.fullName,
                        avatar_url: actorInfo.avatar,
                        reaction_type: liked ? 'true' : null,
                        viewed_at: new Date().toISOString(),
                        org_id: reactorCompanyId,
                        is_company: !!reactorCompanyId,
                    });
                }
            }
        } catch (e) {
            console.error("Socket emit failed", e)
        }


        await client.query("COMMIT");
        return res.status(200).json({ success: true, liked, likeCount });

    } catch (err) {
        await client.query("ROLLBACK");
        console.error("React story error:", err);
        return res.status(500).json({ message: "Failed to react to story" });
    } finally {
        client.release();
    }
};

exports.getStoryDetailsById = async (req, res) => {
    let actorScope;

    try {
        actorScope = getContentActorScope(req, req.query.companyId || null);
    } catch (err) {
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }

    const { userId, orgId } = actorScope;
    const { id: storyId } = req.params;

    try {
        const permission = await pool.query(
            `SELECT author_id, author_org_id FROM stories WHERE story_id = $1`,
            [storyId]
        );

        if (permission.rowCount === 0) {
            return res.status(404).json({ message: "Story not found" });
        }

        const story = permission.rows[0];

        // Allow access if the requesting user is the story's author (regardless of which
        // profile context they are currently browsing in — personal or company).
        // Also allow if their active company org is the story's authoring org.
        const canView = story.author_id === userId || (orgId && story.author_org_id === orgId);

        if (!canView) {
            return res.status(403).json({ message: "You don't have permission to view these details" });
        }
        const result = await pool.query(`
            SELECT 
                COALESCE(c.org_id, u.user_id) as user_id, -- Frontend uses 'user_id' as key
                COALESCE(c.name, u.full_name) as full_name, 
                CASE WHEN sv.viewer_org_id IS NOT NULL THEN c.logo_url ELSE u.avatar_url END as avatar_url, 
                sr.reaction_type, 
                sv.viewed_at,
                c.org_id,
                CASE WHEN c.org_id IS NOT NULL THEN true ELSE false END as is_company
            FROM story_views sv 
            JOIN active_users u ON sv.viewer_id = u.user_id
            LEFT JOIN organizations c ON sv.viewer_org_id = c.org_id
            -- Left Join ensures we still get the viewer even if there is no reaction
            -- Join specifically on context (Company vs User)
            LEFT JOIN story_reactions sr ON sv.story_id = sr.story_id AND (
                (sv.viewer_org_id IS NOT NULL AND sr.reactor_org_id = sv.viewer_org_id)
                OR
                (sv.viewer_org_id IS NULL AND sr.user_id = sv.viewer_id AND sr.reactor_org_id IS NULL)
            )
            WHERE sv.story_id = $1
            AND NOT EXISTS (
                SELECT 1 FROM blocks b 
                WHERE (b.blocker_id = $2 AND b.blocked_id = u.user_id) -- Viewer is blocked by me (story author)
                   OR (b.blocker_id = u.user_id AND b.blocked_id = $2) -- Viewer blocked me
            )
            ORDER BY sv.viewed_at DESC
        `, [storyId, userId]);


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

exports.getPollAnalytics = async (req, res) => {
    const { id: postId } = req.params;
    let actorScope;

    try {
        actorScope = getContentActorScope(req, req.query?.companyId || null);
    } catch (err) {
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }

    const { userId, orgId } = actorScope;

    try {
        // 1. Verify ownership
        const postRes = await pool.query(
            `SELECT author_id, author_org_id FROM posts WHERE post_id = $1`,
            [postId]
        );

        if (postRes.rowCount === 0) return res.status(404).json({ message: "Post not found" });
        const post = postRes.rows[0];
        const canViewAnalytics = orgId
            ? post.author_org_id === orgId
            : (post.author_id === userId && !post.author_org_id);
        if (!canViewAnalytics) {
            return res.status(403).json({ message: "Only the poll author can view analytics" });
        }

        // 2. Fetch Analytics
        const query = `
            SELECT 
                pp.poll_id,
                pp.duration,
                pp.created_at,
                (pp.created_at + COALESCE(pp.duration, '1 day')::interval > NOW()) as is_active,
                (SELECT COUNT(*) FROM poll_votes pv WHERE pv.poll_id = pp.poll_id) as total_votes,
                
                -- Options with counts only (NO voter details)
                (
                    SELECT json_agg(
                        json_build_object(
                            'option_id', po.option_id,
                            'option_text', po.option_text,
                            'vote_count', (SELECT COUNT(*) FROM poll_votes pv WHERE pv.option_id = po.option_id)
                        )
                    )
                    FROM poll_options po
                    WHERE po.poll_id = pp.poll_id
                ) as options,

                -- All voters in a single list (handles both individual users and company actors)
                (
                    SELECT COALESCE(json_agg(
                        json_build_object(
                            'id', COALESCE(pv.org_id::text, u.user_id::text),
                            'user_id', u.user_id,
                            'org_id', pv.org_id,
                            'is_company', (pv.org_id IS NOT NULL),
                            'full_name', COALESCE(o.name, u.full_name),
                            'account_name', COALESCE(o.slug, u.account_name),
                            'avatar_url', CASE WHEN pv.org_id IS NOT NULL THEN o.logo_url ELSE u.avatar_url END,
                            'headline', COALESCE(o.headline, u.headline),
                            'option_id', pv.option_id
                        )
                    ), '[]'::json)
                    FROM poll_votes pv
                    LEFT JOIN active_users u ON u.user_id = pv.voter_id
                    LEFT JOIN organizations o ON o.org_id = pv.org_id
                    WHERE pv.poll_id = pp.poll_id
                ) as voters

            FROM post_polls pp
            WHERE pp.post_id = $1
        `;

        const result = await pool.query(query, [postId]);

        if (result.rowCount === 0) return res.status(404).json({ message: "Poll not found for this post" });

        res.status(200).json(result.rows[0]);

    } catch (err) {
        console.error("Get poll analytics error:", err);
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }
};

// --- STORY COMMENTS ---
exports.addStoryComment = async (req, res) => {
    const storyId = req.params.id;
    let { content, companyId: requestedCompanyId } = req.body;

    // Sanitize user-generated content
    content = sanitizeContent(content);
    let actorScope;

    try {
        actorScope = getContentActorScope(req, requestedCompanyId || null);
    } catch (err) {
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }

    const userId = actorScope.userId;
    const companyId = actorScope.orgId;

    if (!storyId || !userId || !content || !content.trim()) {
        return res.status(400).json({ message: "all fields are required" })
    }

    try {
        const authorCompanyId = companyId || null;

        const story = await pool.query(`select story_id, author_id, media_url from stories where story_id = $1`, [storyId])

        if (story.rowCount === 0) {
            return res.status(404).json({ message: "Story not found" })
        }

        const storyAuthorId = story.rows[0].author_id;
        const isBlockedByAuthor = await checkBlockStatus(storyAuthorId, userId);
        const hasBlockedAuthor = await checkBlockStatus(userId, storyAuthorId);

        if (isBlockedByAuthor || hasBlockedAuthor) {
            return res.status(403).json({ message: "You cannot reply to this story" });
        }

        const result = await pool.query(
            `INSERT INTO story_comments (story_id, author_id, content, author_org_id)
             VALUES ($1, $2, $3, $4)
             RETURNING comment_id, author_id, content, created_at, author_org_id`,
            [storyId, userId, content.trim(), authorCompanyId]
        );

        const newComment = result.rows[0];

        let commenterName, commenterAvatar;
        if (authorCompanyId) {
            const compRes = await pool.query(`SELECT name, logo_url FROM organizations WHERE org_id = $1`, [authorCompanyId]);
            commenterName = compRes.rows[0].name;
            commenterAvatar = compRes.rows[0].logo_url;
        } else {
            const userRes = await pool.query(`SELECT full_name, avatar_url FROM users WHERE user_id = $1`, [userId]);
            commenterName = userRes.rows[0].full_name;
            commenterAvatar = userRes.rows[0].avatar_url;
        }

        // Notify Author (if not self)
        const authorId = story.rows[0].author_id;
        if (authorId !== userId) {

            socketService.notifyUser(authorId, "notification", {
                type: "story_comment",
                text: `${commenterName} commented on your story`,
                from: userId,
                senderName: commenterName,
                senderAvatar: commenterAvatar,
                referenceId: storyId,
                mediaUrl: story.rows[0].media_url,
                time: "Just now",
                metadata: { org_id: authorCompanyId }
            });
            // Push notification for offline devices
            sendPush(authorId, commenterName, `${commenterName} commented on your story`, { type: 'story_comment', storyId }).catch(() => {});

            await pool.query(
                `INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata) 
                  VALUES ($1, $2, $3, $4, $5, $6)`,
                [authorId, userId, "story_comment", `${commenterName} commented on your story`, storyId, { org_id: authorCompanyId }]
            );
        }

        const ioService = require("../../core/infrastructure/socket.service");
        if (ioService && ioService.notifyStory) {
            ioService.notifyStory(storyId, "story_comment_added", {
                storyId: storyId.toString(),
                comment: {
                    comment_id: newComment.comment_id,
                    content: newComment.content,
                    created_at: newComment.created_at,
                    author_id: newComment.author_id,
                    full_name: commenterName,
                    avatar_url: commenterAvatar
                }
            });
        }

        return res.status(200).json({
            message: "comment added",
            comment: newComment
        })

    } catch (err) {
        console.error("Add story comment error", err);
        return res.status(500).json({ message: "Internal server error" })
    }
}

exports.getStoryComments = async (req, res) => {
    const storyId = req.params.id;
    const { companyId: requestedCompanyId } = req.query;
    let actorScope;

    try {
        actorScope = getOptionalContentActorScope(req, requestedCompanyId || null);
    } catch (err) {
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }

    const { userId } = actorScope;

    if (!storyId) {
        return res.status(400).json({ message: "storyId is required" })
    }
    try {
        const comments = await pool.query(
            `
            SELECT 
                c.comment_id,
                c.content,
                c.created_at,
                COALESCE(comp.org_id, u.user_id) AS author_id,
                COALESCE(comp.name, u.display_name) AS full_name,
                CASE 
                    WHEN c.author_org_id IS NOT NULL THEN comp.logo_url 
                    ELSE u.display_avatar 
                END AS avatar_url,
                u.display_headline as headline,
                (c.author_org_id IS NOT NULL) AS is_company
            FROM story_comments c
            JOIN user_display_profiles u ON c.author_id = u.user_id
            LEFT JOIN organizations comp ON c.author_org_id = comp.org_id
            WHERE c.story_id = $1
            AND NOT EXISTS (
                SELECT 1 FROM blocks b 
                WHERE (b.blocker_id = $2 AND b.blocked_id = c.author_id) 
                   OR (b.blocker_id = c.author_id AND b.blocked_id = $2)
            )
            ORDER BY c.created_at asc
            `,
            [storyId, userId]
        );
        return res.status(200).json(comments.rows);
    } catch (err) {
        console.error("Get story comments error", err);
        return res.status(500).json({ message: "Internal server error" })
    }
}

exports.deleteStoryComment = async (req, res) => {
    let actorScope;
    const { companyId: requestedCompanyId } = req.query;

    try {
        actorScope = getContentActorScope(req, requestedCompanyId || null);
    } catch (err) {
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }

    const { userId, orgId } = actorScope;
    const commentId = req.params.comment_id;

    if (!userId || !commentId) {
        return res.status(400).json({ message: "userId and commentId are required" })
    }

    try {
        // Allow author of comment OR author of story to delete
        // For simplicity, let's start with author of comment
        const result = await pool.query(
            `DELETE FROM story_comments
             WHERE comment_id = $1
               AND (
                    ($3::uuid IS NOT NULL AND author_org_id = $3::uuid)
                    OR
                    ($3::uuid IS NULL AND author_id = $2 AND author_org_id IS NULL)
               )
             RETURNING comment_id`,
            [commentId, userId, orgId || null]
        );

        if (result.rowCount === 0) {
            // Check if user is story owner? Maybe later.
            return res.status(404).json({ message: "Comment not found or unauthorized" });
        }
        res.status(200).json({ message: "Comment deleted", deletedCommentId: commentId });
    } catch (err) {
        return res.status(500).json({ message: "Internal server error" })
    }
}
// --- POST MODERATION ---

exports.flagPost = async (req, res) => {
    const userId = req.user.sub;
    const { id: postId } = req.params;

    try {
        const updateRes = await pool.query(
            `UPDATE posts SET is_flagged = TRUE WHERE post_id = $1 RETURNING *`,
            [postId]
        );
        if (updateRes.rowCount === 0) {
            return res.status(404).json({ message: "Post not found" });
        }
        res.json({ message: "Post flagged successfully" });
    } catch (err) {
        console.error("Flag post error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.moderatePost = async (req, res) => {
    const adminId = req.user.sub;
    const { postId, orgId } = req.params;
    const { reason } = req.body;

    // RBAC middleware (requireOrgPermission('MANAGE_COMMENTS')) already enforces that the user
    // has moderation rights for this organization.

    try {
        // Also verify the post actually belongs to this organization
        const postCheck = await pool.query(
            `SELECT author_org_id, category_id, is_removed FROM posts WHERE post_id = $1`,
            [postId]
        );

        if (postCheck.rowCount === 0) {
            return res.status(404).json({ message: "Post not found" });
        }

        const post = postCheck.rows[0];

        if (post.author_org_id !== orgId) {
            return res.status(403).json({ message: "Post does not belong to this organization" });
        }

        if (post.is_removed) {
            return res.status(400).json({ message: "Post is already removed" });
        }

        const updateRes = await pool.query(
            `UPDATE posts 
             SET is_removed = TRUE, removed_by = $1, removed_reason = $2 
             WHERE post_id = $3 RETURNING *`,
            [adminId, reason || 'Moderator action', postId]
        );

        res.json({ message: "Post removed successfully by moderator" });
    } catch (err) {
        console.error("Moderate post error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.getPostLikes = async (req, res) => {
    const postId = req.params.id;
    // Determine viewer context (personal account or company profile)
    const actorScope = getContentActorScope(req, req.query.companyId || null);
    const viewerUserId = actorScope.userId;
    const viewerOrgId = actorScope.orgId;

    try {
        const likesRes = await pool.query(
            `SELECT 
                pl.created_at AS liked_at,
                pl.org_id IS NOT NULL AS is_organization,
                pl.user_id AS individual_user_id,
                pl.org_id AS organization_id,
                COALESCE(pl.org_id::text, pl.user_id::text) AS user_id,
                COALESCE(comp.slug, u.account_name) AS username,
                COALESCE(comp.name, u.full_name) AS full_name,
                CASE WHEN pl.org_id IS NOT NULL THEN comp.logo_url ELSE u.avatar_url END AS avatar,
                -- Determine if the liked entity is the current viewer (self)
                (
                    $2::uuid IS NOT NULL AND pl.org_id = $2::uuid
                    OR $2::uuid IS NULL AND $3::uuid IS NOT NULL AND pl.user_id = $3::uuid AND pl.org_id IS NULL
                ) AS is_self,
                -- Determine if current viewer is already following the liker (user->user, user->org, or org->org)
                (
                    $2::uuid IS NULL AND $3::uuid IS NOT NULL AND pl.user_id IS NOT NULL AND EXISTS(
                        SELECT 1 FROM followers f WHERE f.follower_id = $3::uuid AND f.following_id = pl.user_id
                    )
                    OR
                    $2::uuid IS NULL AND $3::uuid IS NOT NULL AND pl.org_id IS NOT NULL AND EXISTS(
                        SELECT 1 FROM organization_followers ofol WHERE ofol.user_id = $3::uuid AND ofol.org_id = pl.org_id
                    )
                    OR
                    $2::uuid IS NOT NULL AND pl.org_id IS NOT NULL AND EXISTS(
                        SELECT 1 FROM organization_org_follows oof WHERE oof.follower_org_id = $2::uuid AND oof.following_org_id = pl.org_id
                    )
                ) AS is_following
            FROM active_post_likes pl
            LEFT JOIN active_users u ON u.user_id = pl.user_id
            LEFT JOIN active_organizations comp ON comp.org_id = pl.org_id
            WHERE pl.post_id = $1
            AND (
                (pl.org_id IS NULL AND u.user_id IS NOT NULL) OR 
                (pl.org_id IS NOT NULL AND comp.org_id IS NOT NULL)
            )
            -- Exclude blocked users / organizations
            ${viewerOrgId ? `
            AND NOT EXISTS (
                SELECT 1 FROM blocks b 
                WHERE (b.is_org_block = true AND pl.org_id IS NULL AND ((b.blocker_id = $2 AND b.blocked_id = pl.user_id) OR (b.blocker_id = pl.user_id AND b.blocked_id = $2)))
                   OR (b.is_org_block = true AND pl.org_id IS NOT NULL AND ((b.blocker_id = pl.org_id AND b.blocked_id = $2) OR (b.blocker_id = $2 AND b.blocked_id = pl.org_id)))
            )
            ` : `
            AND NOT EXISTS (
                SELECT 1 FROM blocks b 
                WHERE (b.is_org_block = false AND pl.org_id IS NULL AND ((b.blocker_id = $3 AND b.blocked_id = pl.user_id) OR (b.blocker_id = pl.user_id AND b.blocked_id = $3)))
                   OR (b.is_org_block = true AND pl.org_id IS NOT NULL AND ((b.blocker_id = pl.org_id AND b.blocked_id = $3) OR (b.blocker_id = $3 AND b.blocked_id = pl.org_id)))
            )
            `}
            ORDER BY pl.created_at DESC`,
            [postId, viewerOrgId, viewerUserId]
        );

        return res.status(200).json({
            postId,
            likes: likesRes.rows.map(row => ({
                likedAt: row.liked_at,
                isOrganization: row.is_organization,
                individualUserId: row.individual_user_id,
                organizationId: row.organization_id,
                userId: row.user_id,
                username: row.username,
                fullName: row.full_name,
                avatar: row.avatar,
                isFollowing: row.is_following,
                isSelf: row.is_self
            }))
        });
    } catch (err) {
        console.error("Get post likes error:", err);
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }
};

// --- Enhance with AI (General Text Generator) ---
exports.generateAIContent = async (req, res) => {
    try {
        const { prompt, tone, context, companyId } = req.body;
        
        const actorScope = getContentActorScope(req, companyId || null);
        const userId = actorScope.userId;
        const orgId = actorScope.orgId;

        if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
            return res.status(400).json({ success: false, message: "Prompt is required" });
        }
        
        if (prompt.length > 500) {
            return res.status(400).json({ success: false, message: "Prompt must be under 500 characters." });
        }

        const sourceIp = req.headers["x-forwarded-for"] || req.socket.remoteAddress;

        const generatedText = await contentGenerationService.generateGeneralText(prompt, tone, context, userId, sourceIp, orgId);

        return res.status(200).json({ success: true, text: generatedText });
    } catch (err) {
        console.error("Generate AI Content Error:", err);
        return res.status(err.statusCode || 500).json({ success: false, message: err.message || "Failed to generate AI content" });
    }
};

exports.getAIUsage = async (req, res) => {
    try {
        const companyId = req.query.companyId;
        const actorScope = getContentActorScope(req, companyId || null);
        const userId = actorScope.userId;
        const orgId = actorScope.orgId;

        if (!userId && !orgId) {
            return res.status(401).json({ success: false, message: "Unauthorized" });
        }
        const stats = await contentGenerationService.getAIUsageStats(userId, orgId);
        return res.status(200).json({ success: true, remainingMonthly: Math.max(0, 45 - stats.monthlyCount) });
    } catch (err) {
        console.error("Get AI Usage Error:", err);
        return res.status(err.statusCode || 500).json({ success: false, message: err.message || "Failed to get AI usage" });
    }
};

exports.removeMention = async (req, res) => {
    const postId = req.params.id;
    let actorScope;

    try {
        actorScope = getContentActorScope(req, req.body?.companyId || req.query?.companyId || req.headers["x-actor-id"] || null);
    } catch (err) {
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }

    const { userId, orgId } = actorScope;

    if (!postId || (!userId && !orgId)) {
        return res.status(400).json({ message: "postId and actor context are required" });
    }

    try {
        let actorHandle = '';
        let actorName = '';

        if (orgId) {
            const orgResult = await pool.query("SELECT slug, name FROM organizations WHERE org_id = $1", [orgId]);
            if (orgResult.rowCount === 0) {
                return res.status(404).json({ message: "Organization not found" });
            }
            actorHandle = orgResult.rows[0].slug;
            actorName = orgResult.rows[0].name;
        } else {
            const userResult = await pool.query("SELECT account_name, full_name FROM users WHERE user_id = $1", [userId]);
            if (userResult.rowCount === 0) {
                return res.status(404).json({ message: "User not found" });
            }
            actorHandle = userResult.rows[0].account_name;
            actorName = userResult.rows[0].full_name;
        }

        const postResult = await pool.query("SELECT content FROM posts WHERE post_id = $1", [postId]);
        if (postResult.rowCount === 0) {
            return res.status(404).json({ message: "Post not found" });
        }

        let newContent = postResult.rows[0].content || '';

        if (actorHandle) {
            const escapeHandle = actorHandle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const structuredMatch = new RegExp(`@\\[([^\\]]+)\\]\\(${escapeHandle}\\)`, 'gi');
            newContent = newContent.replace(structuredMatch, '$1');

            const legacyMatch = new RegExp(`@(${escapeHandle})\\b`, 'gi');
            newContent = newContent.replace(legacyMatch, '$1');
        }

        if (actorName) {
            const escapeName = actorName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const structuredNameMatch = new RegExp(`@\\[(${escapeName})\\]\\([^)]+\\)`, 'gi');
            newContent = newContent.replace(structuredNameMatch, '$1');
        }

        if (newContent !== postResult.rows[0].content) {
            await pool.query("UPDATE posts SET content = $1, updated_at = now() WHERE post_id = $2", [newContent, postId]);
        }

        res.status(200).json({ message: "Mention removed successfully", content: newContent });
    } catch (err) {
        console.error("Error in removeMention:", err);
        res.status(500).json({ message: "Internal server error", error: err.message });
    }
};
