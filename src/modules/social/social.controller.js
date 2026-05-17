const { stat } = require("node:fs");
const pool = require("../../core/db/pool");
const redisClient = require("../../core/db/redis"); // Added for cache invalidation
const { connected } = require("node:process");
const { formatDistanceToNow } = require('date-fns');
const socketService = require("../../core/infrastructure/socket.service");
const { checkRateLimit } = require("../../core/utils/sessionRateLimiter");
const { hasActorPermission } = require("../../core/middlewares/actor-context.middleware");
const { markConversationAsRead } = require("../../services/conversationRead.service");

// Helper function for timeAgo
const timeAgo = (date) => {
    const seconds = Math.floor((new Date() - new Date(date)) / 1000);
    let interval = seconds / 31536000;
    if (interval > 1) return Math.floor(interval) + "y";
    interval = seconds / 2592000;
    if (interval > 1) return Math.floor(interval) + "mo";
    interval = seconds / 86400;
    if (interval > 1) return Math.floor(interval) + "d";
    interval = seconds / 3600;
    if (interval > 1) return Math.floor(interval) + "h";
    interval = seconds / 60;
    if (interval > 1) return Math.floor(interval) + "m";
    return Math.floor(seconds) + "s";
};

const getRequestedOrganizationActorId = (req, fallbackOrgId = null) => {
    const actorOrgId = req.actor?.type === "ORGANIZATION" ? req.actor.orgId : null;

    if (actorOrgId && fallbackOrgId && actorOrgId !== fallbackOrgId) {
        const err = new Error("Active organization actor does not match requested organization");
        err.statusCode = 403;
        throw err;
    }

    return actorOrgId;
};

const getSocialActorScope = (req, fallbackOrgId = null) => {
    const userId = req.user?.sub || req.user?.user_id;
    const orgId = getRequestedOrganizationActorId(req, fallbackOrgId);

    return {
        userId,
        orgId,
        isOrgActor: !!orgId,
    };
};

const getRouteOrganizationId = (req) => req.params.companyId || req.params.orgId || null;

const assertSocialActorPermission = (req, permission) => {
    if (req.actor?.type !== "ORGANIZATION") {
        return;
    }

    if (!hasActorPermission(req.actor.permissions || [], permission)) {
        const err = new Error(`You do not have permission: ${permission}`);
        err.statusCode = 403;
        throw err;
    }
};

const getOrganizationConnectionActorScope = (req) => {
    const orgId = getRouteOrganizationId(req);
    const actorScope = getSocialActorScope(req, orgId);

    return {
        ...actorScope,
        companyId: actorScope.orgId || orgId,
    };
};

// Follow another user
exports.followUser = async (req, res) => {
    const followerId = req.user.sub;
    const followingId = req.params.id; // The person I am trying to follow

    if (followerId === followingId)
        return res.status(400).json({ message: "Cannot follow yourself" });

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Insert Follow
        const followResult = await client.query(
            `INSERT INTO followers (follower_id, following_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING *`,
            [followerId, followingId]
        );

        if (followResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(200).json({ message: "Already following" });
        }

        // 2. Check for Reverse Follow (Is followingId already following followerId?)
        const reverseFollow = await client.query(
            "SELECT 1 FROM followers WHERE follower_id = $1 AND following_id = $2",
            [followingId, followerId]
        );

        let isConnected = false;

        if (reverseFollow.rowCount > 0) {
            // MUTUAL FOLLOW DETECTED -> CREATE CONNECTION
            isConnected = true;
            await client.query(
                "INSERT INTO connections (user_id, connected_user_id) VALUES ($1, $2), ($2, $1) ON CONFLICT DO NOTHING",
                [followerId, followingId]
            );

            // Mark any pending requests as connected (preserve for history)
            await client.query(
                "UPDATE connection_requests SET status = 'connected', responded_at = NOW(), updated_at = NOW() WHERE ((sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1)) AND status = 'pending'",
                [followerId, followingId]
            );
        }

        // 3. Notifications & Socket Events
        const followerRes = await client.query(
            `SELECT full_name, avatar_url FROM users WHERE user_id = $1`,
            [followerId]
        );
        const follower = followerRes.rows[0];

        // Notification 1: "Started following you"
        const followNotifData = {
            type: "follow",
            text: `${follower.full_name} started following you`,
            from: followerId,
            senderName: follower.full_name,
            senderAvatar: follower.avatar_url,
            referenceId: followerId,
            time: "Just now"
        };

        // Persist Follow Notification
        const followNotifRes = await client.query(
            `INSERT INTO notifications (user_id, sender_id, type, text, reference_id) 
             VALUES ($1, $2, $3, $4, $5) RETURNING notification_id, created_at`,
            [followingId, followerId, "follow", followNotifData.text, followerId]
        );

        // Emit Follow Notification
        socketService.notifyUser(followingId, "notification", {
            ...followNotifData,
            notification_id: followNotifRes.rows[0].notification_id,
            created_at: followNotifRes.rows[0].created_at.toISOString()
        });

        // Logic for Connection Notification (if mutual)
        if (isConnected) {
            const connectionNotifData = {
                type: "connection_accepted", // Reusing this type for "New Connection" UI treatment
                text: `${follower.full_name} and you are now connected!`,
                from: followerId,
                senderName: follower.full_name,
                senderAvatar: follower.avatar_url,
                referenceId: followerId,
                time: "Just now"
            };

            const connNotifRes = await client.query(
                `INSERT INTO notifications (user_id, sender_id, type, text, reference_id) 
                  VALUES ($1, $2, $3, $4, $5) RETURNING notification_id, created_at`,
                [followingId, followerId, "connection_accepted", connectionNotifData.text, followerId]
            );

            socketService.notifyUser(followingId, "notification", {
                ...connectionNotifData,
                notification_id: connNotifRes.rows[0].notification_id,
                created_at: connNotifRes.rows[0].created_at.toISOString()
            });

            // Update Relationships
            socketService.notifyUser(followerId, "relationshipUpdated", { userId: followingId, status: 'connected' });
            socketService.notifyUser(followingId, "relationshipUpdated", { userId: followerId, status: 'connected' });
        }

        await client.query('COMMIT');
        res.status(200).json({ message: isConnected ? "You are now connected!" : "Followed successfully", connected: isConnected });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Follow user error:", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

// Unfollow a user
exports.unfollowUser = async (req, res) => {
    const followerId = req.user.sub;
    const followingId = req.params.id;

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const result = await client.query(
            `DELETE FROM followers WHERE follower_id = $1 AND following_id = $2 RETURNING *`,
            [followerId, followingId]
        );

        if (result.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: "You are not following this user" });
        }

        // If we were connected, break the connection
        // (Since connection strictly requires mutual follow)
        const deletedConnection = await client.query(
            `DELETE FROM connections WHERE (user_id = $1 AND connected_user_id = $2) OR (user_id = $2 AND connected_user_id = $1) RETURNING *`,
            [followerId, followingId]
        );

        if (deletedConnection.rowCount > 0) {
            // If connection was removed, we should probably update the socket status
            socketService.notifyUser(followerId, "relationshipUpdated", { userId: followingId, status: 'none' }); // or 'none' since I stopped following
            socketService.notifyUser(followingId, "relationshipUpdated", { userId: followerId, status: 'none' }); // They might still follow me, but 'connection' is gone.

            // Wait, if I unfollow, do they stop following me?
            // Logic: Connection removed. But their follow remains?
            // If I unfollow B, A->B is gone. B->A might remain.
            // If B->A remains, status for B is "Following". Status for A is "None" (ignoring B's follow for a moment, A is simply not following B).
            // Actually, if B follows A, A sees "Follow Back" (or similar).

            // Let's refine the socket status.
            // For A (Unfollower): I am not following B. B follows me. My status vs B? "Is Followed By".
            // For B (Victim): I am following A. A is not following me. Status vs A? "Following".

            // The frontend `getRelationshipStatus` handles this dynamically.
            // We just need to trigger the invalidation.
            // Check if B follows A?
            const reverseCheck = await client.query("SELECT 1 FROM followers WHERE follower_id = $1 AND following_id = $2", [followingId, followerId]);
            const bFollowsA = reverseCheck.rowCount > 0;

            // Actually, simple invalidation signal is best.
            // We already sent 'none' above, which forces a re-fetch usually or sets state.
            // Ideally we just tell them "Hey, relationship changed, refetch".
            // But existing frontend logic listens for { status } and might force that status.
            // If we send 'none', frontend sets status 'none'. 
            // Does 'none' imply "Is Followed By" is false?
            // In `ConnectionButton`, status 'none' just means "Connect" button shows up.
            // "Connect" button handles "Follow Back" logic?
            // `ConnectionButton` logic:
            // if status 'none': renders "Connect".
            // There isn't a "Follow Back" state in ConnectionButton explicitly, but there is "isFollowing" / "isFollowedBy" props.
            // Is `getRelationshipStatus` returning 'none' if I am followed by them?
            // Let's check `getRelationshipStatus` later. Assuming 'none' or simple trigger is safe.
        }

        await client.query('COMMIT');
        res.json({ message: "Unfollowed successfully", connectionRemoved: deletedConnection.rowCount > 0 });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Unfollow error:", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

// Remove a follower (Force stop someone from following me)
exports.removeFollower = async (req, res) => {
    const userId = req.user.sub;
    const followerId = req.params.followerId;

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Delete from followers where follower_id = target AND following_id = me
        const result = await client.query(
            `DELETE FROM followers WHERE follower_id = $1 AND following_id = $2 RETURNING *`,
            [followerId, userId]
        );

        if (result.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: "This user is not following you" });
        }

        // 2. If we were connected, break the connection
        const deletedConnection = await client.query(
            `DELETE FROM connections WHERE (user_id = $1 AND connected_user_id = $2) OR (user_id = $2 AND connected_user_id = $1) RETURNING *`,
            [followerId, userId]
        );

        // 3. Clean up any connection requests
        await client.query(
            `DELETE FROM connection_requests WHERE (sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1)`,
            [followerId, userId]
        );

        await client.query('COMMIT');

        // Socket notifications for UI update
        socketService.notifyUser(userId, "relationshipUpdated", { userId: followerId, status: 'none' });
        socketService.notifyUser(followerId, "relationshipUpdated", { userId: userId, status: 'none' });

        res.json({ success: true, message: "Follower removed successfully", connectionRemoved: deletedConnection.rowCount > 0 });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Remove follower error:", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

