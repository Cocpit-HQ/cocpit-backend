const pool = require("../../core/db/pool");
const AppError = require("../../core/errors/AppError");
const redisClient = require("../../core/db/redis");

// --- GROUP 1: Community Creation (Company Side) ---

// 1. Get Community status (Check if community exists for organization)
exports.getCommunityStatus = async (req, res, next) => {
    const { orgId } = req.params;
    try {
        const result = await pool.query(
            `SELECT community_id, name, description, banner_url,
                    (SELECT COUNT(*) FROM community_subscriptions WHERE community_id = communities.community_id AND status = 'SUBSCRIBED')::int AS subscriber_count
             FROM communities 
             WHERE org_id = $1 AND is_active = TRUE`,
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
                orgId: orgId
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
            `SELECT c.community_id, c.name, c.description, c.banner_url, c.org_id,
                    o.name AS company_name, o.slug AS company_slug, o.logo_url,
                    (SELECT COUNT(*) FROM community_subscriptions WHERE community_id = c.community_id AND status = 'SUBSCRIBED')::int AS subscriber_count
             FROM community_subscriptions cs
             JOIN communities c ON cs.community_id = c.community_id
             JOIN organizations o ON c.org_id = o.org_id
             WHERE cs.user_id = $1 AND cs.status = 'SUBSCRIBED' 
               AND c.is_active = TRUE AND o.is_deleted = FALSE`,
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
            subscriberCount: row.subscriber_count
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
    const page = Math.max(1, parseInt(req.query.page || "1"));
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || "10")));
    const offset = (page - 1) * limit;
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

        const result = await pool.query(
            `SELECT p.post_id, p.author_org_id, p.title, p.content, p.status, p.created_at, p.updated_at,
                    (SELECT pm.url FROM post_media pm WHERE pm.post_id = p.post_id LIMIT 1) AS banner_url
             FROM posts p
             WHERE p.author_org_id = $1
               AND p.post_type = 'article'
               AND p.is_active = TRUE
               AND p.status = $2
             ORDER BY p.created_at DESC
             LIMIT $3 OFFSET $4`,
            [orgId, requestedStatus, limit, offset]
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

        return res.status(200).json({
            success: true,
            data: mappedRows,
            page,
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
                SELECT DISTINCT u.user_id, u.full_name AS name, u.avatar_url AS avatar, u.headline,
                       EXISTS(
                           SELECT 1 FROM community_invitations ci
                           JOIN communities comm ON ci.community_id = comm.community_id
                           WHERE ci.invitee_id = u.user_id 
                             AND comm.org_id = $1 
                             AND ci.status = 'PENDING'
                             AND ci.is_active = TRUE
                       ) AS is_invited
                FROM active_users u
                WHERE u.full_name ILIKE $2 AND u.user_id != $3
                LIMIT $4 OFFSET $5
            `;
            params = [orgId, `%${search}%`, userId, limit, offset];
        } else {
            // Suggest default: Recruiter's connections and company followers
            query = `
                WITH candidates AS (
                    SELECT u.user_id, u.full_name AS name, u.avatar_url AS avatar, u.headline
                    FROM connections c
                    JOIN active_users u ON c.connected_user_id = u.user_id
                    WHERE c.user_id = $1
                    UNION
                    SELECT u.user_id, u.full_name AS name, u.avatar_url AS avatar, u.headline
                    FROM organization_followers ofol
                    JOIN active_users u ON ofol.user_id = u.user_id
                    WHERE ofol.org_id = $2
                )
                SELECT c.user_id, c.name, c.avatar, c.headline,
                       EXISTS(
                           SELECT 1 FROM community_invitations ci
                           JOIN communities comm ON ci.community_id = comm.community_id
                           WHERE ci.invitee_id = c.user_id 
                             AND comm.org_id = $2
                             AND ci.status = 'PENDING'
                             AND ci.is_active = TRUE
                       ) AS is_invited
                FROM candidates c
                WHERE c.user_id != $1
                LIMIT $3 OFFSET $4
            `;
            params = [userId, orgId, limit, offset];
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

        // Fetch company name
        const orgRes = await client.query(
            `SELECT name, logo_url FROM organizations WHERE org_id = $1`,
            [orgId]
        );
        const companyName = orgRes.rows[0]?.name || "Organization";
        const companyLogo = orgRes.rows[0]?.logo_url;

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
        const notificationText = `You have been invited to join the ${companyName} community`;
        const meta = {
            org_id: orgId,
            invite_id: inviteId
        };
        await client.query(
            `INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [invitee_id, inviterId, "community_invite", notificationText, inviteId, JSON.stringify(meta)]
        );

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
               AND ci.status = 'PENDING' 
               AND ci.is_active = TRUE 
               AND c.is_active = TRUE`,
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
            `SELECT ci.community_id, ci.invitee_id, ci.inviter_id, c.org_id 
             FROM community_invitations ci
             JOIN communities c ON ci.community_id = c.community_id
             WHERE ci.invite_id = $1 AND ci.status = 'PENDING' AND ci.is_active = TRUE`,
            [inviteId]
        );

        if (inviteRes.rowCount === 0) {
            throw new AppError("Invitation not found or already processed", 404);
        }

        const { invitee_id, inviter_id, org_id } = inviteRes.rows[0];

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

        // Subscribe candidate to community
        await client.query(
            `INSERT INTO community_subscriptions (user_id, community_id, status)
             VALUES ($1, $2, 'SUBSCRIBED')
             ON CONFLICT (user_id, community_id)
             DO UPDATE SET status = 'SUBSCRIBED', updated_at = NOW()`,
            [userId, community_id]
        );

        // Fetch candidate details
        const inviteeNameRes = await client.query(
            `SELECT full_name, avatar_url FROM users WHERE user_id = $1`,
            [userId]
        );
        const inviteeName = inviteeNameRes.rows[0]?.full_name || "A candidate";
        const inviteeAvatar = inviteeNameRes.rows[0]?.avatar_url;

        // Insert notification record for the inviter recruiter
        const notificationText = `${inviteeName} accepted your invitation to join the community`;
        const meta = {
            org_id: org_id,
            invite_id: inviteId
        };
        await client.query(
            `INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata, recipient_org_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [inviter_id, userId, "community_invite_accepted", notificationText, inviteId, JSON.stringify(meta), org_id]
        );

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
                        ), FALSE
                    ) AS is_subscribed
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
            isSubscribed: row.is_subscribed
        }));

        return res.status(200).json({
            success: true,
            data: mappedRows,
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

        const result = await pool.query(
            `SELECT DATE_TRUNC('day', cs.updated_at) AS date, COUNT(*)::int AS subscribers
             FROM community_subscriptions cs
             JOIN communities c ON cs.community_id = c.community_id
             WHERE c.org_id = $1 AND cs.status = 'SUBSCRIBED'
             GROUP BY DATE_TRUNC('day', cs.updated_at)
             ORDER BY DATE_TRUNC('day', cs.updated_at) ASC`,
            [orgId]
        );

        // Map date to string formatted like "Jan 1" or YYYY-MM-DD
        const mapped = result.rows.map(row => {
            const d = new Date(row.date);
            const formattedDate = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            return {
                date: formattedDate,
                subscribers: row.subscribers
            };
        });

        return res.status(200).json({
            success: true,
            data: mapped
        });
    } catch (err) {
        console.error("[CommunityController] getSubscriberGrowth error:", err);
        return next(err);
    }
};
