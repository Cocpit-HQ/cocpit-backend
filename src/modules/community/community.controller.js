const pool = require("../../core/db/pool");
const AppError = require("../../core/errors/AppError");
const redisClient = require("../../core/db/redis");
const { sendToUser } = require("../notification/notification.service");
const socketService = require("../../core/infrastructure/socket.service");

// --- GROUP 1: Community Creation (Company Side) ---

// 1. Get Community status (Check if community exists for organization)
exports.getCommunityStatus = async (req, res, next) => {
    const { orgId } = req.params;
    try {
        const result = await pool.query(
            `SELECT c.community_id, c.name, c.description, c.banner_url,
                    o.name AS company_name, o.slug AS company_slug, o.logo_url,
                    (SELECT COUNT(*) FROM community_subscriptions WHERE community_id = c.community_id AND status = 'SUBSCRIBED')::int AS subscriber_count
             FROM communities c
             JOIN organizations o ON c.org_id = o.org_id
             WHERE c.org_id = $1 AND c.is_active = TRUE AND o.is_deleted = FALSE`,
            [orgId]
        );

        if (result.rowCount === 0) {
            return res.status(200).json({
                success: true,
                has_community: false,
                community: null
            });
        }

        const row = result.rows[0];
        return res.status(200).json({
            success: true,
            has_community: true,
            community: {
                id: row.community_id,
                name: row.name,
                description: row.description,
                bannerUrl: row.banner_url,
                subscriberCount: row.subscriber_count,
                orgId: orgId,
                companyName: row.company_name,
                companySlug: row.company_slug,
                logoUrl: row.logo_url
            }
        });
    } catch (err) {
        console.error("[CommunityController] getCommunityStatus error:", err);
        return next(err);
    }
};

// 2. Create Community
exports.createCommunity = async (req, res, next) => {
    const { orgId } = req.params;
    const { name, description } = req.body;
    const bannerUrl = req.file ? req.file.path : null;
    const userId = req.user.sub;

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // Strict Actor Context Check
        if (!req.actor || req.actor.type !== "ORGANIZATION" || req.actor.id !== orgId) {
            throw new AppError("Invalid or mismatched organization actor context", 403);
        }

        if (!description) {
            throw new AppError("Description is required.", 400);
        }
        const charCount = description.trim().length;
        if (charCount < 20 || charCount > 100) {
            throw new AppError("Description must be between 20 and 100 characters.", 400);
        }

        // Check if community already exists
        const checkRes = await client.query(
            `SELECT community_id FROM communities WHERE org_id = $1 AND is_active = TRUE`,
            [orgId]
        );

        if (checkRes.rowCount > 0) {
            throw new AppError("A community already exists for this organization", 400);
        }

        const insertRes = await client.query(
            `INSERT INTO communities (org_id, name, description, banner_url, created_by)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING community_id, name, description, banner_url, org_id`,
            [orgId, name, description, bannerUrl, userId]
        );

        const row = insertRes.rows[0];

        await client.query("COMMIT");

        return res.status(201).json({
            success: true,
            message: "Community created and published successfully",
            data: {
                id: row.community_id,
                name: row.name,
                description: row.description,
                bannerUrl: row.banner_url,
                orgId: row.org_id
            }
        });
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("[CommunityController] createCommunity error:", err);
        return next(err);
    } finally {
        client.release();
    }
};

// 3. Update Community
exports.updateCommunity = async (req, res, next) => {
    const { orgId } = req.params;
    const { name, description } = req.body;
    const bannerUrl = req.file ? req.file.path : null;

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // Strict Actor Context Check
        if (!req.actor || req.actor.type !== "ORGANIZATION" || req.actor.id !== orgId) {
            throw new AppError("Invalid or mismatched organization actor context", 403);
        }

        if (description !== undefined) {
            if (!description) {
                throw new AppError("Description is required.", 400);
            }
            const charCount = description.trim().length;
            if (charCount < 20 || charCount > 100) {
                throw new AppError("Description must be between 20 and 100 characters.", 400);
            }
        }

        const updateRes = await client.query(
            `UPDATE communities 
             SET name = COALESCE($1, name),
                 description = COALESCE($2, description),
                 banner_url = COALESCE($3, banner_url),
                 updated_at = NOW()
             WHERE org_id = $4 AND is_active = TRUE
             RETURNING community_id, name, description, banner_url`,
            [name, description, bannerUrl, orgId]
        );

        if (updateRes.rowCount === 0) {
            throw new AppError("Community not found or inactive", 404);
        }

        const row = updateRes.rows[0];

        await client.query("COMMIT");

        return res.status(200).json({
            success: true,
            message: "Community updated successfully",
            data: {
                id: row.community_id,
                name: row.name,
                description: row.description,
                bannerUrl: row.banner_url
            }
        });
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("[CommunityController] updateCommunity error:", err);
        return next(err);
    } finally {
        client.release();
    }
};

// 4. Deactivate (Soft Delete) Community
exports.deactivateCommunity = async (req, res, next) => {
    const { orgId } = req.params;

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // Strict Actor Context Check
        if (!req.actor || req.actor.type !== "ORGANIZATION" || req.actor.id !== orgId) {
            throw new AppError("Invalid or mismatched organization actor context", 403);
        }

        const deleteRes = await client.query(
            `UPDATE communities 
             SET is_active = FALSE, updated_at = NOW()
             WHERE org_id = $1 AND is_active = TRUE
             RETURNING community_id`,
            [orgId]
        );

        if (deleteRes.rowCount === 0) {
            throw new AppError("Community not found or already inactive", 404);
        }

        const communityId = deleteRes.rows[0].community_id;

        // Also deactivate pending invitations for this community
        await client.query(
            `UPDATE community_invitations 
             SET is_active = FALSE, updated_at = NOW()
             WHERE community_id = $1 AND is_active = TRUE`,
            [communityId]
        );

        await client.query("COMMIT");

        return res.status(200).json({
            success: true,
            message: "Community deactivated successfully"
        });
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("[CommunityController] deactivateCommunity error:", err);
        return next(err);
    } finally {
        client.release();
    }
};