// Follow a company
exports.followCompany = async (req, res) => {
    const userId = req.user.sub;
    const companyId = req.params.companyId || req.params.orgId;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const result = await client.query(
            `INSERT INTO organization_followers (user_id, org_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING *`,
            [userId, companyId]
        );

        if (result.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(200).json({ message: "Already following" });
        }

        // Auto-create notification preferences (all categories ON by default)
        await client.query(
            `INSERT INTO organization_notification_preferences (user_id, org_id)
             VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [userId, companyId]
        );

        await client.query('COMMIT');

        // Invalidate Cache
        try {
            if (redisClient.isOpen) {
                await redisClient.del(`user:${userId}:following`);
                await redisClient.del(`company:${companyId}:followers`);
            }
        } catch (cacheErr) {
            console.warn("[FOLLOW_COMPANY] Cache invalidation failed:", cacheErr.message);
        }

        res.status(200).json({ message: "Followed successfully" });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Follow company error:", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

// Unfollow a company
exports.unfollowCompany = async (req, res) => {
    const userId = req.user.sub;
    const companyId = req.params.companyId || req.params.orgId;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Remove Follower record
        const followResult = await client.query(
            `DELETE FROM organization_followers WHERE user_id = $1 AND org_id = $2 RETURNING *`,
            [userId, companyId]
        );

        // 2. Remove Connection record
        const connResult = await client.query(
            `DELETE FROM organization_connections WHERE user_id = $1 AND org_id = $2`,
            [userId, companyId]
        );

        // 3. Clean up any Connection Requests (any status)
        const requestResult = await client.query(
            `DELETE FROM organization_connection_requests WHERE user_id = $1 AND org_id = $2`,
            [userId, companyId]
        );

        // 4. Remove notification preferences
        await client.query(
            `DELETE FROM organization_notification_preferences WHERE user_id = $1 AND org_id = $2`,
            [userId, companyId]
        );

        await client.query('COMMIT');

        console.log(`[unfollowCompany] Cleanup details for user=${userId}, company=${companyId}:`);
        console.log(` - organization_followers: ${followResult.rowCount} rows`);
        console.log(` - organization_connections: ${connResult.rowCount} rows`);
        console.log(` - organization_connection_requests: ${requestResult.rowCount} rows`);

        // --- ENHANCED LOGGING & NOTIFICATION ---
        console.log(`[UNFOLLOW] user=${userId} unfollowed/disconnected company=${companyId}`);

        // Notify the user who unfollowed
        socketService.notifyUser(userId, "relationshipUpdated", {
            userId: companyId, status: 'none', type: 'company'
        });

        // 1. Invalidate Redis Cache (Production Hotfix)
        try {
            if (redisClient.isOpen) {
                // Invalidate both user and company level caches if they exist
                await redisClient.del(`user:${userId}:following`);
                await redisClient.del(`company:${companyId}:followers`);
                await redisClient.del(`company:${companyId}:connections`);
                console.log(`[UNFOLLOW] Cache invalidated for user=${userId} and company=${companyId}`);
            }
        } catch (cacheErr) {
            console.warn("[UNFOLLOW] Cache invalidation failed:", cacheErr.message);
        }

        // 2. Notify ALL company admins/members so their UI updates
        try {
            const admins = await pool.query(
                `SELECT user_id FROM organization_members WHERE org_id = $1`,
                [companyId]
            );
            console.log(`[UNFOLLOW] Notifying ${admins.rowCount} company members`);
            for (const admin of admins.rows) {
                socketService.notifyUser(admin.user_id, "relationshipUpdated", {
                    userId: userId, status: 'none', type: 'company_connection'
                });
            }
        } catch (notifyErr) {
            console.error("[UNFOLLOW] Failed to notify admins:", notifyErr);
        }
        // ----------------------------------------

        res.json({ message: "Unfollowed successfully" });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Unfollow company error:", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

// Get company relationship status
exports.getCompanyRelationship = async (req, res) => {
    const userId = req.user.sub;
    const companyId = req.params.companyId || req.params.orgId;

    try {
        const result = await pool.query(
            `SELECT 
                (SELECT 1 FROM organization_followers WHERE user_id = $1 AND org_id = $2) as is_following,
                (SELECT COUNT(*) FROM organization_followers WHERE org_id = $2) as follower_count`,
            [userId, companyId]
        );

        res.json({
            isFollowing: !!result.rows[0]?.is_following,
            followerCount: parseInt(result.rows[0]?.follower_count || 0)
        });
    } catch (err) {
        console.error("Get company relationship error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

// Get company followers list
exports.getCompanyFollowers = async (req, res) => {
    const companyId = req.params.companyId || req.params.orgId;
    const { search } = req.query;

    try {
        let query = `
            SELECT u.user_id, u.full_name, u.headline, u.avatar_url, cf.created_at as followed_at
            FROM organization_followers cf
            JOIN users u ON cf.user_id = u.user_id
            WHERE cf.org_id = $1
        `;
        const params = [companyId];

        if (search && search.trim()) {
            query += ` AND (u.full_name ILIKE $2 OR u.headline ILIKE $2)`;
            params.push(`%${search.trim()}%`);
        }

        query += ` ORDER BY cf.created_at DESC`;

        const result = await pool.query(query, params);

        res.json(result.rows);
    } catch (err) {
        console.error("Get company followers error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

// Remove a follower from a company (admin action)
exports.removeCompanyFollower = async (req, res) => {
    const { followerId } = req.params;
    const companyId = req.params.companyId || req.params.orgId;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Remove Follower record
        await client.query(
            `DELETE FROM organization_followers WHERE user_id = $1 AND org_id = $2`,
            [followerId, companyId]
        );

        // 2. Also remove company connection if it exists
        await client.query(
            `DELETE FROM organization_connections WHERE user_id = $1 AND org_id = $2`,
            [followerId, companyId]
        );

        // 3. Clean up stale connection requests
        await client.query(
            `DELETE FROM organization_connection_requests WHERE user_id = $1 AND org_id = $2`,
            [followerId, companyId]
        );

        await client.query('COMMIT');

        // --- ENHANCED CACHE INVALIDATION ---
        try {
            if (redisClient.isOpen) {
                await redisClient.del(`user:${followerId}:following`);
                await redisClient.del(`company:${companyId}:followers`);
                await redisClient.del(`company:${companyId}:connections`);
                console.log(`[REMOVE_FOLLOWER] Cache invalidated for follower=${followerId} and company=${companyId}`);
            }
        } catch (cacheErr) {
            console.warn("[REMOVE_FOLLOWER] Cache invalidation failed:", cacheErr.message);
        }

        // Notify the removed user about relationship change
        socketService.notifyUser(followerId, "relationshipUpdated", {
            userId: companyId, status: 'none', type: 'company'
        });

        res.json({ success: true, message: "Follower removed" });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Remove company follower error:", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

exports.getFollowers = async (req, res) => {
    const userId = req.params.id;
    const requesterId = req.user.sub;
    const { search } = req.query;

    try {
        let query = `
            SELECT u.user_id, u.full_name, u.avatar_url, u.headline, f.created_at, 'user' as type,
                   (EXISTS (SELECT 1 FROM followers WHERE follower_id = $2 AND following_id = u.user_id)) as is_following_back
            FROM followers f 
            JOIN users u ON f.follower_id = u.user_id 
            WHERE f.following_id = $1
        `;
        const params = [userId, requesterId];

        if (search) {
            query += ` AND (u.full_name ILIKE $3 OR u.headline ILIKE $3)`;
            params.push(`%${search}%`);
        }

        // Always exclude blocked users from the viewer's perspective
        query += ` 
            AND NOT EXISTS (
                SELECT 1 FROM blocks b 
                WHERE (b.blocker_id = $2 AND b.blocked_id = u.user_id)
                   OR (b.blocker_id = u.user_id AND b.blocked_id = $2)
            )
        `;

        query += ` ORDER BY f.created_at DESC`;

        const result = await pool.query(query, params);

        const formattedConnections = result.rows.map(row => {
            const timeAgoVal = formatDistanceToNow(new Date(row.created_at), {
                addSuffix: true
            }).replace(/^about\s+/i, '');

            return {
                ...row,
                timeAgo: `connected ${timeAgoVal}`
            };
        });

        res.json(formattedConnections);
    } catch (err) {
        console.error("Get followers error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
}

exports.getFollowing = async (req, res) => {
    const userId = req.params.id;
    const { search } = req.query;

    try {
        // Build UNION query: users the person follows + companies the person follows
        let userQuery = `
            SELECT u.user_id, u.full_name, u.avatar_url, u.headline, f.created_at, 'user' as type, NULL as slug
            FROM followers f
            JOIN users u ON f.following_id = u.user_id
            WHERE f.follower_id = $1
        `;

        let companyQuery = `
            SELECT c.org_id as user_id, c.name as full_name, c.logo_url as avatar_url, c.industry as headline, cf.created_at, 'company' as type, c.slug
            FROM organization_followers cf
            JOIN organizations c ON cf.org_id = c.org_id
            WHERE cf.user_id = $1
              AND c.is_deleted = FALSE
        `;

        const params = [userId];

        if (search) {
            userQuery += ` AND (u.full_name ILIKE $2 OR u.headline ILIKE $2)`;
            companyQuery += ` AND (c.name ILIKE $2 OR c.industry ILIKE $2)`;
            params.push(`%${search}%`);
        }

        const viewerId = req.user.sub;
        const queryParams = [...params, viewerId];
        const viewerIdx = queryParams.length;

        // Apply block filtering to user follows
        userQuery += `
            AND NOT EXISTS (
                SELECT 1 FROM blocks b 
                WHERE (b.blocker_id = $${viewerIdx} AND b.blocked_id = u.user_id)
                   OR (b.blocker_id = u.user_id AND b.blocked_id = $${viewerIdx})
            )
        `;

        const fullQuery = `(${userQuery}) UNION ALL (${companyQuery}) ORDER BY created_at DESC`;

        const result = await pool.query(fullQuery, queryParams);

        const formattedConnections = result.rows.map(row => {
            const timeAgoVal = formatDistanceToNow(new Date(row.created_at), {
                addSuffix: true
            }).replace(/^about\s+/i, '');

            return {
                ...row,
                timeAgo: `followed ${timeAgoVal}`
            };
        });

        res.json(formattedConnections);
    } catch (err) {
        console.error("Get following error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
}

exports.getFollowersCount = async (req, res) => {
    const userId = req.params.id;

    try {
        const result = await pool.query(
            `SELECT COUNT(*) FROM followers WHERE following_id = $1`,
            [userId]
        );
        res.json({ followers_count: result.rows[0].count });
    }
    catch (err) {
        res.status(500).json({ message: "Internal server error" });
    }

};

//    CONNECTIONS (Two-way)
exports.sendConnectionRequest = async (req, res) => {
    const senderId = req.user.sub;
    const receiverId = req.params.id;
    const { message } = req.body;

    if (!receiverId) {
        return res.status(400).json({ message: "Invalid request" });
    }

    if (senderId === receiverId) {
        return res.status(400).json({ message: "You cannot connect with yourself" });
    }

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        // 1. Check if already connected (IDEMPOTENCY: If connected, return success/message)
        const alreadyConnected = await client.query(
            "SELECT 1 FROM connections WHERE user_id = $1 AND connected_user_id = $2",
            [senderId, receiverId]
        );

        if (alreadyConnected.rowCount > 0) {
            await client.query("ROLLBACK");
            return res.status(200).json({ message: "You are already connected", connected: true });
        }

        // 2. Check for ANY pending request between the two users (Bidirectional)
        const pendingRequest = await client.query(
            "SELECT request_id, sender_id, status FROM connection_requests WHERE ((sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1)) AND status = 'pending'",
            [senderId, receiverId]
        );

        if (pendingRequest.rowCount > 0) {
            const req = pendingRequest.rows[0];
            if (req.sender_id === senderId) {
                await client.query("ROLLBACK");
                return res.status(200).json({ message: "Connection request already sent", status: 'pending' });
            } else {
                // AUTO-ACCEPT SCENARIO: There is a pending request FROM the receiver TO me.
                // We treat this as an accept.
                const reverseReqId = req.request_id;

                // Create mutual connections
                await client.query(
                    `INSERT INTO connections (user_id, connected_user_id) VALUES ($1, $2), ($2, $1) ON CONFLICT DO NOTHING`,
                    [senderId, receiverId]
                );

                // Create mutual follows
                await client.query(
                    `INSERT INTO followers (follower_id, following_id) VALUES ($1, $2), ($2, $1) ON CONFLICT DO NOTHING`,
                    [senderId, receiverId]
                );

                // Mark the reverse request as connected (preserve for history)
                await client.query("UPDATE connection_requests SET status = 'connected', responded_at = NOW(), updated_at = NOW() WHERE request_id = $1", [reverseReqId]);

                await client.query("COMMIT");

                // Notify the original sender (receiverId) that I accepted via this "send" action
                const myProfileRes = await client.query(`SELECT full_name, avatar_url FROM users WHERE user_id = $1`, [senderId]);
                const myProfile = myProfileRes.rows[0];

                const notificationData = {
                    type: "connection_accepted",
                    text: `accepted your connection request`,
                    from: senderId,
                    senderName: myProfile.full_name,
                    senderAvatar: myProfile.avatar_url,
                    referenceId: senderId,
                    time: "Just now"
                };
                socketService.notifyUser(receiverId, "notification", notificationData);

                await pool.query( // Using pool for non-transactional notification insert if slightly delayed is ok, or reuse client if strict
                    `INSERT INTO notifications (user_id, sender_id, type, text, reference_id) 
                     VALUES ($1, $2, 'connection_accepted', 'accepted your connection request', $3)`,
                    [receiverId, senderId, senderId]
                );


                return res.status(200).json({ message: "You are now connected!", connected: true });
            }
        }

        // 3. Check for Cooldowns or Blocks on REJECTED/BLOCKED requests
        // We need to check if *I* am blocked or if *I* am in a cooldown to send to *THEM*
        // The constraint is: if I sent a request and they rejected it, I have a cooldown.
        // Or if they blocked me.
        const blockOrCooldown = await client.query(
            `SELECT status, cooldown_until FROM connection_requests 
             WHERE sender_id = $1 AND receiver_id = $2 
             AND (status = 'blocked' OR (status = 'rejected' AND cooldown_until > NOW()))`,
            [senderId, receiverId]
        );

        if (blockOrCooldown.rowCount > 0) {
            const row = blockOrCooldown.rows[0];
            await client.query("ROLLBACK");
            if (row.status === 'blocked') {
                return res.status(403).json({ message: "You cannot connect with this user." });
            } else {
                const now = new Date();
                const cooldown = new Date(row.cooldown_until);
                const diffHours = Math.ceil((cooldown - now) / (1000 * 60 * 60));
                return res.status(403).json({ message: `You cannot send a new request yet. Please wait ${diffHours} hours.` });
            }
        }

        // 4. Rate Limiting (Max 20 requests per 24h)
        const rateLimitCheck = await client.query(
            `SELECT COUNT(*) FROM connection_requests 
             WHERE sender_id = $1 AND created_at > NOW() - INTERVAL '24 hours'`,
            [senderId]
        );

        if (parseInt(rateLimitCheck.rows[0].count) >= 20) {
            await client.query("ROLLBACK");
            return res.status(429).json({ message: "Daily connection request limit reached. Please try again tomorrow." });
        }


        // 5. Clean up any stale 'connected' or expired 'rejected' rows from previous cycles
        // These rows block the INSERT below due to the UNIQUE constraint on (sender_id, receiver_id)
        await client.query(
            `DELETE FROM connection_requests 
             WHERE ((sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1))
             AND (status = 'connected' OR (status = 'rejected' AND (cooldown_until IS NULL OR cooldown_until <= NOW())))`,
            [senderId, receiverId]
        );

        // 6. Create New Request
        // We use ON CONFLICT DO NOTHING to be super safe against race conditions on the unique index
        const insertRes = await client.query(
            `INSERT INTO connection_requests (sender_id, receiver_id, message, status) 
             VALUES ($1, $2, $3, 'pending')
             ON CONFLICT (sender_id, receiver_id) 
             DO NOTHING
             RETURNING request_id`,
            [senderId, receiverId, message || null]
        );

        if (insertRes.rowCount === 0) {
            // Race condition hit: Accessing confirmed pending request or connection
            await client.query("ROLLBACK");
            return res.status(200).json({ message: "Request already processing or sent", status: 'pending' });
        }

        const newRequestId = insertRes.rows[0].request_id;

        // Get sender details for notification
        const senderRes = await client.query(
            `SELECT full_name, avatar_url FROM users WHERE user_id = $1`,
            [senderId]
        );
        const sender = senderRes.rows[0];

        const notificationData = {
            type: "connection_request",
            text: `${sender.full_name} sent you a connection request`,
            from: senderId,
            senderName: sender.full_name,
            senderAvatar: sender.avatar_url,
            referenceId: senderId,
            time: "Just now",
            requestId: newRequestId // Helpful for frontend actions
        };

        // Persist notification
        const notifRes = await client.query(
            `INSERT INTO notifications (user_id, sender_id, type, text, reference_id) 
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [receiverId, senderId, "connection_request", notificationData.text, senderId]
        );
        const newNotification = notifRes.rows[0];

        await client.query("COMMIT");

        // Notify receiver via socket with FULL notification object (including ID)
        // Combine DB result with extra frontend-friendly fields if needed
        const completeNotification = {
            ...notificationData,
            notification_id: newNotification.notification_id,
            created_at: newNotification.created_at.toISOString(),
            is_read: false,
            // Ensure frontend keys exist
            actor_name: sender.full_name,
            actor_avatar: sender.avatar_url,
            text: newNotification.text,
            type: newNotification.type,
            reference_id: newNotification.reference_id
        };

        socketService.notifyUser(receiverId, "notification", completeNotification);
        // Also emit a specific event for the request itself if needed
        socketService.notifyUser(receiverId, "connectionRequestReceived", {
            requestId: newRequestId,
            sender: {
                id: senderId,
                name: sender.full_name,
                avatar: sender.avatar_url
            }
        });

        // Emit relationship update to receiver (they now have a pending request from me)
        socketService.notifyUser(receiverId, "relationshipUpdated", { userId: senderId, status: 'pending_received' });
        // Emit relationship update to sender (I now have a pending sent request to them)
        socketService.notifyUser(senderId, "relationshipUpdated", { userId: receiverId, status: 'pending_sent' });

        return res.status(201).json({ message: "Connection request sent", relationship: "pending_sent" });

    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Send connection error:", err);
        return res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

exports.getPendingRequests = async (req, res) => {
    const receiver_id = req.user.sub;

    try {
        const result = await pool.query(
            `
      (SELECT 
        cr.request_id as id,
        cr.sender_id,
        cr.receiver_id,
        cr.created_at,
        u.full_name as name,
        u.avatar_url as avatar,
        u.headline,
        false as is_company_request,
        NULL as slug
      FROM connection_requests cr
      JOIN users u ON cr.sender_id = u.user_id
      WHERE cr.receiver_id = $1
        AND cr.status = 'pending')
      UNION ALL
      (SELECT
        ccr.request_id as id,
        ccr.org_id as sender_id,
        ccr.user_id as receiver_id,
        ccr.created_at,
        c.name as name,
        c.logo_url as avatar,
        c.industry as headline,
        true as is_company_request,
        c.slug
      FROM organization_connection_requests ccr
      JOIN organizations c ON ccr.org_id = c.org_id
      WHERE ccr.user_id = $1
        AND ccr.status = 'pending')
      ORDER BY created_at DESC
      `,
            [receiver_id]
        );

        // Map to expected frontend structure
        const requests = result.rows.map(row => ({
            id: row.id,
            sender_id: row.sender_id,
            receiver_id: row.receiver_id,
            created_at: row.created_at,
            status: 'pending',
            isCompanyRequest: row.is_company_request,
            sender: {
                name: row.name,
                avatar: row.avatar,
                headline: row.headline,
                slug: row.slug || null
            }
        }));

        return res.status(200).json(requests);

    } catch (err) {
        console.error("Get pending requests error:", err);
        return res.status(500).json({ message: "Internal server error" });
    }
};

exports.getConnectionRequestHistory = async (req, res) => {
    const userId = req.user.sub;

    try {
        const result = await pool.query(
            `
            -- User-to-User connection requests
            SELECT 
                cr.request_id as id,
                cr.sender_id,
                cr.receiver_id,
                cr.status::TEXT as status,
                cr.updated_at,
                CASE WHEN cr.sender_id = $1 THEN u_recv.full_name ELSE u_send.full_name END as name,
                CASE WHEN cr.sender_id = $1 THEN u_recv.avatar_url ELSE u_send.avatar_url END as avatar,
                CASE WHEN cr.sender_id = $1 THEN u_recv.headline ELSE u_send.headline END as headline,
                CASE WHEN cr.sender_id = $1 THEN 'outgoing' ELSE 'incoming' END as direction,
                'user' as type,
                NULL as company_slug
            FROM connection_requests cr
            LEFT JOIN users u_send ON cr.sender_id = u_send.user_id
            LEFT JOIN users u_recv ON cr.receiver_id = u_recv.user_id
            WHERE (cr.receiver_id = $1 OR cr.sender_id = $1)
            AND cr.status IN ('connected', 'rejected')

            UNION ALL

            -- Company-to-User connection requests
            SELECT
                ccr.request_id as id,
                ccr.initiated_by as sender_id,
                ccr.user_id as receiver_id,
                ccr.status::TEXT as status,
                ccr.updated_at,
                c.name as name,
                c.logo_url as avatar,
                c.industry as headline,
                CASE WHEN ccr.user_id = $1 THEN 'incoming' ELSE 'outgoing' END as direction,
                'company' as type,
                c.slug as company_slug
            FROM organization_connection_requests ccr
            JOIN organizations c ON ccr.org_id = c.org_id
            WHERE (ccr.user_id = $1 OR ccr.initiated_by = $1)
            AND ccr.status IN ('accepted', 'rejected')

            ORDER BY updated_at DESC
            LIMIT 50
            `,
            [userId]
        );

        const history = result.rows.map(row => ({
            id: row.id,
            sender_id: row.sender_id,
            receiver_id: row.receiver_id,
            status: row.status === 'connected' || row.status === 'accepted' ? 'accepted' : row.status,
            updated_at: row.updated_at,
            direction: row.direction,
            type: row.type,
            otherUser: {
                name: row.name,
                avatar: row.avatar,
                headline: row.headline,
                slug: row.company_slug
            }
        }));

        return res.status(200).json(history);
    } catch (err) {
        console.error("Get request history error:", err);
        return res.status(500).json({ message: "Internal server error" });
    }
};

exports.handleConnectionRequest = async (req, res) => {
    const requestId = req.params.requestId;
    const { status } = req.body; // 'connected', 'rejected', 'blocked'
    const userId = req.user.sub;

    if (!['connected', 'rejected', 'blocked'].includes(status)) {
        return res.status(400).json({ message: "Invalid status" });
    }

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        // Fetch request & authorize receiver
        const reqRes = await client.query(
            "SELECT sender_id, receiver_id, message, status FROM connection_requests WHERE request_id = $1",
            [requestId]
        );

        if (reqRes.rowCount === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ message: "Request not found" });
        }

        const { sender_id, receiver_id, status: currentStatus } = reqRes.rows[0];

        if (receiver_id !== userId) {
            await client.query("ROLLBACK");
            return res.status(403).json({ message: "Not authorized" });
        }

        // IDEMPOTENCY CHECK: If already handled, return appropriate response
        if (currentStatus !== 'pending') {
            await client.query("ROLLBACK");
            if (currentStatus === 'rejected') return res.status(200).json({ message: "Request already rejected", status: 'rejected' });
            if (currentStatus === 'blocked') return res.status(200).json({ message: "User blocked", status: 'blocked' });
            // If connected, the request row might be gone, but if it's there with a different status (unlikely given we delete on accept), consider it handled.
            return res.status(404).json({ message: "Request already handled" });
        }


        // 1. BLOCK
        if (status === 'blocked') {
            await client.query(
                "UPDATE connection_requests SET status = 'blocked', responded_at = NOW() WHERE request_id = $1",
                [requestId]
            );

            // Also remove any existing follows/connections just in case
            await client.query("DELETE FROM connections WHERE (user_id = $1 AND connected_user_id = $2) OR (user_id = $2 AND connected_user_id = $1)", [sender_id, receiver_id]);
            await client.query("DELETE FROM followers WHERE (follower_id = $1 AND following_id = $2) OR (follower_id = $2 AND following_id = $1)", [sender_id, receiver_id]);

            await client.query("COMMIT");
            return res.status(200).json({ message: "User blocked", connected: false });
        }

        // 2. REJECT
        if (status === 'rejected') {
            // Set cooldown for 24 hours (1 day)
            await client.query(
                `UPDATE connection_requests 
                 SET status = 'rejected', responded_at = NOW(), cooldown_until = NOW() + INTERVAL '24 hours' 
                 WHERE request_id = $1`,
                [requestId]
            );

            await client.query("COMMIT");
            return res.status(200).json({ message: "Connection request rejected", connected: false });
        }

        // 3. ACCEPT (Connected)
        if (status === 'connected') {
            // Create mutual connections
            await client.query(
                "INSERT INTO connections (user_id, connected_user_id) VALUES ($1, $2), ($2, $1) ON CONFLICT DO NOTHING",
                [sender_id, receiver_id]
            );

            // Create mutual follows
            await client.query(
                "INSERT INTO followers (follower_id, following_id) VALUES ($1, $2), ($2, $1) ON CONFLICT DO NOTHING",
                [sender_id, receiver_id]
            );

            // Update the request status to 'connected' — keeps history for the notifications tab
            await client.query(
                "UPDATE connection_requests SET status = 'connected', responded_at = NOW(), updated_at = NOW() WHERE request_id = $1",
                [requestId]
            );

            // Create Notification for Sender
            const senderNotification = {
                type: 'connection_accepted',
                text: 'accepted your connection request',
                from: receiver_id,
                senderName: req.user.full_name, // I am the one accepting
                senderAvatar: req.user.avatar_url,
                referenceId: receiver_id,
                time: "Just now"
            };

            await client.query(
                `INSERT INTO notifications (user_id, sender_id, type, text, reference_id) 
                 VALUES ($1, $2, 'connection_accepted', 'accepted your connection request', $3)`,
                [sender_id, receiver_id, receiver_id]
            );

            // Create Notification for Receiver (Optional log)
            await client.query(
                `INSERT INTO notifications (user_id, sender_id, type, text, reference_id) 
                 VALUES ($1, $2, 'new_connection', 'You are now connected with a new user', $3)`,
                [receiver_id, sender_id, sender_id]
            );

            await client.query("COMMIT");

            // Notify Sender via Socket
            socketService.notifyUser(sender_id, "notification", senderNotification);

            // Emit relationship update to both
            socketService.notifyUser(sender_id, "relationshipUpdated", { userId: receiver_id, status: 'connected' });
            socketService.notifyUser(receiver_id, "relationshipUpdated", { userId: sender_id, status: 'connected' });


            return res.status(200).json({ message: "Connection established", connected: true, relationship: "connected" });
        }

    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Handle connection error:", err);
        return res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