// --- GROUP 2: Subscription & Engagement (User Side) ---

// 1. Get Subscribed Communities
exports.getSubscribedCommunities = async (req, res, next) => {
    const userId = req.user.sub;
    try {
        const result = await pool.query(
            `SELECT DISTINCT c.community_id, c.name, c.description, c.banner_url, c.org_id,
                    o.name AS company_name, o.slug AS company_slug, o.logo_url,
                    (SELECT COUNT(*) FROM community_subscriptions WHERE community_id = c.community_id AND status = 'SUBSCRIBED')::int AS subscriber_count,
                    COALESCE(o.created_by = $1, FALSE) AS is_owner,
                    la.post_id AS latest_article_id,
                    la.title AS latest_article_title,
                    la.created_at AS latest_article_created_at
             FROM communities c
             JOIN organizations o ON c.org_id = o.org_id
             LEFT JOIN community_subscriptions cs ON cs.community_id = c.community_id AND cs.user_id = $1 AND cs.status = 'SUBSCRIBED'
             LEFT JOIN LATERAL (
                 SELECT p.post_id, p.title, p.created_at
                 FROM posts p
                 WHERE p.author_org_id = c.org_id
                   AND p.post_type = 'article'
                   AND p.is_active = TRUE
                   AND p.status = 'published'
                 ORDER BY p.created_at DESC
                 LIMIT 1
             ) la ON TRUE
             WHERE c.is_active = TRUE AND o.is_deleted = FALSE
               AND (
                 cs.status = 'SUBSCRIBED'
                 OR o.created_by = $1
               )
             ORDER BY c.name ASC`,
            [userId]
        );
 
        const mappedRows = result.rows.map(row => ({
            id: row.community_id,
            name: row.name,
            description: row.description,
            bannerUrl: row.banner_url,
            orgId: row.org_id,
            companyName: row.company_name,
            companySlug: row.company_slug,
            logoUrl: row.logo_url,
            subscriberCount: row.subscriber_count,
            isOwner: row.is_owner,
            latestArticle: row.latest_article_id ? {
                id: row.latest_article_id,
                title: row.latest_article_title,
                createdAt: row.latest_article_created_at
            } : null
        }));

        return res.status(200).json({
            success: true,
            data: mappedRows
        });
    } catch (err) {
        console.error("[CommunityController] getSubscribedCommunities error:", err);
        return next(err);
    }
};

// 1.2 Subscribe to a Community
exports.subscribeCommunity = async (req, res, next) => {
    const userId = req.user.sub;
    const { communityId } = req.params;

    if (req.headers['x-actor-type'] === 'ORGANIZATION') {
        return res.status(403).json({
            message: "Only a user account can subscribe to a channel."
        });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Check if community exists and is active
        const communityCheck = await client.query(
            `SELECT org_id FROM communities WHERE community_id = $1 AND is_active = TRUE`,
            [communityId]
        );

        if (communityCheck.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                message: "Community not found or inactive."
            });
        }

        const orgId = communityCheck.rows[0].org_id;

        // Check if the user trying to subscribe is Owner, Admin, or Editor in this organization
        const roleCheck = await client.query(
            `SELECT COALESCE(cr.name, cm.role) as role_name
             FROM organization_members cm
             LEFT JOIN organization_roles cr ON cm.role_id = cr.role_id
             WHERE cm.org_id = $1 AND cm.user_id = $2 AND cm.status = 'ACTIVE'`,
            [orgId, userId]
        );

        if (roleCheck.rowCount > 0) {
            const roleName = roleCheck.rows[0].role_name;
            if (['Owner', 'Admin', 'Editor'].includes(roleName)) {
                await client.query('ROLLBACK');
                return res.status(403).json({
                    message: `Users with role '${roleName}' are not allowed to subscribe to this community.`
                });
            }
        }

        // Upsert subscriber record with status = 'SUBSCRIBED'
        await client.query(
            `INSERT INTO community_subscriptions (user_id, community_id, status)
             VALUES ($1, $2, 'SUBSCRIBED')
             ON CONFLICT (user_id, community_id)
             DO UPDATE SET status = 'SUBSCRIBED', updated_at = NOW()`,
            [userId, communityId]
        );

        await client.query('COMMIT');

        // Invalidate Cache
        try {
            if (redisClient.isOpen) {
                await redisClient.del(`user:${userId}:subscribed_communities`);
                await redisClient.del(`community:${communityId}:subscribers`);
            }
        } catch (cacheErr) {
            console.warn("[SUBSCRIBE_COMMUNITY] Cache invalidation failed:", cacheErr.message);
        }

        // --- START NOTIFICATION LOGIC ---
        try {
            // Fetch professional details
            const userRes = await pool.query(`SELECT full_name, avatar_url FROM users WHERE user_id = $1`, [userId]);
            const professionalName = userRes.rows[0]?.full_name || 'A user';
            const professionalAvatar = userRes.rows[0]?.avatar_url || null;

            // Fetch company details
            const orgRes = await pool.query(`SELECT name, logo_url FROM organizations WHERE org_id = $1`, [orgId]);
            const companyName = orgRes.rows[0]?.name || 'An organization';
            const companyLogo = orgRes.rows[0]?.logo_url || null;

            // Find all active admins/owners to notify
            const adminsRes = await pool.query(`
                SELECT cm.user_id, cr.name as cr_name, cm.role as cm_role
                FROM organization_members cm
                LEFT JOIN organization_roles cr ON cm.role_id = cr.role_id
                WHERE cm.org_id = $1 AND cm.status = 'ACTIVE' 
            `, [orgId]);

            const filteredAdmins = adminsRes.rows.filter(row => ['Owner', 'Admin', 'Editor'].includes(row.cr_name || row.cm_role));
            const adminIds = filteredAdmins.map(row => row.user_id);

            if (adminIds.length > 0) {
                // 1. Follower Notification
                const notifText1 = `${professionalName} subscribed to your channel.`;
                const insertNotifQuery = `
                    INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata, recipient_org_id, is_read, created_at)
                    SELECT unnest($1::uuid[]), $2, 'company_channel_subscriber', $3, $4, $5::jsonb, $6, false, NOW()
                    RETURNING notification_id, user_id, created_at
                `;
                const notifRes1 = await pool.query(insertNotifQuery, [
                    adminIds,
                    userId,
                    notifText1,
                    userId, // reference_id is the subscriber's id
                    JSON.stringify({ org_id: orgId }),
                    orgId // recipient_org_id
                ]);

                for (const row of notifRes1.rows) {
                    // Socket
                    socketService.notifyUser(row.user_id, 'notification', {
                        notification_id: row.notification_id,
                        type: 'company_channel_subscriber',
                        text: notifText1,
                        reference_id: userId,
                        is_read: false,
                        created_at: row.created_at.toISOString(),
                        actor_name: professionalName,
                        actor_avatar: professionalAvatar,
                        is_company_actor: false,
                        metadata: { org_id: orgId }
                    });
                    
                    // Push
                    sendToUser(row.user_id, 'New channel subscriber', notifText1, {
                        type: 'company_channel_subscriber',
                        referenceId: userId
                    }).catch(() => {});
                }

                // 2. Milestone Check
                const countRes = await pool.query(
                    `SELECT COUNT(*) as total FROM community_subscriptions WHERE community_id = $1 AND status = 'SUBSCRIBED'`,
                    [communityId]
                );
                const totalSubscribers = parseInt(countRes.rows[0].total, 10);
                const milestones = [1000, 5000, 10000, 20000, 50000, 100000, 500000, 1000000];

                if (milestones.includes(totalSubscribers)) {
                    const notifText2 = `Congratulations, your channel has reached ${totalSubscribers} subscribers.`;
                    const insertMilestoneQuery = `
                        INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata, recipient_org_id, is_read, created_at)
                        SELECT unnest($1::uuid[]), NULL, 'company_channel_milestone', $2, $3, $4::jsonb, $5, false, NOW()
                        RETURNING notification_id, user_id, created_at
                    `;
                    const notifRes2 = await pool.query(insertMilestoneQuery, [
                        adminIds,
                        notifText2,
                        orgId, // reference_id is the company_id for milestone
                        JSON.stringify({ subscriber_count: totalSubscribers, org_id: orgId }),
                        orgId // recipient_org_id
                    ]);

                    for (const row of notifRes2.rows) {
                        // Socket
                        socketService.notifyUser(row.user_id, 'notification', {
                            notification_id: row.notification_id,
                            type: 'company_channel_milestone',
                            text: notifText2,
                            reference_id: orgId,
                            is_read: false,
                            created_at: row.created_at.toISOString(),
                            actor_name: companyName,
                            actor_avatar: companyLogo,
                            is_company_actor: true,
                            metadata: { subscriber_count: totalSubscribers, org_id: orgId }
                        });
                        
                        // Push
                        sendToUser(row.user_id, 'Your channel is growing', notifText2, {
                            type: 'company_channel_milestone',
                            referenceId: orgId
                        }).catch(() => {});
                    }
                }
            }
        } catch (notifErr) {
            console.error("[SUBSCRIBE_COMMUNITY] Notification error:", notifErr);
        }
        // --- END NOTIFICATION LOGIC ---

        res.status(200).json({ message: "Subscribed successfully" });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Subscribe community error:", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

// 1.3 Unsubscribe from a Community
exports.unsubscribeCommunity = async (req, res, next) => {
    const userId = req.user.sub;
    const { communityId } = req.params;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Update subscriber record status to 'UNSUBSCRIBED'
        await client.query(
            `UPDATE community_subscriptions
             SET status = 'UNSUBSCRIBED', updated_at = NOW()
             WHERE user_id = $1 AND community_id = $2`,
            [userId, communityId]
        );

        await client.query('COMMIT');

        // Invalidate Cache
        try {
            if (redisClient.isOpen) {
                await redisClient.del(`user:${userId}:subscribed_communities`);
                await redisClient.del(`community:${communityId}:subscribers`);
            }
        } catch (cacheErr) {
            console.warn("[UNSUBSCRIBE_COMMUNITY] Cache invalidation failed:", cacheErr.message);
        }

        res.status(200).json({ message: "Unsubscribed successfully" });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Unsubscribe community error:", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

// 2. Get Community Article Feed
exports.getCommunityArticles = async (req, res, next) => {
    const { communityId } = req.params;
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || "10")));
    const cursor = req.query.cursor || null;
    const requestedStatus = req.query.status || "published";

    if (requestedStatus !== "published" && requestedStatus !== "draft") {
        return next(new AppError("Invalid status parameter. Must be 'published' or 'draft'", 400));
    }

    try {
        // Fetch community and check organization ID
        const commRes = await pool.query(
            `SELECT org_id FROM communities WHERE community_id = $1 AND is_active = TRUE`,
            [communityId]
        );

        if (commRes.rowCount === 0) {
            throw new AppError("Community not found or inactive", 404);
        }

        const orgId = commRes.rows[0].org_id;

        // If requesting draft articles, verify organization membership
        if (requestedStatus === "draft") {
            if (!req.user) {
                throw new AppError("Authentication required to view drafts", 401);
            }
            const checkMember = await pool.query(
                `SELECT 1 FROM organization_members WHERE org_id = $1 AND user_id = $2 AND status = 'ACTIVE'`,
                [orgId, req.user.sub || req.user.user_id]
            );
            if (checkMember.rowCount === 0) {
                throw new AppError("Forbidden: You cannot view draft articles for this organization", 403);
            }
        }

        // Get total count of articles matching the criteria
        const countRes = await pool.query(
            `SELECT COUNT(*) FROM posts p
             WHERE p.author_org_id = $1
               AND p.post_type = 'article'
               AND p.is_active = TRUE
               AND p.status = $2`,
            [orgId, requestedStatus]
        );
        const total = parseInt(countRes.rows[0].count);

        let queryParams = [orgId, requestedStatus, limit];
        let cursorCondition = "";

        if (cursor) {
            cursorCondition = "AND p.created_at < $4";
            queryParams.push(cursor);
        }

        const result = await pool.query(
            `SELECT p.post_id, p.author_org_id, p.title, p.content, p.status, p.created_at, p.updated_at,
                    (SELECT pm.url FROM post_media pm WHERE pm.post_id = p.post_id LIMIT 1) AS banner_url
             FROM posts p
             WHERE p.author_org_id = $1
               AND p.post_type = 'article'
               AND p.is_active = TRUE
               AND p.status = $2
               ${cursorCondition}
             ORDER BY p.created_at DESC
             LIMIT $3`,
            queryParams
        );

        const mappedRows = result.rows.map(row => ({
            id: row.post_id,
            channelId: row.author_org_id,
            title: row.title,
            content: row.content,
            coverImage: row.banner_url || null,
            status: row.status,
            publishedAt: row.created_at,
            updatedAt: row.updated_at
        }));

        const nextCursor = mappedRows.length === limit ? mappedRows[mappedRows.length - 1].publishedAt : null;

        return res.status(200).json({
            success: true,
            data: mappedRows,
            total,
            nextCursor,
            limit
        });
    } catch (err) {
        console.error("[CommunityController] getCommunityArticles error:", err);
        return next(err);
    }
};