exports.cancelConnectionRequest = async (req, res) => {
    const requestId = req.params.requestId;
    const userId = req.user.sub;

    try {
        // Fetch request & ensure it is pending
        const reqRes = await pool.query(
            "SELECT sender_id, receiver_id FROM connection_requests WHERE request_id = $1 AND status = 'pending'",
            [requestId]
        );

        if (reqRes.rowCount === 0) {
            return res
                .status(404)
                .json({ message: "Pending connection request not found" });
        }

        // Only sender can cancel
        if (reqRes.rows[0].sender_id !== userId) {
            return res.status(403).json({ message: "Not authorized" });
        }

        // Delete request
        await pool.query(
            `
      DELETE FROM connection_requests
      WHERE request_id = $1
      `,
            [requestId]
        );

        return res.status(200).json({ message: "Connection request canceled" });

    } catch (err) {
        console.error("Cancel connection request error:", err);
        return res.status(500).json({ message: "Internal server error" });
    }
};



exports.getMyConnections = async (req, res) => {
    const userId = req.user.sub;
    const { search } = req.query;

    try {
        let userQuery = `
            SELECT u.user_id, u.full_name, u.avatar_url, u.headline, c.created_at, 'user' as type, NULL as slug
            FROM connections c 
            JOIN users u ON c.connected_user_id = u.user_id 
            WHERE c.user_id = $1
        `;

        let companyQuery = `
            SELECT c.org_id as user_id, c.name as full_name, c.logo_url as avatar_url, c.industry as headline, cc.created_at, 'company' as type, c.slug
            FROM organization_connections cc
            JOIN organizations c ON cc.org_id = c.org_id
            WHERE cc.user_id = $1
              AND c.is_deleted = FALSE
        `;

        const params = [userId];
        if (search) {
            userQuery += ` AND (u.full_name ILIKE $2 OR u.headline ILIKE $2)`;
            companyQuery += ` AND (c.name ILIKE $2 OR c.industry ILIKE $2)`;
            params.push(`%${search}%`);
        }

        // Apply block filtering to connections
        const viewerIdx = 1; // Always $1 for getMyConnections as we don't have a separate viewer param, but wait
        // In getMyConnections, userId is the current user.
        userQuery += `
            AND NOT EXISTS (
                SELECT 1 FROM blocks b 
                WHERE (b.blocker_id = $1 AND b.blocked_id = u.user_id)
                   OR (b.blocker_id = u.user_id AND b.blocked_id = $1)
            )
        `;

        const fullQuery = `(${userQuery}) UNION ALL (${companyQuery}) ORDER BY created_at DESC`;
        const result = await pool.query(fullQuery, params);

        const formattedConnections = result.rows.map(row => {
            const timeAgoVal = formatDistanceToNow(new Date(row.created_at), {
                addSuffix: true
            }).replace(/^about\s+/i, '');

            return {
                ...row,
                timeAgo: timeAgoVal
            };
        });

        res.json(formattedConnections);
    } catch (err) {
        console.error("Get my connections error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
}

exports.getConnectionCount = async (req, res) => {
    const userId = req.params.id;

    try {
        const result = await pool.query(
            `SELECT 
                (SELECT COUNT(*) FROM connections WHERE user_id = $1) + 
                (SELECT COUNT(*) FROM organization_connections WHERE user_id = $1) as count`,
            [userId]
        );
        res.json({ count: parseInt(result.rows[0].count) });
    } catch (err) {
        console.error("Get connection count error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

// Get all conversations of logged-in user
exports.getConversations = async (req, res) => {
    let actorScope;

    try {
        actorScope = getSocialActorScope(req, req.query.companyId || null);
    } catch (err) {
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }

    const { userId, orgId: companyId } = actorScope;

    try {
        const result = await pool.query(
            `
SELECT 
    c.*,
    -- Block Status
    CASE WHEN c.is_group THEN false ELSE EXISTS(SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = u.user_id) END as is_blocked_by_me,
    CASE WHEN c.is_group THEN false ELSE EXISTS(SELECT 1 FROM blocks WHERE blocker_id = u.user_id AND blocked_id = $1) END as is_blocked_by_other,

    -- Name logic: Use group name if group, else other participant's name (User or Company)
    CASE 
        WHEN c.is_group THEN COALESCE(c.conversation_name, 'Group Chat')
        -- WHEN EXISTS(SELECT 1 FROM blocks WHERE blocker_id = u.user_id AND blocked_id = $1) THEN 'User not found' -- Update for Company?
        WHEN comp.org_id IS NOT NULL THEN comp.name
        WHEN u.full_name IS NULL AND comp.org_id IS NULL THEN 'Deleted User'
        ELSE u.full_name 
    END AS other_user_name,
    
    -- Avatar logic
    CASE 
        WHEN c.is_group THEN c.group_avatar 
        -- WHEN EXISTS(SELECT 1 FROM blocks WHERE blocker_id = u.user_id AND blocked_id = $1) THEN NULL
        WHEN comp.org_id IS NOT NULL THEN comp.logo_url
        WHEN u.avatar_url IS NULL AND comp.org_id IS NULL THEN NULL
        ELSE u.avatar_url 
    END AS other_user_avatar,
    
    -- Other ID (User or Company)
    COALESCE(u.user_id, comp.org_id) AS other_user_id,
    u.headline AS other_user_headline,
    CASE WHEN comp.org_id IS NOT NULL THEN 'COMPANY' ELSE 'USER' END as other_user_type,
    COALESCE(comp.slug, u.account_name) AS other_user_slug,
    
    -- Identify the sender profile for the current view
    cp.is_active,
    
    -- Flag for deleted users
    CASE 
        WHEN c.is_group = FALSE AND u.user_id IS NULL AND comp.org_id IS NULL THEN true 
        ELSE false 
    END AS is_deleted_user,

    -- Get the most recent message dynamically
    m.message_id AS last_message_id,
    COALESCE(m.text_content, c.last_message) AS last_message_text,
    COALESCE(m.created_at, c.last_message_at, c.updated_at) AS last_message_at,
    m.replied_msg_id AS "replyMessageId",
    m.reply_message
FROM conversations c
JOIN (
    -- Aggregate participation: Ensure one row per conversation for this user
    -- and check if they have any active record
    SELECT conversation_id, user_id, org_id,
           EXISTS(SELECT 1 FROM conversation_participants cp_a 
                  WHERE cp_a.conversation_id = cp_main.conversation_id 
                  AND (
                      (cp_main.user_id IS NOT NULL AND cp_a.user_id = cp_main.user_id)
                      OR
                      (cp_main.org_id IS NOT NULL AND cp_a.org_id = cp_main.org_id)
                  )
                  AND cp_a.left_at IS NULL) as is_active
    FROM conversation_participants cp_main
    WHERE 
      -- Filter by User OR Company based on context
      ($2::uuid IS NOT NULL AND cp_main.org_id = $2)
      OR
      ($2::uuid IS NULL AND cp_main.user_id = $1)
    GROUP BY conversation_id, user_id, org_id -- added org_id
) cp ON c.conversation_id = cp.conversation_id
-- For 1-on-1, join the other participant (LATERAL + LIMIT 1 prevents fan-out duplicates).
LEFT JOIN LATERAL (
    SELECT cp_o.user_id, cp_o.org_id
    FROM conversation_participants cp_o
    WHERE cp_o.conversation_id = c.conversation_id
      AND c.is_group = FALSE
      AND (
          ($2::uuid IS NOT NULL AND (cp_o.org_id != $2 OR cp_o.org_id IS NULL))
          OR
          ($2::uuid IS NULL AND (cp_o.user_id != $1 OR cp_o.user_id IS NULL))
      )
    LIMIT 1
) cp_other ON c.is_group = FALSE
LEFT JOIN users u ON cp_other.user_id = u.user_id
LEFT JOIN organizations comp ON cp_other.org_id = comp.org_id -- JOIN organizations for Company participants

-- LATERAL JOIN to find the latest VISIBLE message across ANY period
LEFT JOIN LATERAL (
    SELECT 
        msg.message_id,
        CASE 
            WHEN msg.is_deleted_for_everyone THEN 'This message was deleted'
            WHEN msg.shared_post_id IS NOT NULL THEN 'Shared a post'
            WHEN msg.text_content IS NULL OR msg.text_content = '' THEN 'Attachment'
            ELSE msg.text_content
        END as text_content,
        msg.created_at,
        msg.replied_msg_id,
        CASE
            WHEN msg.replied_msg_id IS NOT NULL THEN
                (SELECT json_build_object(
                    'message_id', rm.message_id,
                    'text_content', rm.text_content,
                    'sender_name', COALESCE(rc.name, ru.full_name, 'Deleted User'),
                    'message_type', rm.message_type
                ) 
                FROM messages rm 
                LEFT JOIN users ru ON rm.sender_id = ru.user_id
                LEFT JOIN organizations rc ON rm.author_org_id = rc.org_id
                WHERE rm.message_id = msg.replied_msg_id)
            ELSE NULL
        END AS reply_message,
        COALESCE(
            (SELECT JSON_AGG(
                JSON_BUILD_OBJECT(
                    'user_id', mr.user_id,
                    'full_name', ru.full_name,
                    'avatar', ru.avatar_url,
                    'emoji', mr.emoji,
                    'created_at', mr.created_at,
                    'updated_at', mr.updated_at
                ) ORDER BY mr.updated_at DESC
            ) FILTER (WHERE mr.reaction_id IS NOT NULL AND mr.emoji IS NOT NULL AND mr.emoji != '')
            FROM message_reactions mr
            JOIN users ru ON ru.user_id = mr.user_id
            WHERE mr.message_id = msg.message_id),
            '[]'::json
        ) AS reactions
    FROM messages msg
    JOIN conversation_participants cp_msg ON cp_msg.conversation_id = msg.conversation_id 
    WHERE msg.conversation_id = c.conversation_id
    -- Permission/Visibility Check:
    AND (
        ($2::uuid IS NOT NULL AND cp_msg.org_id = $2)
        OR
        ($2::uuid IS NULL AND cp_msg.user_id = $1)
    )
    AND msg.created_at >= cp_msg.joined_at
    AND (cp_msg.left_at IS NULL OR msg.created_at <= cp_msg.left_at)
    -- Exclude messages deleted for me (User only currently)
    AND NOT EXISTS (
        SELECT 1 FROM message_delete md 
        WHERE md.message_id = msg.message_id 
        AND md.user_id = $1 -- Deletes are user-specific for now
    )
    ORDER BY msg.created_at DESC 
    LIMIT 1
) m ON true


-- Self-message guard: in company mode, exclude conversations where current user is also a direct participant
WHERE ($2::uuid IS NULL OR NOT EXISTS (
    SELECT 1 FROM conversation_participants cp_self_guard
    WHERE cp_self_guard.conversation_id = c.conversation_id
    AND cp_self_guard.user_id = $1
    AND cp_self_guard.left_at IS NULL
    AND c.is_group = FALSE
))
AND c.is_active = TRUE

ORDER BY COALESCE(m.created_at, c.last_message_at, c.updated_at) DESC NULLS LAST;
  `, [userId, companyId]
        );

        const unreadCountsResult = await pool.query(
            `  SELECT 
    m.conversation_id,
    COUNT(*)::int AS unread_count
  FROM messages m
  JOIN conversation_participants cp
    ON cp.conversation_id = m.conversation_id
  WHERE 
    (($2::uuid IS NOT NULL AND cp.org_id = $2) OR ($2::uuid IS NULL AND cp.user_id = $1))
    AND cp.left_at IS NULL
    AND (
        -- If I am Company, sender is NOT me (My Company)
        ($2::uuid IS NOT NULL AND (m.author_org_id != $2 OR m.author_org_id IS NULL))
        OR
        -- If I am User, sender is NOT me (User)
        ($2::uuid IS NULL AND (m.sender_id != $1 OR m.sender_id IS NULL))
    )
    AND m.created_at > cp.last_read_at
    AND m.created_at >= cp.joined_at
  GROUP BY m.conversation_id
  `, [userId, companyId]
        );

        const unreadMap = {};
        for (const row of unreadCountsResult.rows) {
            unreadMap[row.conversation_id] = row.unread_count;
        }


        const conversationsWithUnread = result.rows.map(c => ({
            ...c,
            is_requesting: c.is_requesting && (c.created_by === userId) ? false : c.is_requesting,
            timeAgo: timeAgo(c.updated_at),
            unread_count: unreadMap[c.conversation_id] || 0

        }));
        // console.log("conversationsWithUnread", conversationsWithUnread);

        res.json(conversationsWithUnread);

    } catch (err) {
        console.error("Get conversations error:", err);
        res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }
};

exports.deleteConversation = async (req, res) => {
    const conversationId = req.params.id;
    let actorScope;

    try {
        actorScope = getSocialActorScope(req, req.query.companyId || null);
    } catch (err) {
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }

    const { userId, orgId: companyId } = actorScope;

    try {
        // Delete conversation only if the requester is a participant
        const result = await pool.query(
            `DELETE FROM conversations 
             WHERE conversation_id = $1 
             AND EXISTS (
                 SELECT 1 FROM conversation_participants 
                 WHERE conversation_id = $1 
                 AND (
                     ($3::uuid IS NOT NULL AND org_id = $3)
                     OR ($3::uuid IS NULL AND user_id = $2)
                 )
             )
             RETURNING *`,
            [conversationId, userId, companyId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ message: "Conversation not found or access denied" });
        }

        res.status(200).json({ message: "Conversation deleted successfully", conversationId: conversationId });
    } catch (err) {
        console.error("Delete conversation error:", err);
        res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }
};
// Send a message to a user (auto-create 1-on-1 conversation if needed)
exports.sendMessage = async (req, res) => {
    let actorScope;

    try {
        actorScope = getSocialActorScope(req, req.body?.authorCompanyId || null);
    } catch (err) {
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }

    const senderId = actorScope.userId;
    const authorCompanyId = actorScope.orgId;
    const { targetUserId, text_content, shared_post_id, replyMessageId } = req.body;
    const images = req.files; // Array of files from multer

    const trimmedText = text_content?.trim() || '';
    // Basic validation: user needs target + (text OR post OR images)
    if (!targetUserId || (!trimmedText && !shared_post_id && (!images || images.length === 0))) {
        return res.status(400).json({ message: "targetUserId and content (text, post, or images) are required" });
    }

    if (senderId === targetUserId) {
        return res.status(400).json({ message: "Cannot send message to yourself" });
    }

    const client = await pool.connect();
    const MAX_RETRIES = 2;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');

            let senderName, senderAvatar, senderSlug = null, senderHeadline = null;
            if (authorCompanyId) {
                const orgRes = await client.query(
                    `SELECT name, logo_url, slug FROM organizations WHERE org_id = $1`,
                    [authorCompanyId]
                );
                if (orgRes.rowCount === 0) {
                    await client.query('ROLLBACK');
                    return res.status(404).json({ message: "Company not found" });
                }
                senderName = orgRes.rows[0].name;
                senderAvatar = orgRes.rows[0].logo_url;
                senderSlug = orgRes.rows[0].slug;

                // Session check: if feature enabled, require active session
                const sessionFeatureEnabled = (() => {
                    if (process.env.organization_chat_sessions_ENABLED === 'false') return false;
                    const perCompany = process.env.organization_chat_sessions_COMPANIES || 'all';
                    if (perCompany === 'all') return true;
                    return perCompany.split(',').map(s => s.trim()).includes(authorCompanyId);
                })();

                var activeSession = null;
                if (sessionFeatureEnabled) {
                    // Rate limit company messages
                    const rateCheck = checkRateLimit(`${authorCompanyId}:${senderId}`, 'company:message');
                    if (!rateCheck.allowed) {
                        await client.query('ROLLBACK');
                        return res.status(429).json({ message: 'Too many messages. Please slow down.', retryAfterMs: rateCheck.retryAfterMs });
                    }
                }
            } else {
                const senderRes = await client.query(
                    `SELECT full_name, avatar_url, headline, account_name FROM users WHERE user_id = $1`,
                    [senderId]
                );
                if (senderRes.rowCount === 0) {
                    await client.query('ROLLBACK');
                    return res.status(404).json({ message: "Sender not found." });
                }
                senderName = senderRes.rows[0].full_name;
                senderAvatar = senderRes.rows[0].avatar_url;
                senderHeadline = senderRes.rows[0].headline;
                senderSlug = senderRes.rows[0].account_name;
            }

            // Determine if target is a user or a company (fetch full profile for socket payload)
            const targetUserExists = await client.query(
                `SELECT user_id, full_name, avatar_url, headline, account_name FROM users WHERE user_id = $1`,
                [targetUserId]
            );
            const targetCompanyExists = targetUserExists.rowCount === 0
                ? await client.query(`SELECT org_id, name, logo_url, slug FROM organizations WHERE org_id = $1`, [targetUserId])
                : null;

            const targetIsUser = targetUserExists.rowCount > 0;
            const targetIsCompany = !targetIsUser && targetCompanyExists?.rowCount > 0;

            // Capture target display info for socket payload
            const targetName = targetIsUser
                ? targetUserExists.rows[0].full_name
                : (targetIsCompany ? targetCompanyExists.rows[0].name : null);
            const targetAvatar = targetIsUser
                ? targetUserExists.rows[0].avatar_url
                : (targetIsCompany ? targetCompanyExists.rows[0].logo_url : null);
            const targetHeadline = targetIsUser ? (targetUserExists.rows[0].headline || null) : null;
            const targetSlug = targetIsUser
                ? targetUserExists.rows[0].account_name
                : (targetIsCompany ? targetCompanyExists.rows[0].slug : null);
            const targetType = targetIsCompany ? 'COMPANY' : 'USER';

            if (!targetIsUser && !targetIsCompany) {
                await client.query('ROLLBACK');
                return res.status(400).json({ message: "Target not found." });
            }

            // Block check: only applies to user targets (companies are not blockable)
            if (targetIsUser) {
                try {
                    const { checkBlockStatus } = require("../../core/utils/blockCheck");
                    const isBlocked = await checkBlockStatus(senderId, targetUserId);
                    if (isBlocked) {
                        await client.query('ROLLBACK');
                        return res.status(404).json({ message: "User not found" });
                    }
                } catch (e) {
                    console.error("Block check failed", e);
                }
            }

            let conversationId;
            let isNewConversation = false;
            let newSessionHandlerName = null;

            if (authorCompanyId) {
                // Company-to-User: look for a conversation where company is a participant AND target user is a participant
                const existingConv = await client.query(
                    `SELECT c.conversation_id
                     FROM conversations c
                     JOIN conversation_participants cp1 ON c.conversation_id = cp1.conversation_id AND cp1.org_id = $1
                     JOIN conversation_participants cp2 ON c.conversation_id = cp2.conversation_id AND cp2.user_id = $2
                     WHERE c.is_group = FALSE AND c.is_active = TRUE`,
                    [authorCompanyId, targetUserId]
                );

                if (existingConv.rowCount > 0) {
                    conversationId = existingConv.rows[0].conversation_id;
                } else {
                    // Create new conversation with company as one participant
                    const convRes = await client.query(
                        `INSERT INTO conversations (is_group, is_requesting, created_by) VALUES (FALSE, FALSE, $1) RETURNING conversation_id`,
                        [senderId]
                    );
                    conversationId = convRes.rows[0].conversation_id;
                    isNewConversation = true;

                    // Company participant (no user_id)
                    await client.query(
                        `INSERT INTO conversation_participants (conversation_id, org_id) VALUES ($1, $2)`,
                        [conversationId, authorCompanyId]
                    );
                    // Target user participant
                    await client.query(
                        `INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2)`,
                        [conversationId, targetUserId]
                    );
                }
            } else if (targetIsCompany) {
                // User-to-Company: look for a conversation where user is a participant AND target company is a participant
                const existingConv = await client.query(
                    `SELECT c.conversation_id
                     FROM conversations c
                     JOIN conversation_participants cp1 ON c.conversation_id = cp1.conversation_id AND cp1.user_id = $1
                     JOIN conversation_participants cp2 ON c.conversation_id = cp2.conversation_id AND cp2.org_id = $2
                     WHERE c.is_group = FALSE AND c.is_active = TRUE`,
                    [senderId, targetUserId]
                );

                if (existingConv.rowCount > 0) {
                    conversationId = existingConv.rows[0].conversation_id;
                } else {
                    const convRes = await client.query(
                        `INSERT INTO conversations (is_group, is_requesting, created_by) VALUES (FALSE, FALSE, $1) RETURNING conversation_id`,
                        [senderId]
                    );
                    conversationId = convRes.rows[0].conversation_id;

                    // Sender user participant
                    await client.query(
                        `INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2)`,
                        [conversationId, senderId]
                    );
                    // Target company participant
                    await client.query(
                        `INSERT INTO conversation_participants (conversation_id, org_id) VALUES ($1, $2)`,
                        [conversationId, targetUserId]
                    );
                }
            } else {
                // User-to-User: original logic
                const existingConv = await client.query(
                    `SELECT c.conversation_id
                     FROM conversations c
                     JOIN conversation_participants cp1 ON c.conversation_id = cp1.conversation_id AND cp1.user_id = $1
                     JOIN conversation_participants cp2 ON c.conversation_id = cp2.conversation_id AND cp2.user_id = $2
                     WHERE c.is_group = FALSE AND c.is_active = TRUE`,
                    [senderId, targetUserId]
                );

                if (existingConv.rowCount > 0) {
                    conversationId = existingConv.rows[0].conversation_id;
                } else {
                    // Check if target is following sender
                    const followCheck = await client.query(
                        `SELECT 1 FROM followers  
                         WHERE follower_id = $1 AND following_id = $2`,
                        [targetUserId, senderId]
                    );

                    const isRequesting = followCheck.rowCount === 0; // not following = requesting

                    const convRes = await client.query(
                        `INSERT INTO conversations (is_group, is_requesting, created_by) 
                         VALUES (FALSE, $1, $2) 
                         RETURNING conversation_id`,
                        [isRequesting, senderId]
                    );
                    conversationId = convRes.rows[0].conversation_id;
                    isNewConversation = true;

                    await client.query(
                        `INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2), ($1, $3)`,
                        [conversationId, senderId, targetUserId]
                    );
                }
            }

            // Fetch conversation metadata needed for socket payload
            const convMeta = await client.query(
                `SELECT is_requesting, created_at FROM conversations WHERE conversation_id = $1`,
                [conversationId]
            );
            const convIsRequesting = convMeta.rows[0]?.is_requesting ?? false;
            const convCreatedAt = convMeta.rows[0]?.created_at ?? null;

            // Insert the message
            // Determine message text for notifications/preview
            const previewText = trimmedText
                ? trimmedText
                : (images && images.length > 0
                    ? (images.length > 1 ? `${images.length} attachments` : (images[0].mimetype.startsWith('video/') ? 'Sent a video' : (images[0].mimetype === 'application/pdf' ? 'Sent a document' : 'Sent a photo')))
                    : (shared_post_id ? 'Shared a post' : 'Attachment'));

            // Session enforcement for company messages (within transaction for atomicity)
            let sessionId = null;
            if (authorCompanyId) {
                const sessionFeatureEnabled = (() => {
                    if (process.env.organization_chat_sessions_ENABLED === 'false') return false;
                    const perCompany = process.env.organization_chat_sessions_COMPANIES || 'all';
                    if (perCompany === 'all') return true;
                    return perCompany.split(',').map(s => s.trim()).includes(authorCompanyId);
                })();

                if (sessionFeatureEnabled) {
                    const sessionCheck = await client.query(
                        `SELECT session_id FROM organization_chat_sessions
                         WHERE conversation_id = $1 AND org_id = $2
                         AND handler_user_id = $3 AND status = 'ACTIVE'
                         FOR UPDATE`,
                        [conversationId, authorCompanyId, senderId]
                    );
                    if (sessionCheck.rowCount === 0) {
                        if (isNewConversation) {
                            // Auto-claim session for new conversation
                            // 1. Get member details for snapshot
                            const memberRes = await client.query(
                                `SELECT cm.role_id, cr.name as role_name, u.full_name
                                 FROM organization_members cm
                                 JOIN users u ON cm.user_id = u.user_id
                                 LEFT JOIN organization_roles cr ON cm.role_id = cr.role_id
                                 WHERE cm.org_id = $1 AND cm.user_id = $2`,
                                [authorCompanyId, senderId]
                            );

                            const memberDetails = memberRes.rows[0];
                            // Fallback if not found (should be validated by now, but safe guard)
                            const handlerName = memberDetails?.full_name || 'Unknown';
                            newSessionHandlerName = handlerName;
                            const roleId = memberDetails?.role_id || null;
                            const roleName = memberDetails?.role_name || null;

                            // 2. Create Session
                            const newSessionRes = await client.query(
                                `INSERT INTO organization_chat_sessions 
                                 (conversation_id, org_id, handler_user_id, 
                                  handler_name_snapshot, handler_role_id_snapshot, handler_role_name_snapshot,
                                  status)
                                 VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE')
                                 RETURNING session_id`,
                                [conversationId, authorCompanyId, senderId, handlerName, roleId, roleName]
                            );
                            sessionId = newSessionRes.rows[0].session_id;

                            // 3. Notify socket (queued for after commit)
                            // We'll emit 'session_claimed' below
                        } else {
                            await client.query('ROLLBACK');
                            return res.status(403).json({ message: 'No active session. Claim conversation first.' });
                        }
                    } else {
                        sessionId = sessionCheck.rows[0].session_id;
                    }
                }
            }

            const msgRes = await client.query(
                `INSERT INTO messages (conversation_id, sender_id, text_content, shared_post_id, author_org_id, sender_type, session_id, replied_msg_id)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
                [conversationId, senderId, trimmedText || '', shared_post_id || null, authorCompanyId || null, authorCompanyId ? 'COMPANY' : 'USER', sessionId, replyMessageId || null]
            );
            const newMessage = msgRes.rows[0];

            // Process Images
            // Process Media (Images, Video, PDF)
            let mediaRecords = [];
            if (images && images.length > 0) {
                const mediaValues = images.map(file => {
                    let type = 'image';
                    if (file.mimetype.startsWith('video/')) type = 'video';
                    if (file.mimetype === 'application/pdf') type = 'document';
                    return [newMessage.message_id, file.path, type];
                });

                // Construct bulk insert parameters
                const placeholders = mediaValues.map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`).join(', ');
                const flatValues = mediaValues.flat();

                const mediaRes = await client.query(
                    `INSERT INTO message_media (message_id, url, media_type) 
                     VALUES ${placeholders} 
                     RETURNING url, media_type`,
                    flatValues
                );
                mediaRecords = mediaRes.rows;
            }

            // Fetch shared post details if applicable
            let sharedPostData = null;
            if (shared_post_id) {
                const spRes = await client.query(`
                    SELECT 
                        p.post_id, p.content, p.created_at, 
                        json_build_object('full_name', u.full_name, 'avatar_url', u.avatar_url) as author,
                        (SELECT json_agg(json_build_object('url', url, 'media_type', media_type)) FROM post_media WHERE post_id = p.post_id) as media
                    FROM posts p
                    JOIN users u ON p.author_id = u.user_id
                    WHERE p.post_id = $1
                `, [shared_post_id]);
                if (spRes.rowCount > 0) sharedPostData = spRes.rows[0];
            }

            // Update conversation timestamp and last message
            await client.query(
                `UPDATE conversations 
                 SET updated_at = now(),
                     last_message = $2,
                     last_message_at = now()
                 WHERE conversation_id = $1`,
                [conversationId, previewText]
            );
            // Update session activity (within transaction)
            if (sessionId) {
                await client.query(
                    `UPDATE organization_chat_sessions
                     SET last_activity_at = NOW(), message_count = message_count + 1
                     WHERE session_id = $1`,
                    [sessionId]
                );
            }

            await client.query('COMMIT');

            // Emit session activity event (outside transaction)
            if (sessionId && authorCompanyId) {
                try {
                    const members = await pool.query(
                        'SELECT user_id FROM organization_members WHERE org_id = $1 AND status = $2',
                        [authorCompanyId, 'ACTIVE']
                    );
                    for (const m of members.rows) {
                        socketService.notifyUser(m.user_id, 'session_activity', {
                            conversationId,
                            sessionId,
                            lastActivityAt: new Date().toISOString()
                        });
                    }
                } catch (notifyErr) {
                    console.error('Error emitting session_activity:', notifyErr);
                }
            }

            // Emit session_claimed (outside transaction) if auto-claimed
            if (sessionId && authorCompanyId && isNewConversation && newSessionHandlerName) {
                try {
                    const members = await pool.query(
                        'SELECT user_id FROM organization_members WHERE org_id = $1 AND status = $2',
                        [authorCompanyId, 'ACTIVE']
                    );
                    for (const m of members.rows) {
                        socketService.notifyUser(m.user_id, 'session_claimed', {
                            conversationId,
                            sessionId,
                            handlerUserId: senderId,
                            handlerName: newSessionHandlerName
                        });
                    }
                } catch (notifyErr) {
                    console.error('Error emitting session_claimed:', notifyErr);
                }
            }

            let replyMessageData = null;
            if (replyMessageId) {
                const rmRes = await client.query(`
                    SELECT 
                        rm.message_id, 
                        rm.text_content, 
                        rm.message_type,
                        COALESCE(rc.name, ru.full_name, 'Deleted User') as sender_name
                    FROM messages rm
                    LEFT JOIN users ru ON rm.sender_id = ru.user_id
                    LEFT JOIN organizations rc ON rm.author_org_id = rc.org_id
                    WHERE rm.message_id = $1
                `, [replyMessageId]);
                if (rmRes.rowCount > 0) replyMessageData = rmRes.rows[0];
            }

            const messageData = {
                ...newMessage,
                replyMessageId: replyMessageId || null,
                reply_message: replyMessageData,
                media: mediaRecords,
                shared_post: sharedPostData,
                sender_name: senderName,
                sender_avatar: senderAvatar
            };
            // ─── Base conversation shape (mirrors the REST API getConversations response) ───
            // Fields that are the same regardless of who receives the event
            const baseConvPayload = {
                conversation_id: conversationId,
                is_group: false,
                is_active: true,
                is_requesting: convIsRequesting,
                created_at: convCreatedAt,
                updated_at: newMessage.created_at,
                is_new_conversation: isNewConversation,
                description: null,
                created_by: null,
                group_headline: null,
                conversation_name: null,
                admin_id: null,
                group_avatar: null,
                // Last message
                last_message: previewText,
                last_message_text: previewText,
                last_message_at: newMessage.created_at,
                last_message_id: newMessage.message_id,
                // Block status (message sent successfully → no blocks active)
                is_blocked_by_me: false,
                is_blocked_by_other: false,
                // Author context (who sent this particular message)
                sender_id: senderId,
                author_company_id: authorCompanyId || null,
            };

            // ─── Receiver payload: other_user_* = SENDER info ───
            const receiverConvPayload = {
                ...baseConvPayload,
                other_user_id: authorCompanyId ? authorCompanyId : senderId,
                other_user_name: senderName,
                other_user_avatar: senderAvatar,
                other_user_headline: senderHeadline,
                other_user_slug: senderSlug,
                other_user_type: authorCompanyId ? 'COMPANY' : 'USER',
                is_deleted_user: false,
                unread_count: 1, // receiver always has at least 1 unread
            };

            // ─── Sender payload: other_user_* = TARGET info ───
            const senderConvPayload = {
                ...baseConvPayload,
                other_user_id: targetUserId,
                other_user_name: targetName,
                other_user_avatar: targetAvatar,
                other_user_headline: targetHeadline,
                other_user_slug: targetSlug,
                other_user_type: targetType,
                is_deleted_user: false,
                unread_count: 0, // sender has read their own message
            };

            // Notify via socket
            if (targetIsCompany) {
                // User→Company: notify all members of the target company
                const members = await pool.query(
                    'SELECT user_id FROM organization_members WHERE org_id = $1',
                    [targetUserId]
                );
                for (const member of members.rows) {
                    socketService.notifyUser(member.user_id, "new_message", messageData);
                    socketService.notifyUser(member.user_id, "conversation_updated", {
                        ...receiverConvPayload,
                        target_profile_type: 'COMPANY',
                        target_company_id: targetUserId
                    });
                    socketService.notifyUser(member.user_id, "notification", {
                        type: "message",
                        from: senderId,
                        senderName,
                        senderAvatar,
                        conversationId,
                        text: previewText,
                        targetProfileType: 'COMPANY',
                        targetCompanyId: targetUserId
                    });
                }
            } else {
                // User→User or Company→User: notify target user directly
                socketService.notifyUser(targetUserId, "new_message", messageData);
                socketService.notifyUser(targetUserId, "conversation_updated", {
                    ...receiverConvPayload,
                    target_profile_type: 'USER'
                });
                socketService.notifyUser(targetUserId, "notification", {
                    type: "message",
                    from: senderId,
                    senderName,
                    senderAvatar,
                    conversationId,
                    text: previewText,
                    targetProfileType: 'USER'
                });
            }
            // Notify sender as well
            socketService.notifyUser(senderId, "new_message", messageData);
            socketService.notifyUser(senderId, "conversation_updated", {
                ...senderConvPayload,
                target_profile_type: targetIsCompany ? 'COMPANY' : 'USER',
                target_company_id: targetIsCompany ? targetUserId : null
            });

            res.status(201).json({
                conversationId,
                message: "Message sent successfully",
                data: messageData
            });
            break; // Success — exit retry loop
        } catch (err) {
            await client.query('ROLLBACK');
            // Retry on serialization failure (race condition: concurrent first messages)
            if (err.code === '40001' && attempt < MAX_RETRIES) {
                continue;
            }
            console.error("Error in sendMessage:", err);
            if (!res.headersSent) {
                res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
            }
            break; // Exit retry loop on non-serialization errors
        }
    } // end retry loop
    client.release();
};
exports.markConversationRead = async (req, res) => {
    const {
        conversationId
    } = req.params;
    let actorScope;

    try {
        actorScope = getSocialActorScope(req, req.body?.companyId || null);
    } catch (err) {
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }

    const { userId, orgId: companyId } = actorScope;

    try {
        const readResult = await markConversationAsRead({ conversationId, userId, companyId });

        res.json({
            message: "Conversation marked as read",
            readAt: readResult.readAt,
            readCount: readResult.readCount
        });

    } catch (err) {
        console.error("Mark conversation read error:", err);
        res.status(err.statusCode || 500).json({
            message: err.message || "Internal server error"
        });
    }
};

exports.getMessageSeenBy = async (req, res) => {
    const {
        messageId
    } = req.params;
    let actorScope;

    try {
        actorScope = getSocialActorScope(req, req.query.companyId || null);
    } catch (err) {
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }

    const { userId, orgId: companyId } = actorScope;

    try {
        // Validation: Verify user is part of the conversation this message belongs to
        // (Optional but recommended for security)
        const accessCheck = await pool.query(
            `
            SELECT 1 
            FROM messages m
            JOIN conversation_participants cp ON m.conversation_id = cp.conversation_id
            WHERE m.message_id = $1 
            AND (
                ($3::uuid IS NOT NULL AND cp.org_id = $3)
                OR
                ($3::uuid IS NULL AND cp.user_id = $2)
            )
            `,
            [messageId, userId, companyId]
        );

        if (accessCheck.rowCount === 0) {
            return res.status(403).json({
                message: "Access denied or message not found"
            });
        }

        // Fetch users who have read the message
        const result = await pool.query(
            `
            SELECT 
                u.user_id,
                u.full_name,
                u.avatar_url,
                mr.read_at
            FROM message_reads mr
            JOIN users u ON mr.user_id = u.user_id
            WHERE mr.message_id = $1
            ORDER BY mr.read_at ASC
            `,
            [messageId]
        );

        res.json(result.rows);

    } catch (err) {
        console.error("Get message seen by error:", err);
        res.status(err.statusCode || 500).json({
            message: err.message || "Internal server error"
        });
    }
};

// Get all messages in a conversation
exports.getMessages = async (req, res) => {
    const conversation_id = req.params.id;
    const limit = parseInt(req.query.limit) || 50;
    let before = req.query.before || null;
    let actorScope;

    try {
        actorScope = getSocialActorScope(req, req.query.companyId || null);
        const { userId, orgId: companyId } = actorScope;

        // Robust UUID check (standard 8-4-4-4-12 hex with hyphens)
        const isUUID = (str) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);

        // 1. Resolve Pagination Cursor
        // If 'before' is a UUID (messageId), fetch its created_at timestamp.
        // If it's already a timestamp string, use it as is.
        if (before && isUUID(before)) {
            const cursorRes = await pool.query(
                'SELECT created_at FROM messages WHERE message_id = $1',
                [before]
            );

            if (cursorRes.rowCount > 0) {
                before = cursorRes.rows[0].created_at; // Use the timestamp
            } else {
                // Message not found (deleted?), fallback to null to avoid crash
                before = null;
            }
        }

        // 2. Simple participation check (check if the user EVER joined)
        const partCheck = await pool.query(
            `SELECT c.is_group 
             FROM conversations c
             JOIN conversation_participants cp ON c.conversation_id = cp.conversation_id
             WHERE c.conversation_id = $1 
             AND c.is_active = TRUE
             AND (
                ($3::uuid IS NOT NULL AND cp.org_id = $3)
                OR
                ($3::uuid IS NULL AND cp.user_id = $2)
             )
             LIMIT 1`,
            [conversation_id, userId, companyId]
        );

        if (partCheck.rowCount === 0)
            return res.status(403).json({ message: "Not a participant" });

        const { is_group } = partCheck.rows[0];

        // 3. Fetch Messages with multi-period filtering
        const result = await pool.query(
            `SELECT 
                m.message_id,
                m.conversation_id,
                m.sender_id,
                m.created_at,
                m.read_at,
                m.edited_at,
                m.is_edited,
                m.message_type,
                m.action_type,
                m.target_id,
                m.author_org_id,
                m.is_deleted_for_everyone,
                m.deleted_at,
                COALESCE(c.name, u.full_name, 'Deleted User') as sender_name,
                COALESCE(c.logo_url, u.avatar_url, NULL) as sender_avatar,
                (SELECT json_agg(json_build_object('url', mm.url, 'media_type', mm.media_type)) 
                 FROM message_media mm 
                 WHERE mm.message_id = m.message_id
                ) as media,
                CASE 
                    WHEN EXISTS (SELECT 1 FROM blocks WHERE blocker_id = $4 AND blocked_id = m.sender_id) THEN true 
                    ELSE false 
                END as is_blocked,
                CASE 
                    WHEN EXISTS (SELECT 1 FROM blocks WHERE blocker_id = $4 AND blocked_id = m.sender_id) THEN 'Message hidden'
                    ELSE m.text_content 
                END as text_content,
                CASE 
                    WHEN m.shared_post_id IS NOT NULL 
                         AND NOT EXISTS (SELECT 1 FROM blocks WHERE blocker_id = $4 AND blocked_id = m.sender_id)
                         AND NOT EXISTS (
                            SELECT 1 FROM blocks b 
                            WHERE (b.blocker_id = $4 AND b.blocked_id = sp.author_id)
                                OR (b.blocker_id = sp.author_id AND b.blocked_id = $4)
                         )
                    THEN
                        json_build_object(
                            'post_id', sp.post_id,
                            'content', sp.content,
                            'author', json_build_object('full_name', au.full_name, 'avatar_url', au.avatar_url),
                            'media', (SELECT json_agg(json_build_object('url', url, 'media_type', media_type)) FROM post_media WHERE post_id = sp.post_id)
                        )
                    ELSE NULL 
                END AS shared_post,
                m.shared_profile_id,
                m.shared_profile_type,
                m.entity_type,
                m.entity_id,
                CASE
                    WHEN m.shared_profile_id IS NOT NULL AND m.shared_profile_type = 'user' THEN
                        (SELECT json_build_object(
                            'name', pu.full_name,
                            'avatar', pu.avatar_url,
                            'headline', pu.headline,
                            'location', pu.location,
                            'username', pu.account_name
                        ) FROM users pu WHERE pu.user_id = m.shared_profile_id)
                    WHEN m.shared_profile_id IS NOT NULL AND m.shared_profile_type = 'company' THEN
                        (SELECT json_build_object(
                            'name', pc.name,
                            'avatar', pc.logo_url,
                            'headline', pc.industry,
                            'industry', pc.industry,
                            'slug', pc.slug
                        ) FROM organizations pc WHERE pc.org_id = m.shared_profile_id AND pc.is_deleted = FALSE)
                    ELSE NULL
                END AS shared_profile,
                EXISTS(SELECT 1 FROM message_delete md WHERE md.message_id = m.message_id AND md.user_id = $4) as is_deleted_for_me,
                m.replied_msg_id AS "replyMessageId",
                CASE
                    WHEN m.replied_msg_id IS NOT NULL THEN
                        (SELECT json_build_object(
                            'message_id', rm.message_id,
                            'text_content', rm.text_content,
                            'sender_name', COALESCE(rc.name, ru.full_name, 'Deleted User'),
                            'message_type', rm.message_type
                        ) 
                        FROM messages rm 
                        LEFT JOIN users ru ON rm.sender_id = ru.user_id
                        LEFT JOIN organizations rc ON rm.author_org_id = rc.org_id
                        WHERE rm.message_id = m.replied_msg_id)
                    ELSE NULL
                END AS reply_message,
                COALESCE(
                    (SELECT JSON_AGG(
                        JSON_BUILD_OBJECT(
                            'user_id', mr.user_id,
                            'full_name', rru.full_name,
                            'avatar', rru.avatar_url,
                            'emoji', mr.emoji,
                            'created_at', mr.created_at,
                            'updated_at', mr.updated_at
                        ) ORDER BY mr.updated_at DESC
                    ) FILTER (WHERE mr.reaction_id IS NOT NULL AND mr.emoji IS NOT NULL AND mr.emoji != '')
                    FROM message_reactions mr
                    JOIN users rru ON rru.user_id = mr.user_id
                    WHERE mr.message_id = m.message_id),
                    '[]'::json
                ) AS reactions
             FROM messages m
             LEFT JOIN users u ON m.sender_id = u.user_id
             LEFT JOIN organizations c ON m.author_org_id = c.org_id
             LEFT JOIN posts sp ON m.shared_post_id = sp.post_id
             LEFT JOIN users au ON sp.author_id = au.user_id
             WHERE m.conversation_id = $1 
             -- Visibility: If not group, show all. If group, check ANY participation record.
             AND ($2::boolean = false OR EXISTS (
                SELECT 1 FROM conversation_participants cp 
                WHERE cp.conversation_id = m.conversation_id 
                AND (
                    -- Check if I am a participant as User OR Company
                    ($6::uuid IS NOT NULL AND cp.org_id = $6)
                    OR
                    ($6::uuid IS NULL AND cp.user_id = $4)
                )
                AND m.created_at >= cp.joined_at
                AND (cp.left_at IS NULL OR m.created_at <= cp.left_at)
             ))
             -- Pagination: Fetch messages older than 'before' cursor
             AND ($3::timestamp IS NULL OR m.created_at < $3::timestamp)
             ORDER BY m.created_at DESC
             LIMIT $5`,
            [conversation_id, is_group, before, userId, limit, companyId]

        );

        // Process messages: Filter "delete for me" and mask "delete for everyone"
        const comments = result.rows
            .map(msg => {
                // If deleted for everyone, show generic deleted message
                if (msg.is_deleted_for_everyone) {
                    return {
                        ...msg,
                        text_content: "This message was deleted",
                        shared_post: null,
                        is_deleted: true,
                        message_type: 'text'
                    };
                }

                // If deleted JUST for me, show specific message
                if (msg.is_deleted_for_me) {
                    return {
                        ...msg,
                        text_content: "This message deleted for you",
                        shared_post: null,
                        is_deleted: true,
                        // Keep message_type text so it renders as a bubble, but with specific styling in frontend
                        message_type: 'text'
                    };
                }

                return msg;
            })
            .reverse();

        res.json(comments);
    } catch (err) { // added catch block close logic check 
        console.error("Get messages error:", err);
        res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }
};