// --- GROUP 3: Invitation Flow ---

// 1. Get Invitation Suggestions (connections of recruiter + followers of company)
exports.getInviteSuggestions = async (req, res, next) => {
    const { orgId } = req.params;
    const userId = req.user.sub;
    const search = req.query.search || "";
    const page = Math.max(1, parseInt(req.query.page || "1"));
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || "10")));
    const offset = (page - 1) * limit;

    try {
        let query, params;

        if (search) {
            // Suggest search from active users
            query = `
                SELECT u.user_id, u.full_name AS name, u.avatar_url AS avatar, u.headline,
                       FALSE AS is_invited
                FROM active_users u
                WHERE u.full_name ILIKE $2 
                  AND u.user_id != $3
                  AND u.full_name IS NOT NULL 
                  AND TRIM(u.full_name) != ''
                  AND NOT EXISTS (
                      SELECT 1 FROM community_invitations ci
                      JOIN communities comm ON ci.community_id = comm.community_id
                      WHERE ci.invitee_id = u.user_id 
                        AND comm.org_id = $1 
                        AND ci.status = 'PENDING'
                        AND ci.is_active = TRUE
                  )
                  AND NOT EXISTS (
                      SELECT 1 FROM community_subscriptions cs
                      JOIN communities comm ON cs.community_id = comm.community_id
                      WHERE cs.user_id = u.user_id 
                        AND comm.org_id = $1 
                        AND cs.status = 'SUBSCRIBED'
                  )
                ORDER BY u.full_name ASC
                LIMIT $4 OFFSET $5
            `;
            params = [orgId, `%${search}%`, userId, limit, offset];
        } else {
            // Suggest default: All active users, but prioritize recruiter's connections and company followers
            query = `
                SELECT u.user_id, u.full_name AS name, u.avatar_url AS avatar, u.headline,
                       FALSE AS is_invited,
                       CASE 
                           WHEN EXISTS (
                               SELECT 1 FROM connections c 
                               WHERE (c.user_id = $2 AND c.connected_user_id = u.user_id) 
                                  OR (c.connected_user_id = $2 AND c.user_id = u.user_id)
                           ) THEN 1
                           WHEN EXISTS (
                               SELECT 1 FROM organization_followers ofol 
                               WHERE ofol.user_id = u.user_id AND ofol.org_id = $1
                           ) THEN 2
                           ELSE 3
                       END AS priority
                FROM active_users u
                WHERE u.user_id != $2
                  AND u.full_name IS NOT NULL 
                  AND TRIM(u.full_name) != ''
                  AND NOT EXISTS (
                      SELECT 1 FROM community_invitations ci
                      JOIN communities comm ON ci.community_id = comm.community_id
                      WHERE ci.invitee_id = u.user_id 
                        AND comm.org_id = $1 
                        AND ci.status = 'PENDING'
                        AND ci.is_active = TRUE
                  )
                  AND NOT EXISTS (
                      SELECT 1 FROM community_subscriptions cs
                      JOIN communities comm ON cs.community_id = comm.community_id
                      WHERE cs.user_id = u.user_id 
                        AND comm.org_id = $1 
                        AND cs.status = 'SUBSCRIBED'
                  )
                ORDER BY priority ASC, u.full_name ASC
                LIMIT $3 OFFSET $4
            `;
            params = [orgId, userId, limit, offset];
        }

        const result = await pool.query(query, params);

        const mappedRows = result.rows.map(row => ({
            id: row.user_id,
            name: row.name,
            avatarUrl: row.avatar,
            headline: row.headline,
            isInvited: row.is_invited
        }));

        return res.status(200).json({
            success: true,
            data: mappedRows
        });
    } catch (err) {
        console.error("[CommunityController] getInviteSuggestions error:", err);
        return next(err);
    }
};

// 2. Send Community Invitation
exports.sendInvitation = async (req, res, next) => {
    const { orgId } = req.params;
    const { invitee_id } = req.body;
    const inviterId = req.user.sub;

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // Strict Actor Context Check
        if (!req.actor || req.actor.type !== "ORGANIZATION" || req.actor.id !== orgId) {
            throw new AppError("Invalid or mismatched organization actor context", 403);
        }

        // Fetch community ID
        const commRes = await client.query(
            `SELECT community_id, name FROM communities WHERE org_id = $1 AND is_active = TRUE`,
            [orgId]
        );

        if (commRes.rowCount === 0) {
            throw new AppError("No active community exists for this organization", 404);
        }

        const { community_id, name: communityName } = commRes.rows[0];

        // Guard: block invitation if user is already subscribed
        const subCheck = await client.query(
            `SELECT 1 FROM community_subscriptions
             WHERE user_id = $1 AND community_id = $2 AND status = 'SUBSCRIBED'`,
            [invitee_id, community_id]
        );
        if (subCheck.rowCount > 0) {
            await client.query("ROLLBACK");
            throw new AppError("User is already subscribed to this community", 400);
        }

        // Guard: block invitation if user already has a pending invitation
        const inviteCheck = await client.query(
            `SELECT 1 FROM community_invitations
             WHERE invitee_id = $1 AND community_id = $2 AND status = 'PENDING' AND is_active = TRUE`,
            [invitee_id, community_id]
        );
        if (inviteCheck.rowCount > 0) {
            await client.query("ROLLBACK");
            throw new AppError("This user has already been invited", 400);
        }

        // Fetch company name
        const orgRes = await client.query(
            `SELECT name, logo_url FROM organizations WHERE org_id = $1`,
            [orgId]
        );
        const companyName = orgRes.rows[0]?.name || "Organization";
        const companyLogo = orgRes.rows[0]?.logo_url;

        // Fetch inviter name
        const inviterRes = await client.query(`SELECT full_name FROM users WHERE user_id = $1`, [inviterId]);
        const inviterName = inviterRes.rows[0]?.full_name || "Someone";

        const insertRes = await client.query(
            `INSERT INTO community_invitations (community_id, inviter_id, invitee_id, status, is_active)
             VALUES ($1, $2, $3, 'PENDING', TRUE)
             ON CONFLICT (community_id, invitee_id)
             DO UPDATE SET status = 'PENDING', is_active = TRUE, updated_at = NOW()
             RETURNING invite_id`,
            [community_id, inviterId, invitee_id]
        );

        const inviteId = insertRes.rows[0].invite_id;

        // Insert notification record for the invitee
        const notificationText = `${companyName} invited you to join "${communityName}".`;
        const meta = {
            org_id: orgId,
            invite_id: inviteId
        };
        await client.query(
            `INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [invitee_id, inviterId, "community_invite", notificationText, inviteId, JSON.stringify(meta)]
        );

        sendToUser(
            invitee_id, 
            "You're invited to join a channel", 
            notificationText, 
            { type: "community_invite", referenceId: inviteId }
        ).catch(() => {});

        await client.query("COMMIT");

        // Emit socket notification
        try {
            const socketService = require("../../core/infrastructure/socket.service");
            socketService.notifyUser(invitee_id, "notification", {
                type: "community_invite",
                text: notificationText,
                from: inviterId,
                senderName: companyName,
                senderAvatar: companyLogo,
                referenceId: inviteId,
                metadata: meta,
                time: "Just now"
            });
        } catch (socketErr) {
            console.error("[CommunityController] Failed to send socket notification:", socketErr);
        }

        return res.status(201).json({
            success: true,
            message: "Invitation sent successfully",
            invite_id: inviteId
        });
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("[CommunityController] sendInvitation error:", err);
        return next(err);
    } finally {
        client.release();
    }
};

// 3. Get Pending Invitations (Separate endpoint for candidate)
exports.getPendingInvitations = async (req, res, next) => {
    const userId = req.user.sub;
    try {
        const result = await pool.query(
            `SELECT ci.invite_id, ci.created_at, c.org_id AS sender_org_id, 
                    o.name AS company_name, o.logo_url, o.slug AS company_slug
             FROM community_invitations ci
             JOIN communities c ON ci.community_id = c.community_id
             JOIN organizations o ON c.org_id = o.org_id
             WHERE ci.invitee_id = $1 
               AND LOWER(ci.status::text) = 'pending' 
               AND COALESCE(ci.is_active, TRUE) = TRUE 
               AND COALESCE(c.is_active, TRUE) = TRUE`,
            [userId]
        );

        const mappedRows = result.rows.map(row => ({
            inviteId: row.invite_id,
            createdAt: row.created_at,
            senderOrgId: row.sender_org_id,
            companyName: row.company_name,
            logoUrl: row.logo_url,
            companySlug: row.company_slug
        }));

        return res.status(200).json({
            success: true,
            data: mappedRows
        });
    } catch (err) {
        console.error("[CommunityController] getPendingInvitations error:", err);
        return next(err);
    }
};

// 4. Accept Invitation
exports.acceptInvitation = async (req, res, next) => {
    const { inviteId } = req.params;
    const userId = req.user.sub;

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // Fetch invitation
        const inviteRes = await client.query(
            `SELECT ci.community_id, ci.invitee_id, ci.inviter_id, c.org_id, c.name as community_name 
             FROM community_invitations ci
             JOIN communities c ON ci.community_id = c.community_id
             WHERE ci.invite_id = $1 AND ci.status = 'PENDING' AND ci.is_active = TRUE`,
            [inviteId]
        );

        if (inviteRes.rowCount === 0) {
            throw new AppError("Invitation not found or already processed", 404);
        }

        const { community_id, invitee_id, inviter_id, org_id, community_name } = inviteRes.rows[0];

        if (invitee_id !== userId) {
            throw new AppError("Not authorized to accept this invitation", 403);
        }

        // Mark invite accepted
        await client.query(
            `UPDATE community_invitations 
             SET status = 'ACCEPTED', updated_at = NOW() 
             WHERE invite_id = $1`,
            [inviteId]
        );

        // Subscribe only if not already subscribed (user may have subscribed directly)
        const alreadySubscribed = await client.query(
            `SELECT 1 FROM community_subscriptions
             WHERE user_id = $1 AND community_id = $2 AND status = 'SUBSCRIBED'`,
            [userId, community_id]
        );
        if (alreadySubscribed.rowCount === 0) {
            await client.query(
                `INSERT INTO community_subscriptions (user_id, community_id, status)
                 VALUES ($1, $2, 'SUBSCRIBED')
                 ON CONFLICT (user_id, community_id)
                 DO UPDATE SET status = 'SUBSCRIBED', updated_at = NOW()`,
                [userId, community_id]
            );
        }

        // Fetch candidate details
        const inviteeNameRes = await client.query(
            `SELECT full_name, avatar_url FROM users WHERE user_id = $1`,
            [userId]
        );
        const inviteeName = inviteeNameRes.rows[0]?.full_name || "A candidate";
        const inviteeAvatar = inviteeNameRes.rows[0]?.avatar_url;

        // Insert notification record for the inviter recruiter
        const notificationText = `${inviteeName} accepted your invite to "${community_name}".`;
        const meta = {
            org_id: org_id,
            invite_id: inviteId
        };
        await client.query(
            `INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata, recipient_org_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [inviter_id, userId, "community_invite_accepted", notificationText, inviteId, JSON.stringify(meta), org_id]
        );

        sendToUser(
            inviter_id,
            "Invitation accepted",
            notificationText,
            { type: "community_invite_accepted", referenceId: org_id }
        ).catch(() => {});

        await client.query("COMMIT");

        // Emit socket notification
        try {
            const socketService = require("../../core/infrastructure/socket.service");
            socketService.notifyUser(inviter_id, "notification", {
                type: "community_invite_accepted",
                text: notificationText,
                from: userId,
                senderName: inviteeName,
                senderAvatar: inviteeAvatar,
                referenceId: inviteId,
                metadata: meta,
                time: "Just now",
                recipient_org_id: org_id
            });
        } catch (socketErr) {
            console.error("[CommunityController] Failed to send socket notification:", socketErr);
        }

        return res.status(200).json({
            success: true,
            message: "Invitation accepted. Subscribed to community.",
            org_id
        });
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("[CommunityController] acceptInvitation error:", err);
        return next(err);
    } finally {
        client.release();
    }
};