// Delete a message sent by logged-in user
exports.deleteMessage = async (req, res) => {
    const userId = req.user.sub;
    const message_id = req.params.id;
    const { deleteForEveryone } = req.body;

    try {
        // First get the message to verify ownership and get conversation_id
        const msgResult = await pool.query(
            `SELECT conversation_id, sender_id FROM messages WHERE message_id = $1`,
            [message_id]
        );

        if (msgResult.rowCount === 0)
            return res.status(404).json({ message: "Message not found" });

        const { conversation_id, sender_id } = msgResult.rows[0];

        if (deleteForEveryone) {
            // Check ownership
            if (String(sender_id) !== String(userId)) {
                return res.status(403).json({ message: "You can only delete your own messages for everyone" });
            }

            // Soft delete for everyone
            await pool.query(
                `UPDATE messages SET is_deleted_for_everyone = TRUE WHERE message_id = $1`,
                [message_id]
            );

            // Notify all participants
            socketService.notifyConversation(conversation_id, "message_deleted", {
                messageId: message_id,
                conversationId: conversation_id,
                deleteType: 'everyone'
            });
            // Also emit specific event for GroupChat compatibility
            socketService.notifyConversation(conversation_id, "message_deleted_for_everyone", {
                messageId: message_id,
                conversationId: conversation_id
            });

        } else {
            // Delete for me (soft delete)
            // Insert into message_delete table
            // Ensure we don't insert duplicate
            await pool.query(
                `INSERT INTO message_delete (message_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                [message_id, userId]
            );

            // Do NOT notify conversation for "delete for me" to avoid affecting others
            // The client performs optimistic update.
        }

        res.json({ message: "Message deleted successfully" });
    } catch (err) {
        console.error("Delete message error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

// Edit a message sent by logged-in user
exports.editMessage = async (req, res) => {
    const userId = req.user.sub;
    const message_id = req.params.messageId;
    const { text_content } = req.body;

    if (!text_content) {
        return res.status(400).json({ message: "Content is required" });
    }

    try {
        const result = await pool.query(
            `UPDATE messages 
             SET text_content = $1, 
                 edited_at = NOW(), 
                 is_edited = TRUE 
             WHERE message_id = $2 AND sender_id = $3 
             RETURNING *`,
            [text_content, message_id, userId]
        );

        if (result.rowCount === 0)
            return res.status(404).json({ message: "Message not found or unauthorized" });

        const updatedMessage = result.rows[0];

        // Get sender details for socket event (optional but good for consistency)
        const userRes = await pool.query(`SELECT full_name, avatar_url FROM users WHERE user_id = $1`, [userId]);
        const sender = userRes.rows[0];

        const messageData = {
            ...updatedMessage,
            sender_name: sender.full_name,
            sender_avatar: sender.avatar_url
        };

        // Notify all participants
        const { conversation_id } = updatedMessage;

        socketService.notifyConversation(conversation_id, "new_message", messageData);

        res.json({ message: "Message edited successfully", data: messageData });
    } catch (err) {
        console.error("Edit message error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};




// Get all notifications for logged-in user
// Get all notifications for logged-in user
exports.getNotifications = async (req, res) => {
    let actorScope;

    try {
        actorScope = getSocialActorScope(req, req.query.companyId || null);
    } catch (err) {
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }

    const { userId, orgId: companyId } = actorScope;

    try {
        let query = `
            SELECT n.*, 
                n.recipient_org_id as recipient_company_id,
                CASE 
                    WHEN (n.metadata->>'org_id') IS NOT NULL THEN c.name 
                    ELSE u.full_name 
                END as actor_name, 
                CASE 
                    WHEN (n.metadata->>'org_id') IS NOT NULL THEN c.logo_url 
                    ELSE u.avatar_url 
                END as actor_avatar,
                COALESCE(c.slug, u.account_name) as actor_slug,
                ((n.metadata->>'org_id') IS NOT NULL) as is_company_actor,
                cr.request_id as request_id, 
                cr.status as request_status
            FROM notifications n 
            LEFT JOIN users u ON n.sender_id = u.user_id 
            LEFT JOIN organizations c ON NULLIF(n.metadata->>'org_id', '')::uuid = c.org_id
            LEFT JOIN connection_requests cr ON n.sender_id = cr.sender_id AND n.user_id = cr.receiver_id AND cr.status = 'pending'
            WHERE 
        `;

        if (companyId) {
            query += `
                n.recipient_org_id = $1
                AND NOT EXISTS (
                    SELECT 1
                    FROM blocks b
                    WHERE b.blocker_id = $1
                    AND b.blocked_id = n.sender_id
                )
            `;
        } else {
            query += `
                n.user_id = $1
                AND n.recipient_org_id IS NULL
                AND NOT EXISTS (
                    SELECT 1
                    FROM blocks b
                    WHERE b.blocker_id = $1
                    AND b.blocked_id = n.sender_id
                )
            `;
        }

        query += ` ORDER BY n.created_at DESC`;

        const result = await pool.query(query, [companyId || userId]);
        res.json(result.rows);
    } catch (err) {
        console.error("Get notifications error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

// Mark a notification as read
exports.markNotificationRead = async (req, res) => {
    const { id } = req.params;
    let actorScope;

    try {
        actorScope = getSocialActorScope(req, req.query.companyId || req.body?.companyId || null);
    } catch (err) {
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }

    const { userId, orgId: companyId } = actorScope;

    try {
        const query = companyId
            ? `UPDATE notifications
               SET is_read = TRUE
               WHERE notification_id = $1 AND recipient_org_id = $2
               RETURNING *`
            : `UPDATE notifications
               SET is_read = TRUE
               WHERE notification_id = $1 AND user_id = $2 AND recipient_org_id IS NULL
               RETURNING *`;
        const result = await pool.query(query, [id, companyId || userId]);

        if (result.rowCount === 0)
            return res.status(404).json({ message: "Notification not found" });

        socketService.notifyUser(userId, "notificationRead", {
            notificationId: id,
        });

        res.json({
            message: "Notification marked as read",
            notification: result.rows[0],
        });
    } catch (err) {
        res.status(500).json({ message: "Internal server error" });
    }
};

// Mark ALL notifications as read
exports.markAllNotificationsRead = async (req, res) => {
    let actorScope;

    try {
        actorScope = getSocialActorScope(req, req.body?.companyId || req.query.companyId || null);
    } catch (err) {
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }

    const { userId, orgId: companyId } = actorScope;

    try {
        let query = `UPDATE notifications SET is_read = TRUE WHERE is_read = FALSE`;
        const params = [];

        if (companyId) {
            query += ` AND recipient_org_id = $1`;
            params.push(companyId);
        } else {
            query += ` AND user_id = $1 AND recipient_org_id IS NULL`;
            params.push(userId);
        }

        await pool.query(query, params);

        res.json({ message: "All notifications marked as read" });
    } catch (err) {
        console.error("Mark all read error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

// Delete a single notification
exports.deleteNotification = async (req, res) => {
    const { id } = req.params;
    let actorScope;

    try {
        actorScope = getSocialActorScope(req, req.query.companyId || req.body?.companyId || null);
    } catch (err) {
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }

    const { userId, orgId: companyId } = actorScope;

    try {
        const query = companyId
            ? `DELETE FROM notifications WHERE notification_id = $1 AND recipient_org_id = $2 RETURNING *`
            : `DELETE FROM notifications WHERE notification_id = $1 AND user_id = $2 AND recipient_org_id IS NULL RETURNING *`;
        const result = await pool.query(query, [id, companyId || userId]);

        if (result.rowCount === 0)
            return res.status(404).json({ message: "Notification not found" });

        res.json({ message: "Notification deleted" });
    } catch (err) {
        console.error("Delete notification error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

// Delete multiple notifications (bulk)
exports.deleteNotificationsBulk = async (req, res) => {
    const { ids } = req.body;
    let actorScope;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ message: "An array of notification ids is required" });
    }

    try {
        actorScope = getSocialActorScope(req, req.body?.companyId || req.query.companyId || null);
    } catch (err) {
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }

    const { userId, orgId: companyId } = actorScope;

    try {
        const query = companyId
            ? `DELETE FROM notifications WHERE notification_id = ANY($1::uuid[]) AND recipient_org_id = $2`
            : `DELETE FROM notifications WHERE notification_id = ANY($1::uuid[]) AND user_id = $2 AND recipient_org_id IS NULL`;
        await pool.query(query, [ids, companyId || userId]);

        res.json({ message: "Notifications deleted" });
    } catch (err) {
        console.error("Delete notifications bulk error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};



/* =====================================================
   BLOCKING
   ===================================================== */
exports.blockUser = async (req, res) => {
    const userId = req.user.sub;
    const targetId = req.params.id;

    if (userId === targetId) {
        return res.status(400).json({ message: "Cannot block yourself" });
    }

    try {
        const BlockModel = require("../../models/block.model");
        const { checkBlockStatus } = require("../../core/utils/blockCheck");

        // Use the model to block
        await BlockModel.blockUser(userId, targetId);

        // Also remove any existing connections logic?
        // Ideally blocking should unfollow/unconnect. 
        // Let's do that for consistency.
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            // Delete connections (bidirectional)
            await client.query(
                "DELETE FROM connections WHERE (user_id = $1 AND connected_user_id = $2) OR (user_id = $2 AND connected_user_id = $1)",
                [userId, targetId]
            );
            // Delete follows (bidirectional)
            await client.query(
                "DELETE FROM followers WHERE (follower_id = $1 AND following_id = $2) OR (follower_id = $2 AND following_id = $1)",
                [userId, targetId]
            );
            // Delete pending requests (bidirectional)
            // Note: blockUser normally handles the block status in connection_requests if implemented there, 
            // but here we are using a separate BlockModel? 
            // The previous logic for handleConnectionRequest used 'blocked' status in connection_requests.
            // If BlockModel is separate, we should probably clear the connection_request or set it to blocked if the schema supports it.
            // For now, adhering to 'remove connection' logic: delete requests.
            await client.query(
                "DELETE FROM connection_requests WHERE (sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1)",
                [userId, targetId]
            );

            await client.query("COMMIT");
        } catch (e) {
            await client.query("ROLLBACK");
            console.error("Block cleanup error", e);
        } finally {
            client.release();
        }

        res.json({ message: "User blocked successfully" });
    } catch (err) {
        console.error("Block user error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

// Remove Connection
exports.removeConnection = async (req, res) => {
    const userId = req.user.sub;
    const targetUserId = req.params.id;

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        // Delete connections (bidirectional)
        await client.query(
            "DELETE FROM connections WHERE (user_id = $1 AND connected_user_id = $2) OR (user_id = $2 AND connected_user_id = $1)",
            [userId, targetUserId]
        );

        // Delete any leftover connection_requests rows (prevents stale 'connected' status on refresh)
        await client.query(
            "DELETE FROM connection_requests WHERE (sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1)",
            [userId, targetUserId]
        );

        // Delete follows (uni-directional removal) - Only I stop following them
        // They continue to follow me unless they unfollow
        await client.query(
            "DELETE FROM followers WHERE follower_id = $1 AND following_id = $2",
            [userId, targetUserId]
        );

        await client.query("COMMIT");

        // Notify both users about relationship update
        socketService.notifyUser(userId, "relationshipUpdated", { userId: targetUserId, status: 'none' });
        socketService.notifyUser(targetUserId, "relationshipUpdated", { userId: userId, status: 'none' });

        return res.status(200).json({ success: true, message: "Connection removed", relationship: "none" });
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Remove connection error:", err);
        return res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

// Get Detailed Relationship Status
exports.getRelationshipStatus = async (req, res) => {
    const userId = req.user.sub;
    const targetUserId = req.params.id;

    if (userId === targetUserId) {
        return res.status(200).json({
            is_me: true,
            status: 'me',
            is_following: false,
            is_followed_by: false
        });
    }

    try {
        const client = await pool.connect();
        try {
            // Check connection (Bidirectional for safety)
            const connectedRes = await client.query(
                "SELECT 1 FROM connections WHERE (user_id = $1 AND connected_user_id = $2) OR (user_id = $2 AND connected_user_id = $1)",
                [userId, targetUserId]
            );
            const isConnected = connectedRes.rowCount > 0;

            if (isConnected) {
                return res.status(200).json({
                    status: 'connected',
                    is_following: true,
                    is_followed_by: true
                });
            }

            // Check pending requests ONLY — connections table is the sole authority for 'connected'
            const requestRes = await client.query(
                "SELECT request_id, sender_id, status, cooldown_until FROM connection_requests WHERE ((sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1)) AND status IN ('pending', 'rejected', 'blocked')",
                [userId, targetUserId]
            );

            let status = 'none';
            let requestId = null;
            let sender = null;

            if (requestRes.rowCount > 0) {
                const req = requestRes.rows[0];
                requestId = req.request_id;

                if (req.status === 'pending') {
                    if (req.sender_id === userId) {
                        status = 'pending_sent';
                    } else {
                        status = 'pending_received';
                        sender = req.sender_id;
                    }
                } else if (req.status === 'rejected') {
                    // Check cooldown
                    if (req.sender_id === userId && new Date(req.cooldown_until) > new Date()) {
                        status = 'cooldown';
                    }
                }
            }

            // Check specific follows if not connected (should strictly not happen if connected)
            const followingRes = await client.query(
                "SELECT 1 FROM followers WHERE follower_id = $1 AND following_id = $2",
                [userId, targetUserId]
            );
            const followedByRes = await client.query(
                "SELECT 1 FROM followers WHERE follower_id = $1 AND following_id = $2",
                [targetUserId, userId]
            );


            return res.status(200).json({
                status,
                is_following: followingRes.rowCount > 0,
                is_followed_by: followedByRes.rowCount > 0,
                request_id: requestId,
                sender: sender
            });

        } finally {
            client.release();
        }
    } catch (err) {
        console.error("Get relationship error:", err);
        return res.status(500).json({ message: "Internal server error" });
    }
};

exports.unblockUser = async (req, res) => {
    const userId = req.user.sub;
    const targetId = req.params.id;

    try {
        const BlockModel = require("../../models/block.model");
        await BlockModel.unblockUser(userId, targetId);
        res.json({ message: "User unblocked successfully" });
    } catch (err) {
        console.error("Unblock user error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.getBlockedUsers = async (req, res) => {
    const userId = req.user.sub;
    try {
        const BlockModel = require("../../models/block.model");
        // Get list of users *I* have blocked
        const blockedUsers = await BlockModel.getBlockedUsersDetails(userId);
        res.json(blockedUsers);
    } catch (err) {
        console.error("Get blocked users error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

// Get Profile Stats (followers, following, connections counts)
exports.getProfileStats = async (req, res) => {
    let userId = req.params.id;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    try {
        if (!uuidRegex.test(userId)) {
            const resolveResult = await pool.query(
                "SELECT user_id FROM users WHERE LOWER(account_name) = LOWER($1)",
                [userId]
            );
            if (resolveResult.rowCount === 0) {
                return res.status(404).json({ message: "User not found" });
            }
            userId = resolveResult.rows[0].user_id;
        }

        const result = await pool.query(
            `SELECT 
                (SELECT COUNT(*) FROM followers WHERE following_id = $1) as followers_count,
                (SELECT COUNT(*) FROM followers WHERE follower_id = $1) + (SELECT COUNT(*) FROM organization_followers cf JOIN organizations c ON cf.org_id = c.org_id WHERE cf.user_id = $1 AND c.is_deleted = FALSE) as following_count,
                (SELECT COUNT(*) FROM connections WHERE user_id = $1) + (SELECT COUNT(*) FROM organization_connections cc JOIN organizations c ON cc.org_id = c.org_id WHERE cc.user_id = $1 AND c.is_deleted = FALSE) as connections_count`,
            [userId]
        );

        const row = result.rows[0];
        return res.status(200).json({
            followers_count: parseInt(row.followers_count),
            following_count: parseInt(row.following_count),
            connections_count: parseInt(row.connections_count)
        });
    } catch (err) {
        console.error("Get profile stats error:", err);
        return res.status(500).json({ message: "Internal server error" });
    }
};



// ---------------------------------------------------------
// COMPANY-LEVEL CONNECTIONS (Separate from personal)
// ---------------------------------------------------------

/**
 * sendCompanyConnectionRequest
 * Company (owner/admin) sends request to user
 */
exports.sendCompanyConnectionRequest = async (req, res) => {
    let actorScope;

    try {
        actorScope = getOrganizationConnectionActorScope(req);
        assertSocialActorPermission(req, "MANAGE_CONNECTIONS");
    } catch (err) {
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }

    const { companyId, userId: initiatorId } = actorScope;
    const { userId: targetUserId } = req.params;
    const { message } = req.body;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Check if already connected
        console.log(`[sendCompanyConnectionRequest] Checking organization_connections: org_id=${companyId}, user_id=${targetUserId}, initiator=${initiatorId}`);
        const connCheck = await client.query(
            "SELECT 1 FROM organization_connections WHERE org_id = $1 AND user_id = $2",
            [companyId, targetUserId]
        );
        if (connCheck.rowCount > 0) {
            console.log(`[sendCompanyConnectionRequest] FOUND existing company_connection for company=${companyId}, user=${targetUserId}`);
            await client.query('ROLLBACK');
            return res.status(200).json({ status: 'connected', message: "Already connected (company-level)" });
        }

        // 2. Check for existing pending request
        const reqCheck = await client.query(
            "SELECT request_id, status FROM organization_connection_requests WHERE org_id = $1 AND user_id = $2",
            [companyId, targetUserId]
        );

        if (reqCheck.rowCount > 0) {
            const row = reqCheck.rows[0];
            if (row.status === 'pending') {
                await client.query('ROLLBACK');
                return res.status(200).json({ status: 'pending_sent', message: "Request already exists" });
            }

            // Clean up old rejected or accepted rows to allow fresh insert
            // (Status 'accepted' should theoretically not be here if connection check passed, 
            // but we clean it up anyway for consistency)
            await client.query("DELETE FROM organization_connection_requests WHERE request_id = $1", [row.request_id]);
        }

        // 3. Create request
        await client.query(
            `INSERT INTO organization_connection_requests (org_id, user_id, initiated_by, message, status) 
             VALUES ($1, $2, $3, $4, 'pending')`,
            [companyId, targetUserId, initiatorId, message || null]
        );

        // 4. Notifications
        const companyRes = await client.query("SELECT name, logo_url FROM organizations WHERE org_id = $1", [companyId]);
        const company = companyRes.rows[0];

        const notificationData = {
            type: "company_connection_request",
            text: `${company.name} wants to connect with you`,
            from: companyId,
            senderName: company.name,
            senderAvatar: company.logo_url,
            referenceId: companyId,
            time: "Just now",
            isCompanyRequest: true
        };

        const notifRes = await client.query(
            `INSERT INTO notifications (user_id, sender_id, type, text, reference_id, recipient_org_id, metadata) 
             VALUES ($1, $2, $3, $4, $5, NULL, $6) RETURNING *`,
            [targetUserId, initiatorId, "company_connection_request", notificationData.text, companyId, JSON.stringify({ org_id: companyId })]
        );

        socketService.notifyUser(targetUserId, "notification", {
            ...notificationData,
            notification_id: notifRes.rows[0].notification_id,
            created_at: notifRes.rows[0].created_at.toISOString()
        });

        // Trigger relationship update on both sides
        socketService.notifyUser(targetUserId, "relationshipUpdated", { userId: companyId, status: 'pending_received', type: 'company' });
        socketService.notifyUser(initiatorId, "relationshipUpdated", { userId: targetUserId, status: 'pending_sent' });

        await client.query('COMMIT');
        res.status(201).json({ status: 'pending_sent', message: "Request sent successfully" });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Send company connection error:", err);
        res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    } finally {
        client.release();
    }
};

/**
 * handleCompanyConnectionRequest
 * User accepts/rejects request from company
 */
exports.handleCompanyConnectionRequest = async (req, res) => {
    const { status } = req.body; // 'accepted' or 'rejected'
    const userId = req.user.sub;
    let companyId;

    try {
        if (req.actor?.type === "ORGANIZATION") {
            const err = new Error("Use personal actor context to respond to company connection requests");
            err.statusCode = 403;
            throw err;
        }

        companyId = getRequestedOrganizationActorId(req, getRouteOrganizationId(req));
    } catch (err) {
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }

    if (!['accepted', 'rejected'].includes(status)) {
        return res.status(400).json({ message: "Invalid action" });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Fetch and Lock the request (Prevention of race conditions)
        const reqRes = await client.query(
            "SELECT request_id FROM organization_connection_requests WHERE org_id = $1 AND user_id = $2 AND status = 'pending' FOR UPDATE",
            [companyId, userId]
        );

        if (reqRes.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: "Pending invitation not found" });
        }

        const invite = reqRes.rows[0];

        if (status === 'accepted') {
            // 2. Create connection + follow (Atomic Multi-update)
            // 2a. The connection itself
            await client.query(
                "INSERT INTO organization_connections (org_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
                [companyId, userId]
            );

            // 2b. Auto-follow the company (user follows company on acceptance)
            await client.query(
                "INSERT INTO organization_followers (user_id, org_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
                [userId, companyId]
            );

            // 3. Update invite status
            await client.query(
                "UPDATE organization_connection_requests SET status = 'accepted', updated_at = NOW() WHERE org_id = $1 AND user_id = $2",
                [companyId, userId]
            );

            // 4. Notifications (Persistent + Real-time)
            const userRes = await client.query("SELECT full_name, avatar_url FROM users WHERE user_id = $1", [userId]);
            const user = userRes.rows[0];

            const companyRes = await client.query("SELECT name, logo_url FROM organizations WHERE org_id = $1", [companyId]);
            const company = companyRes.rows[0];

            // 4a. Persistent notification for the accepting user (appears in their history)
            const userNotifRes = await client.query(
                `INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata)
                 VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
                [
                    userId,
                    userId, // self-action
                    "company_connection_accepted",
                    `You are now connected with ${company.name}`,
                    companyId,
                    JSON.stringify({ org_id: companyId })
                ]
            );

            socketService.notifyUser(userId, "notification", {
                type: "company_connection_accepted",
                text: `You are now connected with ${company.name}`,
                from: companyId,
                senderName: company.name,
                senderAvatar: company.logo_url,
                referenceId: companyId,
                isCompanyRequest: true,
                notification_id: userNotifRes.rows[0].notification_id,
                created_at: userNotifRes.rows[0].created_at.toISOString(),
                time: "Just now"
            });

            // 4b. Persistent notification for company admins
            const adminsRes = await client.query(
                "SELECT user_id FROM organization_members WHERE org_id = $1 AND (role = 'ADMIN' OR role = 'OWNER')",
                [companyId]
            );

            for (const admin of adminsRes.rows) {
                const adminNotifRes = await client.query(
                    `INSERT INTO notifications (user_id, sender_id, type, text, reference_id, recipient_org_id, metadata)
                     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
                    [
                        admin.user_id,
                        userId,
                        "company_connection_accepted",
                        `${user.full_name} accepted the company's connection request`,
                        companyId,
                        companyId,
                        JSON.stringify({ org_id: companyId })
                    ]
                );

                socketService.notifyUser(admin.user_id, "notification", {
                    type: "company_connection_accepted",
                    text: `${user.full_name} accepted the company's connection request`,
                    from: userId,
                    senderName: user.full_name,
                    senderAvatar: user.avatar_url,
                    referenceId: companyId,
                    notification_id: adminNotifRes.rows[0].notification_id,
                    created_at: adminNotifRes.rows[0].created_at.toISOString(),
                    time: "Just now"
                });
            }

            // Update relationships for Socket
            socketService.notifyUser(userId, "relationshipUpdated", { userId: companyId, status: 'connected', type: 'company' });
            for (const admin of adminsRes.rows) {
                socketService.notifyUser(admin.user_id, "relationshipUpdated", { userId: userId, status: 'connected', type: 'company_connection' });
            }

            // Invalidate Cache
            try {
                if (redisClient.isOpen) {
                    await redisClient.del(`user:${userId}:following`);
                    await redisClient.del(`company:${companyId}:followers`);
                    await redisClient.del(`company:${companyId}:connections`);
                }
            } catch (cacheErr) {
                console.warn("[HANDLE_CONNECTION] Cache invalidation failed:", cacheErr.message);
            }

            await client.query('COMMIT');
            res.status(200).json({ status: 'connected', message: "Invitation accepted successfully" });

        } else {
            // Rejected
            await client.query(
                "UPDATE organization_connection_requests SET status = 'rejected', updated_at = NOW() WHERE org_id = $1 AND user_id = $2",
                [companyId, userId]
            );

            socketService.notifyUser(userId, "relationshipUpdated", { userId: companyId, status: 'none', type: 'company' });

            await client.query('COMMIT');
            res.json({ status: 'rejected', message: "Invitation declined" });
        }

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Handle company connection error:", err);
        res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    } finally {
        client.release();
    }
};