// 5. Ignore Invitation
exports.ignoreInvitation = async (req, res, next) => {
    const { inviteId } = req.params;
    const userId = req.user.sub;

    try {
        const result = await pool.query(
            `UPDATE community_invitations 
             SET status = 'IGNORED', updated_at = NOW() 
             WHERE invite_id = $1 AND invitee_id = $2 AND status = 'PENDING' AND is_active = TRUE`,
            [inviteId, userId]
        );

        if (result.rowCount === 0) {
            throw new AppError("Invitation not found or already processed", 404);
        }

        return res.status(200).json({
            success: true,
            message: "Invitation ignored successfully"
        });
    } catch (err) {
        console.error("[CommunityController] ignoreInvitation error:", err);
        return next(err);
    }
};

// --- GROUP 4: Search & Discovery ---

// 1. Get Recommended Communities
exports.getRecommendedCommunities = async (req, res, next) => {
    const userId = req.user.sub;
    const limit = Math.min(20, Math.max(1, parseInt(req.query.limit || "5")));
    try {
        const result = await pool.query(
            `SELECT c.community_id, c.name, c.description, c.banner_url, c.org_id,
                    o.name AS company_name, o.logo_url,
                    (SELECT COUNT(*) FROM community_subscriptions WHERE community_id = c.community_id AND status = 'SUBSCRIBED')::int AS subscriber_count
             FROM communities c
             JOIN organizations o ON c.org_id = o.org_id
             WHERE c.is_active = TRUE AND o.is_deleted = FALSE
               AND NOT EXISTS (
                   SELECT 1 FROM community_subscriptions cs 
                   WHERE cs.community_id = c.community_id AND cs.user_id = $1 AND cs.status = 'SUBSCRIBED'
               )
               AND o.created_by != $1
             LIMIT $2`,
            [userId, limit]
        );

        const mappedRows = result.rows.map(row => ({
            id: row.community_id,
            name: row.name,
            description: row.description,
            bannerUrl: row.banner_url,
            orgId: row.org_id,
            companyName: row.company_name,
            logoUrl: row.logo_url,
            subscriberCount: row.subscriber_count
        }));

        return res.status(200).json({
            success: true,
            data: mappedRows
        });
    } catch (err) {
        console.error("[CommunityController] getRecommendedCommunities error:", err);
        return next(err);
    }
};

// 2. Search Communities
exports.searchCommunities = async (req, res, next) => {
    const search = req.query.q || "";
    const userId = req.user?.sub || null;
    const page = Math.max(1, parseInt(req.query.page || "1"));
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || "10")));
    const offset = (page - 1) * limit;

    try {
        const result = await pool.query(
            `SELECT c.community_id, c.name, c.description, c.banner_url, c.org_id,
                    o.name AS company_name, o.logo_url,
                    (SELECT COUNT(*) FROM community_subscriptions WHERE community_id = c.community_id AND status = 'SUBSCRIBED')::int AS subscriber_count,
                    COALESCE(
                        EXISTS(
                            SELECT 1 FROM community_subscriptions cs 
                            WHERE cs.community_id = c.community_id AND cs.user_id = $1 AND cs.status = 'SUBSCRIBED'
                        ) OR (o.created_by = $1), FALSE
                    ) AS is_subscribed,
                    COALESCE(o.created_by = $1, FALSE) AS is_owner,
                    COUNT(*) OVER() AS total_count
             FROM communities c
             JOIN organizations o ON c.org_id = o.org_id
             WHERE c.is_active = TRUE AND o.is_deleted = FALSE
               AND (c.name ILIKE $2 OR o.name ILIKE $2)
             LIMIT $3 OFFSET $4`,
            [userId, `%${search}%`, limit, offset]
        );
 
        const mappedRows = result.rows.map(row => ({
            id: row.community_id,
            name: row.name,
            description: row.description,
            bannerUrl: row.banner_url,
            orgId: row.org_id,
            companyName: row.company_name,
            logoUrl: row.logo_url,
            subscriberCount: row.subscriber_count,
            isSubscribed: row.is_subscribed,
            isOwner: row.is_owner
        }));

        const totalCount = result.rows.length > 0 ? parseInt(result.rows[0].total_count, 10) : 0;

        return res.status(200).json({
            success: true,
            data: mappedRows,
            total: totalCount,
            page,
            limit
        });
    } catch (err) {
        console.error("[CommunityController] searchCommunities error:", err);
        return next(err);
    }
};

// 3. Get Subscriber Growth (For analytics dashboard)
exports.getSubscriberGrowth = async (req, res, next) => {
    const { orgId } = req.params;
    try {
        // Strict Actor Context Check
        if (!req.actor || req.actor.type !== "ORGANIZATION" || req.actor.id !== orgId) {
            throw new AppError("Invalid or mismatched organization actor context", 403);
        }

        // Get base count of subscribers before current year
        const baseResult = await pool.query(
            `SELECT COUNT(*)::int AS count
             FROM community_subscriptions cs
             JOIN communities c ON cs.community_id = c.community_id
             WHERE c.org_id = $1 AND cs.status = 'SUBSCRIBED' AND cs.updated_at < DATE_TRUNC('year', CURRENT_DATE)`,
            [orgId]
        );
        const baseCount = baseResult.rows[0]?.count || 0;

        // Get monthly subscriber counts for current year
        const monthlyResult = await pool.query(
            `SELECT DATE_TRUNC('month', cs.updated_at) AS month_date, COUNT(*)::int AS count
             FROM community_subscriptions cs
             JOIN communities c ON cs.community_id = c.community_id
             WHERE c.org_id = $1 AND cs.status = 'SUBSCRIBED' AND cs.updated_at >= DATE_TRUNC('year', CURRENT_DATE)
             GROUP BY DATE_TRUNC('month', cs.updated_at)
             ORDER BY DATE_TRUNC('month', cs.updated_at) ASC`,
            [orgId]
        );

        // Map monthly counts into a lookup object
        const monthlyMap = {};
        monthlyResult.rows.forEach(row => {
            const dateObj = new Date(row.month_date);
            monthlyMap[dateObj.getMonth()] = row.count;
        });

        // Generate list of months from January of current year to present month
        const currentMonth = new Date().getMonth(); // 0-indexed (Jan is 0)
        const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

        const mapped = [];
        let runningTotal = baseCount;
        for (let m = 0; m <= currentMonth; m++) {
            const monthCount = monthlyMap[m] || 0;
            runningTotal += monthCount;
            mapped.push({
                date: monthNames[m],
                subscribers: runningTotal
            });
        }

        return res.status(200).json({
            success: true,
            data: mapped
        });
    } catch (err) {
        console.error("[CommunityController] getSubscriberGrowth error:", err);
        return next(err);
    }
};

// 4. Get Community Subscribers (for company profile modal)
exports.getCommunitySubscribers = async (req, res, next) => {
    const { orgId } = req.params;
    const { search } = req.query;

    try {
        const queryParams = [orgId];
        let searchClause = "";

        if (search && search.trim()) {
            searchClause = ` AND u.full_name ILIKE $2`;
            queryParams.push(`%${search.trim()}%`);
        }

        const result = await pool.query(
            `SELECT u.user_id, u.full_name AS name, u.avatar_url AS avatar, u.headline,
                    MAX(cs.updated_at) AS subscribed_at
             FROM community_subscriptions cs
             JOIN communities c ON cs.community_id = c.community_id
             JOIN active_users u ON cs.user_id = u.user_id
             WHERE c.org_id = $1 AND cs.status = 'SUBSCRIBED'
             ${searchClause}
             GROUP BY u.user_id, u.full_name, u.avatar_url, u.headline
             ORDER BY subscribed_at DESC`,
            queryParams
        );

        const mappedRows = result.rows.map(row => ({
            id: row.user_id,
            name: row.name,
            avatarUrl: row.avatar,
            headline: row.headline,
            subscribedAt: row.subscribed_at
        }));

        return res.status(200).json({
            success: true,
            data: mappedRows
        });
    } catch (err) {
        console.error("[CommunityController] getCommunitySubscribers error:", err);
        return next(err);
    }
};

// Get community details by community ID
exports.getCommunityById = async (req, res, next) => {
    const { communityId } = req.params;
    const userId = req.user?.sub || null;
    try {
        const result = await pool.query(
            `SELECT c.community_id, c.org_id, c.name, c.description, c.banner_url,
                    o.name AS company_name, o.slug AS company_slug, o.logo_url,
                    (SELECT COUNT(*) FROM community_subscriptions WHERE community_id = c.community_id AND status = 'SUBSCRIBED')::int AS subscriber_count,
                    COALESCE(
                        EXISTS(
                            SELECT 1 FROM community_subscriptions cs 
                            WHERE cs.community_id = c.community_id AND cs.user_id = $1 AND cs.status = 'SUBSCRIBED'
                        ) OR (o.created_by = $1), FALSE
                    ) AS is_subscribed,
                    COALESCE(o.created_by = $1, FALSE) AS is_owner
             FROM communities c
             JOIN organizations o ON c.org_id = o.org_id
             WHERE c.community_id = $2 AND c.is_active = TRUE AND o.is_deleted = FALSE`,
            [userId, communityId]
        );

        if (result.rowCount === 0) {
            throw new AppError("Community not found or inactive", 404);
        }

        const row = result.rows[0];
        return res.status(200).json({
            success: true,
            data: {
                id: row.community_id,
                name: row.name,
                description: row.description,
                bannerUrl: row.banner_url,
                orgId: row.org_id,
                companyName: row.company_name,
                companySlug: row.company_slug,
                logoUrl: row.logo_url,
                subscriberCount: row.subscriber_count,
                isSubscribed: row.is_subscribed,
                isOwner: row.is_owner
            }
        });
    } catch (err) {
        console.error("[CommunityController] getCommunityById error:", err);
        return next(err);
    }
};