/**
 * cancelCompanyConnectionRequest
 */
exports.cancelCompanyConnectionRequest = async (req, res) => {
    let actorScope;

    try {
        actorScope = getOrganizationConnectionActorScope(req);
        assertSocialActorPermission(req, "MANAGE_CONNECTIONS");
    } catch (err) {
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }

    const { companyId } = actorScope;
    const { userId: targetUserId } = req.params;

    try {
        await pool.query(
            "DELETE FROM organization_connection_requests WHERE org_id = $1 AND user_id = $2 AND status = 'pending'",
            [companyId, targetUserId]
        );
        res.json({ success: true, message: "Request cancelled" });
    } catch (err) {
        console.error("Cancel company connection error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

/**
 * removeCompanyConnection
 */
exports.removeCompanyConnection = async (req, res) => {
    let actorScope;

    try {
        actorScope = getOrganizationConnectionActorScope(req);
    } catch (err) {
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }

    const { companyId, userId } = actorScope;
    const { userId: targetUserId } = req.params;

    try {
        const isTargetUser = userId === targetUserId;
        const isOrgManager = req.actor?.type === "ORGANIZATION";

        if (isOrgManager) {
            assertSocialActorPermission(req, "MANAGE_CONNECTIONS");
        } else if (!isTargetUser) {
            return res.status(403).json({ message: "Not authorized to remove this company connection" });
        }
    } catch (err) {
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Delete the connection
        await client.query(
            "DELETE FROM organization_connections WHERE org_id = $1 AND user_id = $2",
            [companyId, targetUserId]
        );

        // 2. Clean up the follow (Ghost Follow prevention)
        await client.query(
            "DELETE FROM organization_followers WHERE user_id = $1 AND org_id = $2",
            [targetUserId, companyId]
        );

        // 3. Clean up the request record (any status: pending, accepted, rejected, blocked)
        await client.query(
            "DELETE FROM organization_connection_requests WHERE org_id = $1 AND user_id = $2",
            [companyId, targetUserId]
        );

        await client.query('COMMIT');

        // --- ENHANCED CACHE INVALIDATION ---
        try {
            if (redisClient.isOpen) {
                await redisClient.del(`user:${targetUserId}:following`);
                await redisClient.del(`company:${companyId}:followers`);
                await redisClient.del(`company:${companyId}:connections`);
                console.log(`[REMOVE_CONNECTION] Cache invalidated for user=${targetUserId} and company=${companyId}`);
            }
        } catch (cacheErr) {
            console.warn("[REMOVE_CONNECTION] Cache invalidation failed:", cacheErr.message);
        }

        // Notify both sides
        socketService.notifyUser(targetUserId, "relationshipUpdated", { userId: companyId, status: 'none', type: 'company' });

        res.json({ success: true, message: "Connection removed" });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Remove company connection error:", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

/**
 * getCompanyConnectionStatus
 * Determines the current relationship between a company and a user.
 * authority: organization_connections (for 'connected') -> organization_connection_requests (for 'pending')
 */
exports.getCompanyConnectionStatus = async (req, res) => {
    let actorScope;

    try {
        actorScope = getOrganizationConnectionActorScope(req);
    } catch (err) {
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }

    const { companyId, userId: currentUserId } = actorScope;
    const { userId: targetUserId } = req.params;

    try {
        // 1. Check direct connection
        const connCheck = await pool.query(
            "SELECT 1 FROM organization_connections WHERE org_id = $1 AND user_id = $2",
            [companyId, targetUserId]
        );

        if (connCheck.rowCount > 0) {
            return res.json({ status: 'connected' });
        }

        // 1b. Check if user is a follower (Follower = Connected in this UI)
        const followCheck = await pool.query(
            "SELECT 1 FROM organization_followers WHERE org_id = $1 AND user_id = $2",
            [companyId, targetUserId]
        );

        if (followCheck.rowCount > 0) {
            return res.json({ status: 'connected' });
        }

        // 2. Check for pending or existing requests
        const reqCheck = await pool.query(
            "SELECT status, initiated_by FROM organization_connection_requests WHERE org_id = $1 AND user_id = $2",
            [companyId, targetUserId]
        );

        if (reqCheck.rowCount > 0) {
            const request = reqCheck.rows[0];

            if (request.status === 'pending') {
                // If the company initiated it, and the requester is an admin or the target user.
                // Logic: 
                // - If currentUserId is targetUserId -> 'pending_received'
                // - If currentUserId is NOT targetUserId -> 'pending_sent' (assuming they belong to company)
                return res.json({
                    status: currentUserId === targetUserId ? 'pending_received' : 'pending_sent'
                });
            }

            if (request.status === 'accepted') {
                // Should have been caught by connCheck, but for safety:
                return res.json({ status: 'connected' });
            }

            return res.json({ status: request.status === 'rejected' ? 'none' : request.status });
        }

        res.json({ status: 'none' });
    } catch (err) {
        console.error("Get company connection status error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

/**
 * Internal Profile Sharing
 * POST /api/profile/share
 * Body: { profileId, profileType, receiverId, receiverType, message, senderCompanyId? }
 */

// ─── Message Reactions ───────────────────────────────────────────────────────

/**
 * Upsert (add or update) a reaction on a message.
 * POST /messages/:messageId/reactions
 * Body: { emoji } — emoji is optional; empty/absent clears the reaction (sets emoji = '')
 */
exports.upsertReaction = async (req, res) => {
    const userId = req.user.sub || req.user.user_id;
    const { messageId } = req.params;
    const { emoji } = req.body;

    if (!messageId) {
        return res.status(400).json({ message: "messageId is required" });
    }

    try {
        // Verify the message exists and get its conversation_id for socket notification
        const msgRes = await pool.query(
            `SELECT conversation_id FROM messages WHERE message_id = $1`,
            [messageId]
        );

        if (msgRes.rowCount === 0) {
            return res.status(404).json({ message: "Message not found" });
        }

        const { conversation_id } = msgRes.rows[0];

        // Determine if this is a clear (empty emoji) or a real reaction
        const emojiValue = (typeof emoji === "string" && emoji.trim() !== "") ? emoji.trim() : "";

        if (emojiValue !== "") {
            // Upsert: insert new reaction or update emoji if user already reacted
            await pool.query(
                `INSERT INTO message_reactions (message_id, user_id, emoji)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (message_id, user_id)
                 DO UPDATE SET emoji = $3, updated_at = now()`,
                [messageId, userId, emojiValue]
            );

            // Fetch the upserted reaction with user info
            const reactionRes = await pool.query(
                `SELECT
                    mr.reaction_id,
                    mr.message_id,
                    mr.user_id,
                    mr.emoji,
                    mr.created_at,
                    mr.updated_at,
                    u.full_name AS user_full_name,
                    u.avatar_url AS user_avatar
                 FROM message_reactions mr
                 JOIN users u ON u.user_id = mr.user_id
                 WHERE mr.message_id = $1 AND mr.user_id = $2`,
                [messageId, userId]
            );

            const reaction = reactionRes.rows[0];

            // Notify all conversation participants via socket
            socketService.notifyConversation(conversation_id, "message_reaction_updated", {
                messageId,
                conversationId: conversation_id,
                reaction
            });

            return res.json({ success: true, reaction });
        } else {
            // Empty emoji — clear the reaction (set emoji = '')
            await pool.query(
                `UPDATE message_reactions
                 SET emoji = '', updated_at = now()
                 WHERE message_id = $1 AND user_id = $2`,
                [messageId, userId]
            );

            // Notify all conversation participants via socket
            socketService.notifyConversation(conversation_id, "message_reaction_updated", {
                messageId,
                conversationId: conversation_id,
                reaction: null
            });

            return res.json({ success: true, reaction: null });
        }
    } catch (err) {
        console.error("Upsert reaction error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};