// 5. Remove Community Subscriber (company side action)
exports.removeCommunitySubscriber = async (req, res, next) => {
    const { orgId, userId } = req.params;

    try {
        const result = await pool.query(
            `UPDATE community_subscriptions
             SET status = 'UNSUBSCRIBED', updated_at = NOW()
             WHERE user_id = $2
               AND status = 'SUBSCRIBED'
               AND community_id IN (SELECT community_id FROM communities WHERE org_id = $1)
             RETURNING community_id`,
            [orgId, userId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ message: "Subscriber not found or already unsubscribed." });
        }

        try {
            if (redisClient.isOpen) {
                await redisClient.del(`user:${userId}:subscribed_communities`);
                await redisClient.del(`community:${result.rows[0].community_id}:subscribers`);
            }
        } catch (cacheErr) {}

        return res.status(200).json({ success: true, message: "Subscriber removed successfully." });
    } catch (err) {
        console.error("[CommunityController] removeCommunitySubscriber error:", err);
        return next(err);
    }
};

// Request edit access for a community
exports.requestEditAccess = async (req, res, next) => {
    const { orgId } = req.params;
    const userId = req.user.sub;

    try {
        // Fetch organization details
        const orgRes = await pool.query(
            `SELECT name FROM organizations WHERE org_id = $1`,
            [orgId]
        );
        if (orgRes.rowCount === 0) {
            throw new AppError("Organization not found", 404);
        }
        const companyName = orgRes.rows[0].name;

        // Fetch user details
        const userRes = await pool.query(
            `SELECT full_name FROM users WHERE user_id = $1`,
            [userId]
        );
        const userName = userRes.rows[0]?.full_name || "A user";

        // Find Owner or Admins of the organization to notify
        const adminsRes = await pool.query(
            `SELECT cm.user_id 
             FROM organization_members cm
             LEFT JOIN organization_roles cr ON cm.role_id = cr.role_id
             WHERE cm.org_id = $1 AND cm.status = 'ACTIVE' 
               AND (COALESCE(cr.name, cm.role) IN ('Owner', 'Admin'))`,
            [orgId]
        );

        if (adminsRes.rowCount > 0) {
            const notificationText = `requested edit access to the ${companyName} community`;
            const meta = {
                org_id: orgId,
                requestee_id: userId
            };

            const notificationQueries = adminsRes.rows.map(admin => {
                return pool.query(
                    `INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata, recipient_org_id)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [admin.user_id, userId, "community_access_request", notificationText, orgId, JSON.stringify(meta), orgId]
                );
            });

            await Promise.all(notificationQueries);

            // Notify via socket for each admin
            try {
                const socketService = require("../../core/infrastructure/socket.service");
                adminsRes.rows.forEach(admin => {
                    socketService.notifyUser(admin.user_id, "notification", {
                        type: "community_access_request",
                        text: notificationText,
                        from: userId,
                        senderName: userName,
                        referenceId: orgId,
                        metadata: meta,
                        time: "Just now",
                        recipient_org_id: orgId
                    });
                });
            } catch (socketErr) {
                console.error("[CommunityController] requestEditAccess socket notification failed:", socketErr);
            }
        }

        return res.status(200).json({
            success: true,
            message: "Edit access request sent successfully."
        });
    } catch (err) {
        console.error("[CommunityController] requestEditAccess error:", err);
        return next(err);
    }
};

// --- Search Articles across all active Channels ---
/**
 * GET /api/communities/articles/search?q=&page=&limit=
 * Search published channel articles by title or content across all active communities.
 */
exports.searchArticles = async (req, res, next) => {
    const search = req.query.q || "";
    const page = Math.max(1, parseInt(req.query.page || "1"));
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || "10")));
    const offset = (page - 1) * limit;

    try {
        const result = await pool.query(
            `SELECT
                p.post_id,
                p.title,
                p.content AS content_snippet,
                p.created_at,
                p.updated_at,
                p.author_org_id,
                o.name AS company_name,
                o.logo_url,
                c.community_id,
                c.name AS channel_name,
                (SELECT pm.url FROM post_media pm WHERE pm.post_id = p.post_id LIMIT 1) AS cover_image,
                COUNT(*) OVER() AS total_count
             FROM posts p
             JOIN organizations o ON p.author_org_id = o.org_id
             JOIN communities c ON c.org_id = o.org_id
             WHERE p.post_type = 'article'
               AND p.status = 'published'
               AND p.is_active = TRUE
               AND c.is_active = TRUE
               AND o.is_deleted = FALSE
               AND (
                   p.title ILIKE $1
                   OR p.content ILIKE $1
               )
             ORDER BY p.created_at DESC
             LIMIT $2 OFFSET $3`,
            [`%${search}%`, limit, offset]
        );

        const extractExcerpt = (content, maxLen = 140) => {
            if (!content) return '';
            const textOnly = content.replace(/<[^>]*>?/gm, ' ').replace(/&nbsp;/g, ' ').replace(/&[a-z]+;/gi, '');
            const cleaned = textOnly.replace(/[#*`~>_]/g, '').replace(/\s+/g, ' ').trim();
            return cleaned.length <= maxLen ? cleaned : cleaned.substring(0, maxLen) + '...';
        };

        const mappedRows = result.rows.map(row => ({
            id: row.post_id,
            title: row.title,
            excerpt: extractExcerpt(row.content_snippet),
            coverImage: row.cover_image || null,
            publishedAt: row.created_at,
            updatedAt: row.updated_at,
            channelId: row.community_id,
            channelName: row.channel_name,
            orgId: row.author_org_id,
            companyName: row.company_name,
            logoUrl: row.logo_url,
        }));

        const totalCount = result.rows.length > 0 ? parseInt(result.rows[0].total_count, 10) : 0;

        return res.status(200).json({
            success: true,
            data: mappedRows,
            total: totalCount,
            page,
            limit
        });
    } catch (err) {
        console.error("[CommunityController] searchArticles error:", err);
        return next(err);
    }
};
