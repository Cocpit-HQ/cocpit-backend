const { stat } = require("node:fs");
const pool = require("../../core/db/pool");
const redisClient = require("../../core/db/redis"); // Added for cache invalidation
const { connected } = require("node:process");
const { formatDistanceToNow } = require('date-fns');
const socketService = require("../../core/infrastructure/socket.service");
const { hasActorPermission } = require("../../core/middlewares/actor-context.middleware");
const { logAudit } = require("../../core/infrastructure/audit.service");
const { markConversationAsRead } = require("../../services/conversationRead.service");
const {
    getConversationMuteState,
    updateConversationMuteState: persistConversationMuteState,
} = require("../../services/conversationMute.service");
const { sendToUser: sendPush } = require("../notification/notification.service");

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

const notifyConversationPreferenceUpdate = async ({ conversationId, userId, companyId, muteState }) => {
    const payload = {
        conversationId,
        companyId: companyId || null,
        preference: {
            is_muted: muteState.isMuted,
            muted_until: muteState.mutedUntil,
            mute_updated_at: muteState.muteUpdatedAt,
        },
    };

    if (companyId) {
        const members = await pool.query(
            `SELECT user_id FROM organization_members WHERE org_id = $1 AND status = 'ACTIVE'`,
            [companyId]
        );

        for (const member of members.rows) {
            socketService.notifyUser(member.user_id, "conversation_preference_updated", payload);
        }
        return;
    }

    socketService.notifyUser(userId, "conversation_preference_updated", payload);
};

// Follow another user
exports.followUser = async (req, res) => {
    const followerId = req.user.sub;
    const followingId = req.params.id; // The person I am trying to follow
    const { sourcePostId } = req.body || {}; // Analytics tracking

    if (followerId === followingId)
        return res.status(400).json({ message: "Cannot follow yourself" });

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Insert Follow
        const followResult = await client.query(
            `INSERT INTO followers (follower_id, following_id, source_post_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING *`,
            [followerId, followingId, sourcePostId || null]
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
            text: "started following you",
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
        // Push notification for offline devices
        sendPush(followingId, followNotifData.senderName, followNotifData.text, { type: 'follow', userId: followerId }).catch(() => {});

        // Logic for Connection Notification (if mutual)
        if (isConnected) {
            const connectionNotifData = {
                type: "connection_accepted", // Reusing this type for "New Connection" UI treatment
                text: "and you are now connected!",
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
        let result = await client.query(
            `DELETE FROM followers WHERE follower_id = $1 AND following_id = $2 RETURNING *`,
            [followerId, userId]
        );

        if (result.rowCount === 0) {
            // Check if the follower is actually an organization
            result = await client.query(
                `DELETE FROM organization_user_follows WHERE org_id = $1 AND user_id = $2 RETURNING *`,
                [followerId, userId]
            );

            if (result.rowCount === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ message: "This user or company is not following you" });
            }
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
    const { sourcePostId } = req.body || {};

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const result = await client.query(
            `INSERT INTO organization_followers (user_id, org_id, source_post_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING *`,
            [userId, companyId, sourcePostId || null]
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
    const companyId = req.params.companyId || req.params.orgId;

    try {
        // When acting as an organization, "is following" must reflect the acting
        // org's own follow (organization_org_follows), not the human user's
        // personal follow row — those are tracked independently.
        if (req.actor?.type === "ORGANIZATION") {
            const result = await pool.query(
                `SELECT
                    (SELECT 1 FROM organization_org_follows WHERE follower_org_id = $1 AND following_org_id = $2) as is_following,
                    (SELECT COUNT(*) FROM organization_followers WHERE org_id = $2) as follower_count`,
                [req.actor.orgId, companyId]
            );

            return res.json({
                isFollowing: !!result.rows[0]?.is_following,
                followerCount: parseInt(result.rows[0]?.follower_count || 0)
            });
        }

        const userId = req.user.sub;
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
        const isOwnOrgActor = req.actor && req.actor.type === "ORGANIZATION" && req.actor.orgId === companyId;

        if (!isOwnOrgActor) {
            const privacyRes = await pool.query(
                `SELECT followers_visibility FROM organization_privacy_settings WHERE org_id = $1`,
                [companyId]
            );
            const followersVisibility = privacyRes.rows[0]?.followers_visibility || "everyone";

            if (followersVisibility === "no_one") {
                return res.status(200).json({ success: true, data: [], is_restricted: true, message: "The business page owner has restricted access to their followers." });
            } else if (followersVisibility === "followers_only") {
                let isFollower = false;
                if (req.actor && req.actor.type === "ORGANIZATION" && req.actor.orgId) {
                    const check = await pool.query(
                        `SELECT 1 FROM organization_org_follows WHERE following_org_id = $1 AND follower_org_id = $2`,
                        [companyId, req.actor.orgId]
                    );
                    isFollower = check.rowCount > 0;
                } else if (req.user?.sub) {
                    const check = await pool.query(
                        `SELECT 1 FROM organization_followers WHERE org_id = $1 AND user_id = $2`,
                        [companyId, req.user.sub]
                    );
                    isFollower = check.rowCount > 0;
                }
                if (!isFollower) {
                    return res.status(200).json({ success: true, data: [], is_restricted: true, message: "The business page owner has restricted access to their followers." });
                }
            }
        }
        let userQuery = `
            SELECT u.user_id, u.full_name, u.headline, u.avatar_url, cf.created_at as followed_at,
                   EXISTS(
                       SELECT 1 FROM organization_user_follows ouf
                       WHERE ouf.org_id = $1 AND ouf.user_id = u.user_id
                   ) as is_followed_back,
                   'user' as type
            FROM organization_followers cf
            JOIN active_users u ON cf.user_id = u.user_id
            WHERE cf.org_id = $1
        `;

        // Organizations follow other organizations via organization_org_follows,
        // a separate table from the user-level organization_followers — without
        // this branch, companies that follow an org never show up as followers.
        let companyQuery = `
            SELECT c.org_id as user_id, c.name as full_name, c.industry as headline, c.logo_url as avatar_url, cf.created_at as followed_at,
                   EXISTS(
                       SELECT 1 FROM organization_org_follows back_f
                       WHERE back_f.follower_org_id = $1 AND back_f.following_org_id = c.org_id
                   ) as is_followed_back,
                   'company' as type
            FROM organization_org_follows cf
            JOIN organizations c ON cf.follower_org_id = c.org_id
            WHERE cf.following_org_id = $1 AND c.is_deleted = FALSE
        `;

        const params = [companyId];

        if (search && search.trim()) {
            userQuery += ` AND (u.full_name ILIKE $2 OR u.headline ILIKE $2)`;
            companyQuery += ` AND (c.name ILIKE $2 OR c.industry ILIKE $2)`;
            params.push(`%${search.trim()}%`);
        }

        const fullQuery = `(${userQuery}) UNION ALL (${companyQuery}) ORDER BY followed_at DESC`;
        const result = await pool.query(fullQuery, params);

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
    let userId = req.params.id;
    const requesterId = req.user.sub;
    const { search } = req.query;
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

        // Build UNION query: users following this user + companies following this user
        let userQuery = `
            SELECT u.user_id, u.full_name, u.avatar_url, u.headline, f.created_at, 'user' as type, NULL as slug,
                   (EXISTS (SELECT 1 FROM followers WHERE follower_id = $2 AND following_id = u.user_id)) as is_following_back
            FROM followers f 
            JOIN active_users u ON f.follower_id = u.user_id 
            WHERE f.following_id = $1
        `;

        let companyQuery = `
            SELECT o.org_id as user_id, o.name as full_name, o.logo_url as avatar_url, o.slogan as headline, ouf.created_at, 'company' as type, o.slug,
                   (EXISTS (SELECT 1 FROM organization_followers WHERE user_id = $2 AND org_id = o.org_id)) as is_following_back
            FROM organization_user_follows ouf
            JOIN organizations o ON ouf.org_id = o.org_id
            WHERE ouf.user_id = $1 AND o.is_deleted = FALSE
        `;

        const params = [userId, requesterId];

        if (search) {
            userQuery += ` AND (u.full_name ILIKE $3 OR u.headline ILIKE $3)`;
            companyQuery += ` AND (o.name ILIKE $3 OR o.slogan ILIKE $3)`;
            params.push(`%${search}%`);
        }

        // Apply block filtering to user followers
        userQuery += ` 
            AND NOT EXISTS (
                SELECT 1 FROM blocks b 
                WHERE b.is_org_block = false
                  AND ((b.blocker_id = $2 AND b.blocked_id = u.user_id)
                    OR (b.blocker_id = u.user_id AND b.blocked_id = $2))
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
    let userId = req.params.id;
    const { search } = req.query;
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

        // Build UNION query: users the person follows + companies the person follows
        let userQuery = `
            SELECT u.user_id, u.full_name, u.avatar_url, u.headline, f.created_at, 'user' as type, NULL as slug
            FROM followers f
            JOIN active_users u ON f.following_id = u.user_id
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
                WHERE b.is_org_block = false
                  AND ((b.blocker_id = $${viewerIdx} AND b.blocked_id = u.user_id)
                    OR (b.blocker_id = u.user_id AND b.blocked_id = $${viewerIdx}))
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
            `SELECT 
                (
                    SELECT COUNT(*) 
                    FROM followers f
                    JOIN active_users u ON f.follower_id = u.user_id
                    WHERE f.following_id = $1
                      AND NOT EXISTS (
                          SELECT 1 FROM blocks b
                          WHERE (b.blocker_id = $1 AND b.blocked_id = u.user_id)
                             OR (b.blocker_id = u.user_id AND b.blocked_id = $1)
                      )
                ) + 
                (
                    SELECT COUNT(*) 
                    FROM organization_user_follows ouf 
                    JOIN organizations o ON ouf.org_id = o.org_id 
                    WHERE ouf.user_id = $1 AND o.is_deleted = FALSE
                ) 
             as count`,
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
    const { message } = req.body || {};

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

        // 4. Rate Limiting (Max 50 requests per 10h)
        const rateLimitCheck = await client.query(
            `SELECT COUNT(*) FROM connection_requests 
             WHERE sender_id = $1 AND created_at > NOW() - INTERVAL '10 hours'`,
            [senderId]
        );

        if (parseInt(rateLimitCheck.rows[0].count) >= 50) {
            await client.query("ROLLBACK");
            return res.status(429).json({ message: "Connection request limit reached. Please try again after 10 hours." });
        }


        // 5. Clean up any stale 'connected' or expired 'rejected' rows from previous cycles
        // These rows block the INSERT below due to the UNIQUE constraint on (sender_id, receiver_id)
        await client.query(
            `DELETE FROM connection_requests 
             WHERE ((sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1))
             AND (status = 'connected' OR (status = 'rejected' AND (cooldown_until IS NULL OR cooldown_until <= NOW())))`,
            [senderId, receiverId]
        );

        // 5.5 Determine reason_tag dynamically
        const reasonTagResult = await client.query(
            `
            SELECT
                (SELECT ed.school_name
                 FROM educations ed
                 JOIN profiles p ON p.profile_id = ed.profile_id
                 WHERE p.user_id = $1
                   AND LOWER(TRIM(ed.school_name)) IN (
                       SELECT LOWER(TRIM(ed2.school_name)) FROM educations ed2
                       JOIN profiles p2 ON p2.profile_id = ed2.profile_id
                       WHERE p2.user_id = $2
                   )
                 LIMIT 1
                ) AS shared_school,
                (SELECT e.company_name
                 FROM experiences e
                 JOIN profiles p ON p.profile_id = e.profile_id
                 WHERE p.user_id = $1
                   AND LOWER(TRIM(e.company_name)) IN (
                       SELECT LOWER(TRIM(e2.company_name)) FROM experiences e2
                       JOIN profiles p2 ON p2.profile_id = e2.profile_id
                       WHERE p2.user_id = $2
                   )
                 ORDER BY e.is_current DESC NULLS LAST
                 LIMIT 1
                ) AS shared_company,
                (SELECT s.name
                 FROM user_skills us
                 JOIN profiles p ON p.profile_id = us.profile_id
                 JOIN skills s ON s.skill_id = us.skill_id
                 WHERE p.user_id = $1
                   AND us.skill_id IN (
                       SELECT us2.skill_id FROM user_skills us2
                       JOIN profiles p2 ON p2.profile_id = us2.profile_id
                       WHERE p2.user_id = $2
                   )
                 LIMIT 1
                ) AS shared_skill
            `,
            [senderId, receiverId]
        );

        let reasonTag = null;
        if (reasonTagResult.rowCount > 0) {
            const row = reasonTagResult.rows[0];
            if (row.shared_school) {
                reasonTag = `Both attended ${row.shared_school}`;
            } else if (row.shared_company) {
                reasonTag = `Both work at ${row.shared_company}`;
            } else if (row.shared_skill) {
                reasonTag = `Shared interest in ${row.shared_skill}`;
            }
        }

        // 6. Create New Request
        // We use ON CONFLICT DO NOTHING to be super safe against race conditions on the unique index
        const insertRes = await client.query(
            `INSERT INTO connection_requests (sender_id, receiver_id, message, reason_tag, status) 
             VALUES ($1, $2, $3, $4, 'pending')
             ON CONFLICT (sender_id, receiver_id) 
             DO NOTHING
             RETURNING request_id`,
            [senderId, receiverId, message || null, reasonTag]
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
            text: "sent you a connection request",
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
        // Push notification for offline devices
        sendPush(receiverId, sender.full_name, completeNotification.text, { type: 'connection_request', userId: senderId }).catch(() => {});

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
    const userId = req.user.sub;
    const { type = 'received' } = req.query;  // 'received' | 'sent'
    const page = Math.max(1, parseInt(req.query.page || '1'));
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '10')));
    const offset = (page - 1) * limit;

    try {
        let query, params;

        if (type === 'sent') {
            // ── SENT: outgoing pending requests (I am the sender) ──────────────
            query = `
                SELECT
                    cr.request_id   AS id,
                    cr.sender_id,
                    cr.receiver_id,
                    cr.reason_tag,
                    cr.created_at,
                    u.full_name     AS name,
                    u.avatar_url    AS avatar,
                    u.headline,
                    false           AS is_company_request,
                    NULL            AS slug,
                    0               AS mutual_count,
                    ARRAY[]::TEXT[] AS mutual_avatars
                FROM connection_requests cr
                JOIN active_users u ON cr.receiver_id = u.user_id
                WHERE cr.sender_id = $1
                  AND LOWER(cr.status::text) = 'pending'
                ORDER BY cr.created_at DESC
                LIMIT $2 OFFSET $3
            `;
            params = [userId, limit, offset];

        } else {
            // ── RECEIVED: incoming pending requests (I am the receiver) ─────────
            query = `
                (SELECT
                    cr.request_id   AS id,
                    cr.sender_id,
                    cr.receiver_id,
                    cr.reason_tag,
                    cr.created_at,
                    u.full_name     AS name,
                    u.avatar_url    AS avatar,
                    u.headline,
                    false           AS is_company_request,
                    NULL            AS slug,
                    -- Mutual connection count
                    (
                        SELECT COUNT(*)
                        FROM connections c1
                        JOIN connections c2 ON c1.connected_user_id = c2.connected_user_id
                        WHERE c1.user_id = cr.sender_id
                          AND c2.user_id = $1
                    ) AS mutual_count,
                    -- Up to 3 mutual avatar URLs
                    ARRAY(
                        SELECT u2.avatar_url
                        FROM connections c1
                        JOIN connections c2 ON c1.connected_user_id = c2.connected_user_id
                        JOIN active_users u2        ON u2.user_id = c1.connected_user_id
                        WHERE c1.user_id = cr.sender_id
                          AND c2.user_id = $1
                          AND u2.avatar_url IS NOT NULL
                        LIMIT 3
                    ) AS mutual_avatars
                FROM connection_requests cr
                JOIN active_users u ON cr.sender_id = u.user_id
                WHERE cr.receiver_id = $1
                  AND LOWER(cr.status::text) = 'pending')
                UNION ALL
                (SELECT
                    ccr.request_id    AS id,
                    ccr.org_id        AS sender_id,
                    ccr.user_id       AS receiver_id,
                    NULL              AS reason_tag,
                    ccr.created_at,
                    c.name            AS name,
                    c.logo_url        AS avatar,
                    c.industry        AS headline,
                    true              AS is_company_request,
                    c.slug,
                    0                 AS mutual_count,
                    ARRAY[]::TEXT[]   AS mutual_avatars
                FROM organization_connection_requests ccr
                JOIN organizations c ON ccr.org_id = c.org_id
                WHERE ccr.user_id = $1
                  AND LOWER(ccr.status::text) = 'pending')
                ORDER BY created_at DESC
                LIMIT $2 OFFSET $3
            `;
            params = [userId, limit, offset];
        }

        // Total count (for pagination metadata)
        let countQuery, countParams;
        if (type === 'sent') {
            countQuery = `
                SELECT COUNT(*) FROM connection_requests cr
                JOIN active_users u ON cr.receiver_id = u.user_id
                WHERE cr.sender_id = $1 AND LOWER(cr.status::text) = 'pending'
            `;
            countParams = [userId];
        } else {
            countQuery = `
                SELECT
                    (SELECT COUNT(*) FROM connection_requests cr JOIN active_users u ON cr.sender_id = u.user_id WHERE cr.receiver_id = $1 AND LOWER(cr.status::text) = 'pending')
                  + (SELECT COUNT(*) FROM organization_connection_requests ocr WHERE ocr.user_id = $1 AND LOWER(ocr.status::text) = 'pending')
                AS count
            `;
            countParams = [userId];
        }

        const [result, countResult] = await Promise.all([
            pool.query(query, params),
            pool.query(countQuery, countParams),
        ]);

        const totalCount = parseInt(countResult.rows[0]?.count || 0);

        const requests = result.rows.map(row => ({
            id: row.id,
            sender_id: row.sender_id,
            receiver_id: row.receiver_id,
            created_at: row.created_at,
            status: 'pending',
            reason_tag: row.reason_tag || null,
            isCompanyRequest: row.is_company_request,
            mutuals: {
                count: parseInt(row.mutual_count || 0),
                avatars: row.mutual_avatars || [],
            },
            // 'user' is always the OTHER person (sender if received, recipient if sent)
            user: {
                name: row.name,
                avatar: row.avatar,
                headline: row.headline,
                slug: row.slug || null,
            },
        }));

        return res.status(200).json({
            data: requests,
            totalCount,
            page,
            limit,
        });

    } catch (err) {
        console.error('Get pending requests error:', err);
        return res.status(500).json({ message: 'Internal server error' });
    }
};




// ─── getConnectionCounts ────────────────────────────────────────────────────
exports.getConnectionCounts = async (req, res) => {
    const userId = req.user.sub;
    try {
        const userEmailRes = await pool.query(`SELECT email FROM users WHERE user_id = $1`, [userId]);
        const userEmail = userEmailRes.rows[0]?.email || '';

        const result = await pool.query(`
            SELECT
                (
                    (SELECT COUNT(*) FROM connection_requests cr
                     JOIN active_users u ON cr.sender_id = u.user_id
                     WHERE cr.receiver_id = $1 AND LOWER(cr.status::text) = 'pending') +
                    (SELECT COUNT(*) FROM organization_connection_requests ccr
                     JOIN organizations c ON ccr.org_id = c.org_id
                     WHERE ccr.user_id = $1 AND LOWER(ccr.status::text) = 'pending')
                ) AS received,
                (
                    SELECT COUNT(*) FROM connection_requests cr
                    JOIN active_users u ON cr.receiver_id = u.user_id
                    WHERE cr.sender_id = $1 AND LOWER(cr.status::text) = 'pending'
                ) AS sent,
                (
                    SELECT COUNT(*) FROM organization_invites oi
                    JOIN organizations o ON oi.org_id = o.org_id
                    WHERE (oi.invited_user_id = $1 OR LOWER(oi.email) = LOWER($2))
                      AND LOWER(oi.status::text) = 'pending' AND oi.expires_at > NOW()
                ) AS teams_invitations,
                (
                    SELECT COUNT(*) FROM community_invitations ci
                    JOIN communities c ON ci.community_id = c.community_id
                    JOIN organizations o ON c.org_id = o.org_id
                    WHERE ci.invitee_id = $1 AND LOWER(ci.status::text) = 'pending'
                      AND COALESCE(ci.is_active, TRUE) = TRUE AND COALESCE(c.is_active, TRUE) = TRUE
                ) AS channels_invitations
        `, [userId, userEmail]);

        const row = result.rows[0];
        const teamsInvitations = parseInt(row?.teams_invitations || 0);
        const channelsInvitations = parseInt(row?.channels_invitations || 0);
        const invitations = teamsInvitations + channelsInvitations;

        return res.status(200).json({
            received: parseInt(row?.received || 0),
            sent: parseInt(row?.sent || 0),
            invitations,
            teamsInvitations,
            channelsInvitations,
        });
    } catch (err) {
        console.error('Get connection counts error:', err);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

// ─── getConnectionSuggestions ───────────────────────────────────────────────
exports.getConnectionSuggestions = async (req, res) => {
    const userId = req.user.sub;
    const limit = Math.min(20, Math.max(1, parseInt(req.query.limit || '8')));

    try {
        const result = await pool.query(`
            WITH
                -- Users I already know (connected, sent/received request, blocked, or self)
                excluded AS (
                    SELECT connected_user_id AS uid FROM connections WHERE user_id = $1
                    UNION
                    SELECT receiver_id AS uid FROM connection_requests
                           WHERE sender_id = $1 AND status IN ('pending','blocked')
                    UNION
                    SELECT sender_id AS uid FROM connection_requests
                           WHERE receiver_id = $1 AND status = 'blocked'
                    UNION
                    SELECT $1::UUID AS uid
                ),

                -- Signal 1: 2nd-degree connections (friend-of-a-friend), score = shared count
                second_degree AS (
                    SELECT
                        c2.connected_user_id AS suggest_id,
                        COUNT(*)             AS score,
                        'mutual'::TEXT       AS reason
                    FROM connections c1
                    JOIN connections c2 ON c1.connected_user_id = c2.user_id
                    WHERE c1.user_id = $1
                      AND c2.connected_user_id NOT IN (SELECT uid FROM excluded)
                    GROUP BY c2.connected_user_id
                ),

                -- Signal 2: Same current company (from experiences table)
                same_company AS (
                    SELECT
                        p2.user_id     AS suggest_id,
                        3              AS score,
                        'company'::TEXT AS reason
                    FROM experiences e1
                    JOIN profiles p1 ON p1.profile_id = e1.profile_id AND p1.user_id = $1
                    JOIN experiences e2 ON LOWER(TRIM(e2.company_name)) = LOWER(TRIM(e1.company_name))
                                       AND e2.is_current = TRUE
                                       AND e2.profile_id <> e1.profile_id
                    JOIN profiles p2 ON p2.profile_id = e2.profile_id
                    WHERE e1.is_current = TRUE
                      AND p2.user_id NOT IN (SELECT uid FROM excluded)
                ),

                -- Signal 3: Shared skills (via user_skills junction table)
                shared_skills AS (
                    SELECT
                        p2.user_id     AS suggest_id,
                        COUNT(*)       AS score,
                        'skill'::TEXT  AS reason
                    FROM user_skills us1
                    JOIN profiles pr1 ON pr1.profile_id = us1.profile_id AND pr1.user_id = $1
                    JOIN user_skills us2 ON us2.skill_id = us1.skill_id
                                        AND us2.profile_id <> us1.profile_id
                    JOIN profiles p2 ON p2.profile_id = us2.profile_id
                    WHERE p2.user_id NOT IN (SELECT uid FROM excluded)
                    GROUP BY p2.user_id
                ),

                -- Signal 4: Same city/location (from users.location_city)
                same_city AS (
                    SELECT
                        u2.user_id     AS suggest_id,
                        1              AS score,
                        'city'::TEXT   AS reason
                    FROM users u1
                    JOIN active_users u2 ON LOWER(TRIM(u2.location_city)) = LOWER(TRIM(u1.location_city))
                                 AND u2.user_id <> u1.user_id
                    WHERE u1.user_id = $1
                      AND u1.location_city IS NOT NULL
                      AND u2.user_id NOT IN (SELECT uid FROM excluded)
                ),

                -- Union all signals, pick the highest score + best reason per user
                ranked AS (
                    SELECT
                        suggest_id,
                        SUM(score) AS total_score,
                        (ARRAY_AGG(reason ORDER BY score DESC))[1] AS top_reason
                    FROM (
                        SELECT suggest_id, score, reason FROM second_degree
                        UNION ALL
                        SELECT suggest_id, score, reason FROM same_company
                        UNION ALL
                        SELECT suggest_id, score, reason FROM shared_skills
                        UNION ALL
                        SELECT suggest_id, score, reason FROM same_city
                    ) all_signals
                    GROUP BY suggest_id
                )

            SELECT
                u.user_id,
                u.full_name,
                u.avatar_url,
                u.headline,
                r.top_reason                AS reason_signal,
                -- Mutual count for display
                (
                    SELECT COUNT(*)
                    FROM connections c1
                    JOIN connections c2 ON c1.connected_user_id = c2.connected_user_id
                    WHERE c1.user_id = r.suggest_id AND c2.user_id = $1
                ) AS mutual_count,
                -- Up to 3 mutual avatar URLs
                ARRAY(
                    SELECT u2.avatar_url
                    FROM connections c1
                    JOIN connections c2 ON c1.connected_user_id = c2.connected_user_id
                    JOIN active_users u2 ON u2.user_id = c1.connected_user_id
                    WHERE c1.user_id = r.suggest_id AND c2.user_id = $1
                      AND u2.avatar_url IS NOT NULL
                    LIMIT 3
                ) AS mutual_avatars,
                -- Current company name
                (
                    SELECT e.company_name FROM experiences e
                    JOIN profiles p ON p.profile_id = e.profile_id AND p.user_id = u.user_id
                    WHERE e.is_current = TRUE LIMIT 1
                ) AS works_at,
                -- Latest school name
                (
                    SELECT ed.school_name FROM educations ed
                    JOIN profiles p ON p.profile_id = ed.profile_id AND p.user_id = u.user_id
                    ORDER BY ed.created_at DESC LIMIT 1
                ) AS studied_at,
                -- Shared skill names (up to 3) when reason = skill
                ARRAY(
                    SELECT s.name
                    FROM user_skills us1
                    JOIN profiles pr1 ON pr1.profile_id = us1.profile_id AND pr1.user_id = $1
                    JOIN user_skills us2 ON us2.skill_id = us1.skill_id
                    JOIN profiles pr2 ON pr2.profile_id = us2.profile_id AND pr2.user_id = u.user_id
                    JOIN skills s ON s.skill_id = us1.skill_id
                    LIMIT 3
                ) AS shared_skills
            FROM ranked r
            JOIN active_users u ON u.user_id = r.suggest_id
            WHERE NOT EXISTS (
                SELECT 1 FROM blocks
                WHERE is_org_block = false
                  AND ((blocker_id = $1 AND blocked_id = u.user_id)
                    OR (blocker_id = u.user_id AND blocked_id = $1))
            )
            ORDER BY r.total_score DESC
            LIMIT $2
        `, [userId, limit]);

        const suggestions = result.rows.map(row => ({
            id: row.user_id,
            name: row.full_name,
            avatarUrl: row.avatar_url,
            headline: row.headline,
            reasonSignal: row.reason_signal || null,
            mutuals: {
                count: parseInt(row.mutual_count || 0),
                avatars: row.mutual_avatars || [],
            },
            worksAt: row.works_at || null,
            studiedAt: row.studied_at || null,
            sharedSkills: row.shared_skills || [],
        }));

        return res.status(200).json({ data: suggestions });

    } catch (err) {
        console.error('Get connection suggestions error:', err);
        return res.status(500).json({ message: 'Internal server error' });
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
            LEFT JOIN active_users u_send ON cr.sender_id = u_send.user_id
            LEFT JOIN active_users u_recv ON cr.receiver_id = u_recv.user_id
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
            // Push notification for offline devices
            // Note: senderNotification.senderName comes from req.user.full_name which is not in the JWT.
            // The accepter's name must be fetched from the DB. We query it here for the push title.
            pool.query(`SELECT full_name FROM users WHERE user_id = $1`, [receiver_id])
                .then(r => {
                    const accepterName = r.rows[0]?.full_name || "Someone";
                    sendPush(sender_id, accepterName, senderNotification.text, { type: 'connection_accepted', userId: receiver_id }).catch(() => {});
                })
                .catch(() => {});

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
            JOIN active_users u ON c.connected_user_id = u.user_id 
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
                WHERE b.is_org_block = false
                  AND ((b.blocker_id = $1 AND b.blocked_id = u.user_id)
                    OR (b.blocker_id = u.user_id AND b.blocked_id = $1))
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

exports.getConnections = async (req, res) => {
    let targetUserId = req.params.id;
    const requesterId = req.user ? req.user.sub : null;
    const { search } = req.query;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    try {
        if (!uuidRegex.test(targetUserId)) {
            const resolveResult = await pool.query(
                "SELECT user_id FROM users WHERE LOWER(account_name) = LOWER($1)",
                [targetUserId]
            );
            if (resolveResult.rowCount === 0) {
                return res.status(404).json({ message: "User not found" });
            }
            targetUserId = resolveResult.rows[0].user_id;
        }

        let userQuery = `
            SELECT u.user_id, u.full_name, u.avatar_url, u.headline, c.created_at, 'user' as type, NULL as slug
            FROM connections c 
            JOIN active_users u ON c.connected_user_id = u.user_id 
            WHERE c.user_id = $1
        `;

        let companyQuery = `
            SELECT c.org_id as user_id, c.name as full_name, c.logo_url as avatar_url, c.industry as headline, cc.created_at, 'company' as type, c.slug
            FROM organization_connections cc
            JOIN organizations c ON cc.org_id = c.org_id
            WHERE cc.user_id = $1
              AND c.is_deleted = FALSE
        `;

        const params = [targetUserId];
        let paramIdx = 2;

        if (search) {
            userQuery += ` AND (u.full_name ILIKE $${paramIdx} OR u.headline ILIKE $${paramIdx})`;
            companyQuery += ` AND (c.name ILIKE $${paramIdx} OR c.industry ILIKE $${paramIdx})`;
            params.push(`%${search}%`);
            paramIdx++;
        }

        if (requesterId) {
            params.push(requesterId);
            userQuery += `
                AND NOT EXISTS (
                    SELECT 1 FROM blocks b 
                    WHERE (b.blocker_id = $${paramIdx} AND b.blocked_id = u.user_id)
                       OR (b.blocker_id = u.user_id AND b.blocked_id = $${paramIdx})
                )
            `;
        }

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
        console.error("Get connections error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.getConnectionCount = async (req, res) => {
    const userId = req.params.id;

    try {
        const result = await pool.query(
            `SELECT 
                (
                    SELECT COUNT(*) 
                    FROM connections c
                    JOIN active_users u ON c.connected_user_id = u.user_id
                    WHERE c.user_id = $1
                      AND NOT EXISTS (
                          SELECT 1 FROM blocks b 
                          WHERE (b.blocker_id = $1 AND b.blocked_id = u.user_id)
                             OR (b.blocker_id = u.user_id AND b.blocked_id = $1)
                      )
                ) + 
                (
                    SELECT COUNT(*) 
                    FROM organization_connections cc 
                    JOIN organizations c ON cc.org_id = c.org_id 
                    WHERE cc.user_id = $1 AND c.is_deleted = FALSE
                ) as count`,
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
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    let actorScope;

    try {
        actorScope = getSocialActorScope(req, req.query.companyId || null);
    } catch (err) {
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }

    const { userId, orgId: companyId } = actorScope;
    const tabParam = req.query.tab
        ? (req.query.tab.toUpperCase() === "JOBS" ? true : req.query.tab.toUpperCase() === "GENERAL" ? false : null)
        : null;

    try {
        const result = await pool.query(
            `
SELECT 
    c.*,
    CASE WHEN $2::uuid IS NOT NULL OR cp_other.org_id IS NOT NULL THEN false ELSE c.is_requesting END as is_requesting,
    c.is_job_chat AS "isJobChat",
    -- Block Status
    CASE WHEN c.is_group THEN false ELSE EXISTS (
        SELECT 1 FROM blocks b 
        JOIN conversation_participants cp_b ON cp_b.conversation_id = c.conversation_id 
        WHERE b.blocker_id = COALESCE($2, $1) 
          AND (
            (cp_b.user_id IS NOT NULL AND ($2::uuid IS NOT NULL OR cp_b.user_id != $1) AND ($2::uuid IS NULL OR cp_b.org_id IS NULL OR cp_b.org_id != $2) AND b.blocked_id = cp_b.user_id)
            OR
            (cp_b.org_id IS NOT NULL AND ($2::uuid IS NULL OR cp_b.org_id != $2) AND b.blocked_id = cp_b.org_id)
          )
    ) END as is_blocked_by_me,
    CASE WHEN c.is_group THEN false ELSE (
        EXISTS (
            SELECT 1 FROM blocks b 
            JOIN conversation_participants cp_b ON cp_b.conversation_id = c.conversation_id 
            WHERE b.blocked_id = COALESCE($2, $1) 
              AND (
                (cp_b.user_id IS NOT NULL AND ($2::uuid IS NOT NULL OR cp_b.user_id != $1) AND ($2::uuid IS NULL OR cp_b.org_id IS NULL OR cp_b.org_id != $2) AND b.blocker_id = cp_b.user_id)
                OR
                (cp_b.org_id IS NOT NULL AND ($2::uuid IS NULL OR cp_b.org_id != $2) AND b.blocker_id = cp_b.org_id)
              )
        )
        OR
        (cp_other.org_id IS NOT NULL AND COALESCE(raw_comp.is_deactivated, false) = true)
        OR
        (cp_other.user_id IS NOT NULL AND COALESCE(raw_u.is_deactivated, false) = true)
    ) END as is_blocked_by_other,

    -- Name logic: Use group name if group, else other participant's name (User or Company)
    CASE 
        WHEN c.is_group THEN COALESCE(cp.left_group_name, c.conversation_name, 'Group Chat')
        WHEN (
            EXISTS (
                SELECT 1 FROM blocks b 
                JOIN conversation_participants cp_b ON cp_b.conversation_id = c.conversation_id 
                WHERE b.blocked_id = COALESCE($2, $1) 
                  AND (
                    (cp_b.user_id IS NOT NULL AND ($2::uuid IS NOT NULL OR cp_b.user_id != $1) AND ($2::uuid IS NULL OR cp_b.org_id IS NULL OR cp_b.org_id != $2) AND b.blocker_id = cp_b.user_id)
                    OR
                    (cp_b.org_id IS NOT NULL AND ($2::uuid IS NULL OR cp_b.org_id != $2) AND b.blocker_id = cp_b.org_id)
                  )
            )
        ) THEN CASE WHEN cp_other.org_id IS NOT NULL THEN 'Unknown Page' ELSE 'Unknown User' END
        WHEN cp_other.org_id IS NOT NULL AND (comp.name = 'Deleted Page' OR comp.org_id IS NULL) THEN 'Unknown Page'
        WHEN comp.org_id IS NOT NULL THEN comp.name
        WHEN raw_u.is_deactivated THEN 'Unknown User'
        WHEN u.display_name IS NULL AND comp.org_id IS NULL THEN COALESCE(c.conversation_name, 'Unknown User')
        ELSE u.display_name 
    END AS other_user_name,
    
    -- Avatar logic
    CASE 
        WHEN c.is_group THEN COALESCE(cp.left_group_avatar, c.group_avatar)
        WHEN (
            EXISTS (
                SELECT 1 FROM blocks b 
                JOIN conversation_participants cp_b ON cp_b.conversation_id = c.conversation_id 
                WHERE b.blocked_id = COALESCE($2, $1) 
                  AND (
                    (cp_b.user_id IS NOT NULL AND ($2::uuid IS NOT NULL OR cp_b.user_id != $1) AND ($2::uuid IS NULL OR cp_b.org_id IS NULL OR cp_b.org_id != $2) AND b.blocker_id = cp_b.user_id)
                    OR
                    (cp_b.org_id IS NOT NULL AND ($2::uuid IS NULL OR cp_b.org_id != $2) AND b.blocker_id = cp_b.org_id)
                  )
            )
        ) THEN NULL
        WHEN cp_other.org_id IS NOT NULL AND (comp.logo_url IS NULL OR comp.name = 'Deleted Page') THEN NULL
        WHEN comp.org_id IS NOT NULL THEN comp.logo_url
        WHEN COALESCE(u.display_avatar, raw_u.avatar_url) IS NULL AND comp.org_id IS NULL THEN NULL
        WHEN cp_other.org_id IS NOT NULL THEN NULL
        ELSE COALESCE(u.display_avatar, raw_u.avatar_url)
    END AS other_user_avatar,
    
    -- Other ID (User or Company)
    COALESCE(u.user_id, comp.org_id) AS other_user_id,
    CASE 
        WHEN (
            EXISTS (
                SELECT 1 FROM blocks b 
                JOIN conversation_participants cp_b ON cp_b.conversation_id = c.conversation_id 
                WHERE b.blocked_id = COALESCE($2, $1) 
                  AND (
                    (cp_b.user_id IS NOT NULL AND ($2::uuid IS NOT NULL OR cp_b.user_id != $1) AND ($2::uuid IS NULL OR cp_b.org_id IS NULL OR cp_b.org_id != $2) AND b.blocker_id = cp_b.user_id)
                    OR
                    (cp_b.org_id IS NOT NULL AND ($2::uuid IS NULL OR cp_b.org_id != $2) AND b.blocker_id = cp_b.org_id)
                  )
            )
        ) THEN 'User unavailable'
        WHEN raw_u.is_deactivated THEN 'This user has gone offline - for a while.' 
        ELSE u.display_headline 
    END AS other_user_headline,
    CASE 
        WHEN (
            EXISTS (
                SELECT 1 FROM blocks b 
                JOIN conversation_participants cp_b ON cp_b.conversation_id = c.conversation_id 
                WHERE b.blocked_id = COALESCE($2, $1) 
                  AND (
                    (cp_b.user_id IS NOT NULL AND ($2::uuid IS NOT NULL OR cp_b.user_id != $1) AND ($2::uuid IS NULL OR cp_b.org_id IS NULL OR cp_b.org_id != $2) AND b.blocker_id = cp_b.user_id)
                    OR
                    (cp_b.org_id IS NOT NULL AND ($2::uuid IS NULL OR cp_b.org_id != $2) AND b.blocker_id = cp_b.org_id)
                  )
            )
        ) THEN 'User unavailable'
        ELSE COALESCE(comp.headline, '') 
    END AS org_headline,
    CASE WHEN comp.org_id IS NOT NULL THEN 'COMPANY' ELSE 'USER' END as other_user_type,
    COALESCE(comp.slug, u.display_username) AS other_user_slug,
    
    -- Identify the sender profile for the current view
    cp.is_active,
    cp.is_muted,
    cp.muted_until,
    
    -- Flag for deleted users
    CASE 
        WHEN c.is_group = FALSE AND u.user_id IS NULL AND comp.org_id IS NULL THEN true 
        ELSE false 
    END AS is_deleted_user,

    -- Flag for deactivated users/orgs
    CASE 
        WHEN cp_other.org_id IS NOT NULL THEN COALESCE(raw_comp.is_deactivated, false)
        ELSE COALESCE(raw_u.is_deactivated, false)
    END AS is_deactivated,

    -- Get the most recent message dynamically
    m.message_id AS last_message_id,
    COALESCE(
        m.text_content, 
        CASE 
            WHEN cp.left_at IS NOT NULL THEN 'You left the group' 
            ELSE c.last_message 
        END
    ) AS last_message_text,
    COALESCE(
        m.created_at, 
        CASE 
            WHEN cp.left_at IS NOT NULL THEN cp.left_at 
            ELSE c.last_message_at 
        END, 
        c.updated_at
    ) AS last_message_at,
    m.replied_msg_id AS "replyMessageId",
    m.reply_message,
    COALESCE(cp.left_group_name, c.conversation_name) AS conversation_name,
    COALESCE(cp.left_group_avatar, c.group_avatar) AS group_avatar,
    COALESCE(cp.left_group_description, c.description) AS description,
    COALESCE(cp.left_group_headline, c.group_headline) AS group_headline
FROM conversations c
JOIN (
    SELECT conversation_id, user_id, org_id,
           MAX(cp_main.deleted_at) as deleted_at,
           EXISTS(SELECT 1 FROM conversation_participants cp_a 
                  WHERE cp_a.conversation_id = cp_main.conversation_id 
                  AND (
                      (cp_main.user_id IS NOT NULL AND cp_a.user_id = cp_main.user_id)
                      OR
                      (cp_main.org_id IS NOT NULL AND cp_a.org_id = cp_main.org_id)
                  )
                  AND cp_a.left_at IS NULL) as is_active,
           CASE 
               WHEN EXISTS(SELECT 1 FROM conversation_participants cp_a 
                           WHERE cp_a.conversation_id = cp_main.conversation_id 
                           AND (
                               (cp_main.user_id IS NOT NULL AND cp_a.user_id = cp_main.user_id)
                               OR
                               (cp_main.org_id IS NOT NULL AND cp_a.org_id = cp_main.org_id)
                           )
                           AND cp_a.left_at IS NULL) THEN NULL
               ELSE MAX(cp_main.left_at)
           END as left_at,
           CASE 
               WHEN EXISTS(SELECT 1 FROM conversation_participants cp_a 
                           WHERE cp_a.conversation_id = cp_main.conversation_id 
                           AND (
                               (cp_main.user_id IS NOT NULL AND cp_a.user_id = cp_main.user_id)
                               OR
                               (cp_main.org_id IS NOT NULL AND cp_a.org_id = cp_main.org_id)
                           )
                           AND cp_a.left_at IS NULL) THEN NULL
               ELSE MAX(cp_main.left_group_name)
           END as left_group_name,
           CASE 
               WHEN EXISTS(SELECT 1 FROM conversation_participants cp_a 
                           WHERE cp_a.conversation_id = cp_main.conversation_id 
                           AND (
                               (cp_main.user_id IS NOT NULL AND cp_a.user_id = cp_main.user_id)
                               OR
                               (cp_main.org_id IS NOT NULL AND cp_a.org_id = cp_main.org_id)
                           )
                           AND cp_a.left_at IS NULL) THEN NULL
               ELSE MAX(cp_main.left_group_avatar)
           END as left_group_avatar,
           CASE 
               WHEN EXISTS(SELECT 1 FROM conversation_participants cp_a 
                           WHERE cp_a.conversation_id = cp_main.conversation_id 
                           AND (
                               (cp_main.user_id IS NOT NULL AND cp_a.user_id = cp_main.user_id)
                               OR
                               (cp_main.org_id IS NOT NULL AND cp_a.org_id = cp_main.org_id)
                           )
                           AND cp_a.left_at IS NULL) THEN NULL
               ELSE MAX(cp_main.left_group_description)
           END as left_group_description,
           CASE 
               WHEN EXISTS(SELECT 1 FROM conversation_participants cp_a 
                           WHERE cp_a.conversation_id = cp_main.conversation_id 
                           AND (
                               (cp_main.user_id IS NOT NULL AND cp_a.user_id = cp_main.user_id)
                               OR
                               (cp_main.org_id IS NOT NULL AND cp_a.org_id = cp_main.org_id)
                           )
                           AND cp_a.left_at IS NULL) THEN NULL
               ELSE MAX(cp_main.left_group_headline)
           END as left_group_headline,
           BOOL_OR(
               cp_main.left_at IS NULL
               AND cp_main.is_muted = TRUE
               AND (cp_main.muted_until IS NULL OR cp_main.muted_until > NOW())
           ) as is_muted,
           MAX(CASE WHEN cp_main.left_at IS NULL THEN cp_main.muted_until ELSE NULL END) as muted_until
    FROM conversation_participants cp_main
    WHERE 
      -- Filter by User OR Company based on context
      (
        ($2::uuid IS NOT NULL AND cp_main.org_id = $2)
        OR
        ($2::uuid IS NULL AND cp_main.user_id = $1)
      )
    GROUP BY conversation_id, user_id, org_id -- added org_id
) cp ON c.conversation_id = cp.conversation_id
-- For 1-on-1, join the other participant (LATERAL + LIMIT 1 prevents fan-out duplicates).
LEFT JOIN LATERAL (
    SELECT cp_o.user_id, cp_o.org_id
    FROM conversation_participants cp_o
    WHERE cp_o.conversation_id = c.conversation_id
      AND c.is_group = FALSE
      AND (
          ($2::uuid IS NOT NULL AND (cp_o.org_id IS NULL OR cp_o.org_id != $2))
          OR
          ($2::uuid IS NULL AND (cp_o.user_id IS NULL OR cp_o.user_id != $1))
      )
    LIMIT 1
) cp_other ON c.is_group = FALSE
LEFT JOIN user_display_profiles u ON cp_other.user_id = u.user_id
LEFT JOIN users raw_u ON cp_other.user_id = raw_u.user_id
LEFT JOIN organization_display_profiles comp ON cp_other.org_id = comp.org_id -- JOIN organizations for Company participants
LEFT JOIN organizations raw_comp ON cp_other.org_id = raw_comp.org_id

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
                    'sender_name', COALESCE(rc.name, ru.display_name, 'Deleted User'),
                    'message_type', rm.message_type,
                    'media', (SELECT json_agg(json_build_object('url', rmm.url, 'media_type', rmm.media_type, 'filename', rmm.filename)) FROM message_media rmm WHERE rmm.message_id = rm.message_id)
                ) 
                FROM messages rm 
                LEFT JOIN user_display_profiles ru ON rm.sender_id = ru.user_id
                LEFT JOIN organization_display_profiles rc ON rm.author_org_id = rc.org_id
                WHERE rm.message_id = msg.replied_msg_id)
            ELSE NULL
        END AS reply_message,
        COALESCE(
            (SELECT JSON_AGG(
                JSON_BUILD_OBJECT(
                    'user_id', mr.user_id,
                    'full_name', ru.display_name,
                    'avatar', ru.display_avatar,
                    'emoji', mr.emoji,
                    'created_at', mr.created_at,
                    'updated_at', mr.updated_at
                ) ORDER BY mr.updated_at DESC
            ) FILTER (WHERE mr.reaction_id IS NOT NULL AND mr.emoji IS NOT NULL AND mr.emoji != '')
            FROM message_reactions mr
            JOIN user_display_profiles ru ON ru.user_id = mr.user_id
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
    AND (cp_msg.deleted_at IS NULL OR msg.created_at > cp_msg.deleted_at)
    -- Exclude messages deleted for me (User only currently)
    AND NOT EXISTS (
        SELECT 1 FROM message_delete md 
        WHERE md.message_id = msg.message_id 
        AND md.user_id = $1 -- Deletes are user-specific for now
    )
    ORDER BY msg.created_at DESC 
    LIMIT 1
) m ON true


WHERE c.is_active = TRUE
-- Company mode strictly hides group chats
AND ($2::uuid IS NULL OR c.is_group = FALSE)
-- Filter by tab (JOBS vs GENERAL) if requested
AND ($3::boolean IS NULL OR c.is_job_chat = $3)
AND (cp.deleted_at IS NULL OR COALESCE(
    m.created_at, 
    CASE 
        WHEN cp.left_at IS NOT NULL THEN cp.left_at 
        ELSE c.last_message_at 
    END, 
    c.updated_at
) > cp.deleted_at)

ORDER BY COALESCE(
    m.created_at, 
    CASE 
        WHEN cp.left_at IS NOT NULL THEN cp.left_at 
        ELSE c.last_message_at 
    END, 
    c.updated_at
) DESC NULLS LAST;
  `, [userId, companyId, tabParam]
        );

        let pendingGroupInvitationRows = [];

        if (!companyId) {
            const pendingGroupInvitations = await pool.query(
                `
SELECT
    c.*,
    FALSE AS is_blocked_by_me,
    FALSE AS is_blocked_by_other,
    COALESCE(c.conversation_name, 'Group Chat') AS other_user_name,
    c.group_avatar AS other_user_avatar,
    c.conversation_id AS other_user_id,
    inviter.full_name AS other_user_headline,
    'USER' AS other_user_type,
    NULL::text AS other_user_slug,
    FALSE AS is_active,
    FALSE AS is_muted,
    NULL::timestamptz AS muted_until,
    FALSE AS is_deleted_user,
    NULL::uuid AS last_message_id,
    COALESCE(inviter.full_name, 'A member') || ' invited you to join the group' AS last_message_text,
    COALESCE(gi.updated_at, gi.created_at, c.updated_at) AS last_message_at,
    NULL::uuid AS "replyMessageId",
    NULL::json AS reply_message,
    gi.invitation_id,
    (gi.updated_at > gi.created_at) AS is_read,
    'group_invitation'::text AS request_source
FROM group_invitations gi
JOIN conversations c
    ON c.conversation_id = gi.conversation_id
   AND c.is_group = TRUE
   AND c.is_active = TRUE
LEFT JOIN active_users inviter ON inviter.user_id = gi.inviter_id
WHERE gi.invitee_id = $1
  AND gi.status = 'pending'
  AND NOT EXISTS (
      SELECT 1
      FROM conversation_participants cp_active
      WHERE cp_active.conversation_id = gi.conversation_id
        AND cp_active.user_id = $1
        AND cp_active.left_at IS NULL
  )
                `,
                [userId]
            );

            pendingGroupInvitationRows = pendingGroupInvitations.rows.map((row) => ({
                ...row,
                is_requesting: true,
            }));
        }

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
        ($2::uuid IS NULL AND (m.author_org_id IS NOT NULL OR m.sender_id != $1 OR m.sender_id IS NULL))
    )
    AND (cp.last_read_at IS NULL OR cp.last_read_at <= cp.joined_at OR m.created_at > cp.last_read_at)
    AND m.created_at >= (cp.joined_at - INTERVAL '1 minute')
  GROUP BY m.conversation_id
  `, [userId, companyId]
        );

        const unreadMap = {};
        for (const row of unreadCountsResult.rows) {
            unreadMap[row.conversation_id] = row.unread_count;
        }


        const conversationsWithUnread = [...result.rows, ...pendingGroupInvitationRows].map(c => {
            const calculatedUnread = unreadMap[c.conversation_id] || 0;
            return {
                ...c,
                // Determine online status for direct (non-group) conversations
                onlineStatus: (function () {
                    if (c.is_group) return 'offline'; // groups don't have a single status
                    if (c.is_blocked_by_me || c.is_blocked_by_other) return 'offline';
                    const otherId = c.other_user_id;
                    // Prioritize typing status
                    if (socketService.isUserTyping(otherId, c.conversation_id)) return 'typing';
                    // Then online
                    if (socketService.isUserOnline(otherId)) return 'online';
                    return 'offline';
                })(),
                is_requesting: c.is_requesting && (c.created_by === userId) ? false : c.is_requesting,
                timeAgo: timeAgo(c.updated_at),
                unread_count: calculatedUnread,
                is_read: c.is_read !== undefined ? c.is_read : calculatedUnread === 0,
            };
        }).sort((a, b) => {
            const left = new Date(a.last_message_at || a.updated_at || 0).getTime();
            const right = new Date(b.last_message_at || b.updated_at || 0).getTime();
            return right - left;
        });
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
        const client = await pool.connect();

        try {
            await client.query("BEGIN");

            const validationResult = await client.query(
                `SELECT c.conversation_id, c.is_group
                 FROM conversations c
                 JOIN conversation_participants cp
                   ON cp.conversation_id = c.conversation_id
                 WHERE c.conversation_id = $1
                   AND c.is_active = TRUE
                   AND cp.left_at IS NULL
                   AND (
                       ($3::uuid IS NOT NULL AND cp.org_id = $3)
                       OR
                       ($3::uuid IS NULL AND cp.user_id = $2)
                   )
                 LIMIT 1`,
                [conversationId, userId, companyId]
            );

            if (validationResult.rowCount === 0) {
                await client.query("ROLLBACK");
                return res.status(404).json({ message: "Conversation not found or access denied" });
            }

            if (validationResult.rows[0].is_group) {
                await client.query("ROLLBACK");
                return res.status(400).json({ message: "Cannot delete a group conversation. Use leave group instead." });
            }

            const deleteResult = await client.query(
                `UPDATE conversation_participants
                 SET deleted_at = NOW()
                 WHERE conversation_id = $1
                   AND (
                       ($3::uuid IS NOT NULL AND org_id = $3)
                       OR
                       ($3::uuid IS NULL AND user_id = $2)
                   )
                 RETURNING participant_id`,
                [conversationId, userId, companyId]
            );

            if (deleteResult.rowCount === 0) {
                await client.query("ROLLBACK");
                return res.status(404).json({ message: "Conversation not found or access denied" });
            }

            await client.query("COMMIT");
            res.status(200).json({ message: "Conversation deleted successfully", conversationId });
        } catch (err) {
            await client.query("ROLLBACK");
            throw err;
        } finally {
            client.release();
        }
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
    const { targetUserId, text_content, shared_post_id, replyMessageId, shared_profile_id, shared_profile_type, entity_type, entity_id } = req.body;
    const images = req.files; // Array of files from multer

    const trimmedText = text_content?.trim() || '';
    // Basic validation: user needs target + (text OR post OR images OR shared_profile_id OR entity_id)
    if (!targetUserId || (!trimmedText && !shared_post_id && !shared_profile_id && !entity_id && (!images || images.length === 0))) {
        return res.status(400).json({ message: "targetUserId and content (text, post, images, profile, or entity context) are required" });
    }

    if (!authorCompanyId && senderId === targetUserId) {
        return res.status(400).json({ message: "Cannot send message to yourself" });
    }

    const client = await pool.connect();
    const MAX_RETRIES = 2;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');

            let senderName, senderAvatar, senderSlug = null, senderHeadline = null, senderOrgHeadline = null, senderMemberName = null;
            const senderUserRes = await client.query(
                `SELECT full_name FROM users WHERE user_id = $1`,
                [senderId]
            );
            if (senderUserRes.rowCount > 0) {
                senderMemberName = senderUserRes.rows[0].full_name;
            }

            if (authorCompanyId) {
                const orgRes = await client.query(
                    `SELECT name, logo_url, slug, headline FROM organizations WHERE org_id = $1`,
                    [authorCompanyId]
                );
                if (orgRes.rowCount === 0) {
                    await client.query('ROLLBACK');
                    return res.status(404).json({ message: "Company not found" });
                }
                senderName = orgRes.rows[0].name;
                senderAvatar = orgRes.rows[0].logo_url;
                senderSlug = orgRes.rows[0].slug;
                senderOrgHeadline = orgRes.rows[0].headline || '';
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
                ? await client.query(`SELECT org_id, name, logo_url, slug, headline FROM organizations WHERE org_id = $1`, [targetUserId])
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
            const targetOrgHeadline = targetIsCompany ? (targetCompanyExists.rows[0].headline || '') : null;
            const targetSlug = targetIsUser
                ? targetUserExists.rows[0].account_name
                : (targetIsCompany ? targetCompanyExists.rows[0].slug : null);
            const targetType = targetIsCompany ? 'COMPANY' : 'USER';

            if (!targetIsUser && !targetIsCompany) {
                await client.query('ROLLBACK');
                return res.status(400).json({ message: "Target not found." });
            }

            // Block check: applies to both user and organization targets
            try {
                const { checkActorBlockStatus } = require("../../core/utils/blockCheck");
                const isBlocked = await checkActorBlockStatus(req, targetUserId);
                if (isBlocked) {
                    await client.query('ROLLBACK');
                    return res.status(403).json({ message: "Cannot send message. You or the recipient have blocked each other." });
                }
            } catch (e) {
                console.error("Block check failed", e);
            }

            let conversationId;
            let isNewConversation = false;

            if (authorCompanyId) {
                // Company-to-User or Company-to-Company
                const existingConv = targetIsCompany 
                    ? await client.query(
                        `SELECT c.conversation_id
                         FROM conversations c
                         JOIN conversation_participants cp1 ON c.conversation_id = cp1.conversation_id AND cp1.org_id = $1
                         JOIN conversation_participants cp2 ON c.conversation_id = cp2.conversation_id AND cp2.org_id = $2
                         WHERE c.is_group = FALSE AND c.is_active = TRUE`,
                        [authorCompanyId, targetUserId]
                    )
                    : await client.query(
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
                    // Create new conversation with company as one participant (for companies, is_requesting is ALWAYS FALSE)
                    const convRes = await client.query(
                        `INSERT INTO conversations (is_group, is_requesting, created_by) VALUES (FALSE, FALSE, $1) RETURNING conversation_id`,
                        [senderId]
                    );
                    conversationId = convRes.rows[0].conversation_id;
                    isNewConversation = true;

                    // Sender company participant
                    await client.query(
                        `INSERT INTO conversation_participants (conversation_id, org_id, last_read_at) VALUES ($1, $2, NOW())`,
                        [conversationId, authorCompanyId]
                    );
                    // Target participant (org_id if targetIsCompany, user_id if targetIsUser)
                    if (targetIsCompany) {
                        await client.query(
                            `INSERT INTO conversation_participants (conversation_id, org_id, last_read_at) VALUES ($1, $2, NULL)`,
                            [conversationId, targetUserId]
                        );
                    } else {
                        await client.query(
                            `INSERT INTO conversation_participants (conversation_id, user_id, last_read_at) VALUES ($1, $2, NULL)`,
                            [conversationId, targetUserId]
                        );
                    }
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
                        `INSERT INTO conversation_participants (conversation_id, user_id, last_read_at) VALUES ($1, $2, NOW())`,
                        [conversationId, senderId]
                    );
                    // Target company participant
                    await client.query(
                        `INSERT INTO conversation_participants (conversation_id, org_id, last_read_at) VALUES ($1, $2, NULL)`,
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
                        `INSERT INTO conversation_participants (conversation_id, user_id, last_read_at) VALUES ($1, $2, NOW()), ($1, $3, NULL)`,
                        [conversationId, senderId, targetUserId]
                    );
                }
            }

            // Fetch conversation metadata needed for socket payload
            const convMeta = await client.query(
                `SELECT is_requesting, created_at, created_by, is_job_chat FROM conversations WHERE conversation_id = $1`,
                [conversationId]
            );
            const convIsRequesting = convMeta.rows[0]?.is_requesting ?? false;
            const convIsJobChat = convMeta.rows[0]?.is_job_chat || false;
            const convCreatedAt = convMeta.rows[0]?.created_at ?? null;
            const convCreatedBy = convMeta.rows[0]?.created_by || null;

            let finalSharedProfileType = shared_profile_type || null;
            if (shared_profile_id && !finalSharedProfileType) {
                const orgCheck = await client.query("SELECT 1 FROM organizations WHERE org_id = $1", [shared_profile_id]);
                finalSharedProfileType = orgCheck.rowCount > 0 ? 'company' : 'user';
            }

            // Determine message text for notifications/preview
            const isDocumentMimetype = (mimetype) => mimetype === 'application/pdf'
                || mimetype === 'application/msword'
                || mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

            const previewText = trimmedText
                ? trimmedText
                : (images && images.length > 0
                    ? (images.length > 1 ? `${images.length} attachments` : (images[0].mimetype.startsWith('video/') ? 'Sent a video' : (isDocumentMimetype(images[0].mimetype) ? 'Sent a document' : 'Sent a photo')))
                    : (shared_post_id ? 'Shared a post' : (shared_profile_id ? 'Shared a profile' : 'Attachment')));

            const sessionId = null;

            const msgRes = await client.query(
                `INSERT INTO messages (conversation_id, sender_id, text_content, shared_post_id, author_org_id, sender_type, session_id, replied_msg_id, shared_profile_id, shared_profile_type, entity_type, entity_id)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
                [
                    conversationId,
                    senderId,
                    trimmedText || '',
                    shared_post_id || null,
                    authorCompanyId || null,
                    authorCompanyId ? 'COMPANY' : 'USER',
                    sessionId,
                    replyMessageId || null,
                    shared_profile_id || null,
                    finalSharedProfileType,
                    entity_type || null,
                    entity_id || null
                ]
            );
            const newMessage = msgRes.rows[0];

            // Process Images
            // Process Media (Images, Video, PDF)
            let mediaRecords = [];
            if (images && images.length > 0) {
                const mediaValues = images.map(file => {
                    let type = 'image';
                    if (file.mimetype.startsWith('video/')) type = 'video';
                    if (isDocumentMimetype(file.mimetype)) type = 'document';
                    return [newMessage.message_id, file.path, type, file.originalname];
                });

                // Construct bulk insert parameters
                const placeholders = mediaValues.map((_, i) => `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`).join(', ');
                const flatValues = mediaValues.flat();

                const mediaRes = await client.query(
                    `INSERT INTO message_media (message_id, url, media_type, filename)
                     VALUES ${placeholders}
                     RETURNING url, media_type, filename`,
                    flatValues
                );
                mediaRecords = mediaRes.rows;
            }

            // Fetch shared post details if applicable
            let sharedPostData = null;
            if (shared_post_id) {
                const spRes = await client.query(`
                    SELECT 
                        p.post_id, p.content, p.created_at, p.post_type, p.title,
                        COALESCE(org.name, u.display_name, 'Unknown Author') as author,
                        COALESCE(org.logo_url, u.display_avatar, NULL) as author_avatar,
                        COALESCE(org.headline, u.display_headline, NULL) as author_headline,
                        (p.author_org_id IS NOT NULL) as is_organization_post,
                        json_build_object('full_name', COALESCE(org.name, u.display_name), 'avatar_url', COALESCE(org.logo_url, u.display_avatar), 'headline', COALESCE(org.headline, u.display_headline)) as author_obj,
                        (SELECT json_agg(json_build_object('url', url, 'media_type', media_type)) FROM post_media WHERE post_id = p.post_id) as media,
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
                    LEFT JOIN user_display_profiles u ON p.author_id = u.user_id
                    LEFT JOIN organization_display_profiles org ON p.author_org_id = org.org_id
                    WHERE p.post_id = $1
                `, [shared_post_id]);
                if (spRes.rowCount > 0) sharedPostData = spRes.rows[0];

                try {
                    const shareService = require('../share/share.service');
                    shareService.trackShare(senderId, targetUserId, 'post', shared_post_id, 'message');
                } catch (err) {
                    console.warn("[ShareTracking] Failed to track share event in message:", err.message);
                }
            }

            // Check if this message is attached with a job/offer entity context card
            let autoJobChatSet = false;
            const isJobEntity = entity_type === 'job' || entity_type === 'offer';
            if (isJobEntity && entity_id) {
                // Whenever a job card context is sent with a message, automatically mark conversation as a job chat
                await client.query(
                    `UPDATE conversations SET is_job_chat = TRUE WHERE conversation_id = $1`,
                    [conversationId]
                );
                autoJobChatSet = true;
            }

            const finalIsJobChat = convIsJobChat || autoJobChatSet;

            // Update conversation timestamp and last message
            await client.query(
                `UPDATE conversations 
                 SET updated_at = now(),
                     last_message = $2,
                     last_message_at = now()
                 WHERE conversation_id = $1`,
                [conversationId, previewText]
            );

            if (autoJobChatSet) {
                socketService.notifyParticipants(conversationId, "conversation_job_status_changed", {
                    conversationId,
                    isJobChat: true,
                });
                socketService.notifyParticipants(conversationId, "conversation_updated", {
                    conversationId,
                    isJobChat: true,
                });
            }
            let targetNotificationMuted = false;
            if (targetIsCompany) {
                const muteState = await getConversationMuteState(client, {
                    conversationId,
                    userId: senderId,
                    companyId: targetUserId,
                });
                targetNotificationMuted = !!muteState?.isMuted;
            } else {
                const muteState = await getConversationMuteState(client, {
                    conversationId,
                    userId: targetUserId,
                    companyId: null,
                });
                targetNotificationMuted = !!muteState?.isMuted;
            }

            await client.query('COMMIT');

            let replyMessageData = null;
            if (replyMessageId) {
                const rmRes = await client.query(`
                    SELECT 
                        rm.message_id, 
                        rm.text_content, 
                        rm.message_type,
                        COALESCE(rc.name, ru.display_name, 'Deleted User') as sender_name,
                        (SELECT json_agg(json_build_object('url', rmm.url, 'media_type', rmm.media_type, 'filename', rmm.filename)) FROM message_media rmm WHERE rmm.message_id = rm.message_id) as media
                    FROM messages rm
                    LEFT JOIN user_display_profiles ru ON rm.sender_id = ru.user_id
                    LEFT JOIN organization_display_profiles rc ON rm.author_org_id = rc.org_id
                    WHERE rm.message_id = $1
                `, [replyMessageId]);
                if (rmRes.rowCount > 0) replyMessageData = rmRes.rows[0];
            }

            let sharedProfileData = null;
            if (shared_profile_id) {
                if (finalSharedProfileType === 'user') {
                    const uRes = await client.query(
                        `SELECT full_name as name, avatar_url as avatar, headline, location, account_name as username 
                         FROM users WHERE user_id = $1`,
                        [shared_profile_id]
                    );
                    if (uRes.rowCount > 0) {
                        sharedProfileData = uRes.rows[0];
                    }
                } else if (finalSharedProfileType === 'company') {
                    const cRes = await client.query(
                        `SELECT name, logo_url as avatar, industry as headline, industry, slug 
                         FROM organizations WHERE org_id = $1 AND is_deleted = FALSE`,
                        [shared_profile_id]
                    );
                    if (cRes.rowCount > 0) {
                        sharedProfileData = cRes.rows[0];
                    }
                }
            }

            let isMessageUnavailable = false;
            // RULE 1: Shared post: null/not-found means deleted → both sides see unavailable
            if (shared_post_id && !sharedPostData) {
                isMessageUnavailable = true;
            }
            // RULE 1 + 2 + 3: Org URL in text — org deleted/deactivated OR that org blocked the sender
            if (!isMessageUnavailable && trimmedText.includes('/organization/')) {
                const orgCheck = await client.query(`
                    SELECT 1 FROM organizations o
                    WHERE ($1 LIKE '%' || o.slug || '%' OR $1 LIKE '%' || o.org_id::text || '%')
                      AND (
                          o.is_deleted = TRUE 
                          OR o.is_deactivated = TRUE 
                          OR EXISTS (
                              SELECT 1 FROM blocks b 
                              WHERE b.blocked_id = $2::uuid
                                AND b.blocker_id = o.org_id
                          )
                      )
                `, [trimmedText, senderId]);
                if (orgCheck.rowCount > 0) isMessageUnavailable = true;
            }
            // RULE 1: Post URL in text — post deleted/inactive → both sides see unavailable
            if (!isMessageUnavailable && !shared_post_id && trimmedText.includes('/post/')) {
                const postCheck = await client.query(`
                    SELECT 1 FROM posts p
                    WHERE ($1 LIKE '%' || p.post_id::text || '%')
                      AND (p.is_active = FALSE OR p.is_removed = TRUE)
                `, [trimmedText]);
                if (postCheck.rowCount > 0) isMessageUnavailable = true;
            }

            const messageData = {
                ...newMessage,
                replyMessageId: replyMessageId || null,
                reply_message: replyMessageData,
                media: mediaRecords,
                shared_post: sharedPostData,
                shared_profile: sharedProfileData,
                sender_name: senderName,
                sender_member_name: senderMemberName,
                org_headline: authorCompanyId ? (senderOrgHeadline || '') : '',
                sender_avatar: senderAvatar,
                is_unavailable: isMessageUnavailable
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
                created_by: convCreatedBy,
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
                is_requesting: convIsRequesting && (convCreatedBy === targetUserId) ? false : convIsRequesting,
                other_user_id: authorCompanyId ? authorCompanyId : senderId,
                other_user_name: senderName,
                other_user_avatar: senderAvatar,
                other_user_headline: senderHeadline,
                org_headline: authorCompanyId ? (senderOrgHeadline || '') : '',
                other_user_slug: senderSlug,
                other_user_type: authorCompanyId ? 'COMPANY' : 'USER',
                is_deleted_user: false,
                unread_count: 1, // receiver always has at least 1 unread
            };

            // ─── Sender payload: other_user_* = TARGET info ───
            const senderConvPayload = {
                ...baseConvPayload,
                is_requesting: convIsRequesting && (convCreatedBy === senderId) ? false : convIsRequesting,
                other_user_id: targetUserId,
                other_user_name: targetName,
                other_user_avatar: targetAvatar,
                other_user_headline: targetHeadline,
                org_headline: targetOrgHeadline,
                other_user_slug: targetSlug,
                other_user_type: targetType,
                is_deleted_user: false,
                unread_count: 0, // sender has read their own message
            };

            const senderActorScope = req.actor?.type === "ORGANIZATION" && req.actor?.orgId
                ? `org:${req.actor.orgId}`
                : `user:${senderId}`;
            const targetActorScope = targetIsCompany
                ? `org:${targetUserId}`
                : `user:${targetUserId}`;

            // Notify via socket
            if (targetIsCompany) {
                // User→Company: notify all members of the target company in the company actor scope only
                const members = await pool.query(
                    'SELECT user_id FROM organization_members WHERE org_id = $1',
                    [targetUserId]
                );
                for (const member of members.rows) {
                    socketService.notifyUserScoped(member.user_id, "new_message", messageData, targetActorScope);
                    socketService.notifyUserScoped(member.user_id, "conversation_updated", {
                        ...receiverConvPayload,
                        target_profile_type: 'COMPANY',
                        target_company_id: targetUserId
                    }, targetActorScope);
                    if (!targetNotificationMuted) {
                        socketService.notifyUserScoped(member.user_id, "notification", {
                            type: "message",
                            isJobChat: finalIsJobChat,
                            from: senderId,
                            senderName,
                            senderAvatar,
                            conversationId,
                            text: previewText,
                            targetProfileType: 'COMPANY',
                            targetCompanyId: targetUserId
                        }, targetActorScope);
                        // Push notification for offline devices
                        sendPush(member.user_id, senderName, previewText, { type: 'message', conversationId, senderId }).catch(() => {});
                    }
                }
            } else {
                // User→User or Company→User: notify target user directly in the user actor scope
                socketService.notifyUserScoped(targetUserId, "new_message", messageData, targetActorScope);
                socketService.notifyUserScoped(targetUserId, "conversation_updated", {
                    ...receiverConvPayload,
                    target_profile_type: 'USER'
                }, targetActorScope);
                if (!targetNotificationMuted) {
                    socketService.notifyUserScoped(targetUserId, "notification", {
                        type: "message",
                        isJobChat: finalIsJobChat,
                        from: senderId,
                        senderName,
                        senderAvatar,
                        conversationId,
                        text: previewText,
                        targetProfileType: 'USER'
                    }, targetActorScope);
                    // Push notification for offline devices
                    sendPush(targetUserId, senderName, previewText, { type: 'message', conversationId, senderId }).catch(() => {});
                }
            }
            // Notify sender as well in the sender's active scope
            socketService.notifyUserScoped(senderId, "new_message", messageData, senderActorScope);
            socketService.notifyUserScoped(senderId, "conversation_updated", {
                ...senderConvPayload,
                target_profile_type: targetIsCompany ? 'COMPANY' : 'USER',
                target_company_id: targetIsCompany ? targetUserId : null
            }, senderActorScope);

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

exports.getConversationMuteState = async (req, res) => {
    const { conversationId } = req.params;
    let actorScope;

    try {
        actorScope = getSocialActorScope(req, req.query.companyId || null);
    } catch (err) {
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }

    const { userId, orgId: companyId } = actorScope;

    try {
        const muteState = await getConversationMuteState(pool, {
            conversationId,
            userId,
            companyId,
        });

        if (!muteState) {
            return res.status(404).json({ message: "Conversation not found or access denied" });
        }

        res.json({
            conversationId,
            is_muted: muteState.isMuted,
            muted_until: muteState.mutedUntil,
            mute_updated_at: muteState.muteUpdatedAt,
        });
    } catch (err) {
        console.error("Get conversation mute state error:", err);
        res.status(err.statusCode || 500).json({
            message: err.message || "Internal server error",
        });
    }
};

exports.updateConversationMuteState = async (req, res) => {
    const { conversationId } = req.params;
    const { muted, mutedUntil } = req.body || {};
    let actorScope;

    if (typeof muted !== "boolean") {
        return res.status(400).json({ message: "muted must be a boolean" });
    }

    let parsedMutedUntil = null;
    if (muted) {
        if (mutedUntil !== undefined && mutedUntil !== null && mutedUntil !== "") {
            parsedMutedUntil = new Date(mutedUntil);
            if (Number.isNaN(parsedMutedUntil.getTime())) {
                return res.status(400).json({ message: "mutedUntil must be a valid ISO date" });
            }
            if (parsedMutedUntil.getTime() <= Date.now()) {
                return res.status(400).json({ message: "mutedUntil must be in the future" });
            }
            parsedMutedUntil = parsedMutedUntil.toISOString();
        }
    }

    try {
        actorScope = getSocialActorScope(req, req.body?.companyId || req.query.companyId || null);
    } catch (err) {
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }

    const { userId, orgId: companyId } = actorScope;

    try {
        const muteState = await persistConversationMuteState(pool, {
            conversationId,
            userId,
            companyId,
            muted,
            mutedUntil: parsedMutedUntil,
        });

        if (!muteState) {
            return res.status(404).json({ message: "Conversation not found or access denied" });
        }

        await notifyConversationPreferenceUpdate({
            conversationId,
            userId,
            companyId,
            muteState,
        });

        res.json({
            message: muted ? "Conversation muted" : "Conversation unmuted",
            conversationId,
            is_muted: muteState.isMuted,
            muted_until: muteState.mutedUntil,
            mute_updated_at: muteState.muteUpdatedAt,
        });
    } catch (err) {
        console.error("Update conversation mute state error:", err);
        res.status(err.statusCode || 500).json({
            message: err.message || "Internal server error",
        });
    }
};

exports.unmuteConversation = async (req, res) => {
    const { conversationId } = req.params;
    let actorScope;

    try {
        actorScope = getSocialActorScope(req, req.body?.companyId || req.query.companyId || null);
    } catch (err) {
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }

    const { userId, orgId: companyId } = actorScope;

    try {
        const muteState = await persistConversationMuteState(pool, {
            conversationId,
            userId,
            companyId,
            muted: false,
            mutedUntil: null,
        });

        if (!muteState) {
            return res.status(404).json({ message: "Conversation not found or access denied" });
        }

        await notifyConversationPreferenceUpdate({
            conversationId,
            userId,
            companyId,
            muteState,
        });

        res.json({
            message: "Conversation unmuted",
            conversationId,
            is_muted: muteState.isMuted,
            muted_until: muteState.mutedUntil,
            mute_updated_at: muteState.muteUpdatedAt,
        });
    } catch (err) {
        console.error("Unmute conversation error:", err);
        res.status(err.statusCode || 500).json({
            message: err.message || "Internal server error",
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
                u.display_name as full_name,
                COALESCE(u.display_avatar, raw_u.avatar_url) as avatar_url,
                mr.read_at
            FROM message_reads mr
            JOIN user_display_profiles u ON mr.user_id = u.user_id
            JOIN users raw_u ON mr.user_id = raw_u.user_id
            JOIN messages m ON mr.message_id = m.message_id
            JOIN conversation_participants cp ON m.conversation_id = cp.conversation_id AND mr.user_id = cp.user_id
            WHERE mr.message_id = $1
              AND cp.joined_at <= m.created_at
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
                m.shared_post_id,
                m.created_at,
                m.read_at,
                m.edited_at,
                m.is_edited,
                m.message_type,
                m.action_type,
                m.target_id,
                m.author_org_id,
                m.author_org_id AS author_company_id,
                m.is_deleted_for_everyone,
                m.deleted_at,
                (SELECT COUNT(*)::int FROM conversation_participants cp 
                 WHERE cp.conversation_id = m.conversation_id 
                   AND cp.left_at IS NULL 
                   AND (m.sender_id IS NULL OR cp.user_id != m.sender_id)
                ) AS active_member_count,
                 COALESCE(
                     (SELECT COUNT(*)::int FROM message_reads mr 
                      JOIN conversation_participants cp ON mr.user_id = cp.user_id
                      WHERE mr.message_id = m.message_id 
                        AND cp.conversation_id = m.conversation_id
                        AND cp.left_at IS NULL
                        AND cp.joined_at <= m.created_at
                        AND (m.sender_id IS NULL OR cp.user_id != m.sender_id)
                     ), 0
                 ) AS seen_count,
                  CASE 
                      WHEN EXISTS (
                          SELECT 1 FROM blocks b 
                          WHERE b.blocked_id = COALESCE($6::uuid, $4::uuid) AND (b.blocker_id = m.sender_id OR (m.author_org_id IS NOT NULL AND b.blocker_id = m.author_org_id))
                      ) THEN CASE WHEN m.author_org_id IS NOT NULL THEN 'Unknown Page' ELSE 'Unknown User' END
                      WHEN raw_u_msg.is_deactivated OR raw_u_msg.deletion_execute_at IS NOT NULL THEN 'Unknown User' 
                      WHEN m.author_org_id IS NOT NULL AND (c.name = 'Deleted Page' OR raw_org.is_deleted = TRUE OR raw_org.is_deactivated = TRUE) THEN 'Unknown Page'
                      ELSE COALESCE(c.name, u.display_name, 'Unknown User') 
                  END as sender_name,
                CASE WHEN raw_u_msg.is_deactivated THEN 'Unknown User' ELSE u.display_name END as sender_member_name,
                CASE 
                    WHEN EXISTS (
                        SELECT 1 FROM blocks b 
                        WHERE b.blocked_id = COALESCE($6::uuid, $4::uuid) AND (b.blocker_id = m.sender_id OR (m.author_org_id IS NOT NULL AND b.blocker_id = m.author_org_id))
                    ) THEN 'User unavailable'
                    ELSE COALESCE(c.headline, '') 
                END as sender_org_headline,
                CASE WHEN m.author_org_id IS NOT NULL THEN COALESCE(c.headline, '') ELSE '' END as org_headline,
                CASE 
                    WHEN EXISTS (
                        SELECT 1 FROM blocks b 
                        WHERE b.blocked_id = COALESCE($6::uuid, $4::uuid) AND (b.blocker_id = m.sender_id OR (m.author_org_id IS NOT NULL AND b.blocker_id = m.author_org_id))
                    ) THEN NULL
                    WHEN raw_u_msg.is_deactivated OR raw_u_msg.deletion_execute_at IS NOT NULL THEN NULL
                    WHEN m.author_org_id IS NOT NULL AND (c.name = 'Deleted Page' OR raw_org.is_deleted = TRUE OR raw_org.is_deactivated = TRUE) THEN NULL
                    ELSE CASE 
                        WHEN m.author_org_id IS NOT NULL THEN COALESCE(c.logo_url, raw_org.logo_url)
                        ELSE COALESCE(u.display_avatar, raw_u_msg.avatar_url)
                    END
                END as sender_avatar,
                (SELECT json_agg(json_build_object('url', mm.url, 'media_type', mm.media_type, 'filename', mm.filename))
                 FROM message_media mm
                 WHERE mm.message_id = m.message_id
                ) as media,
                CASE 
                    WHEN EXISTS (
                        SELECT 1 FROM blocks b 
                        WHERE (b.blocked_id = COALESCE($6::uuid, $4::uuid) AND (b.blocker_id = m.sender_id OR (m.author_org_id IS NOT NULL AND b.blocker_id = m.author_org_id)))
                           OR (b.blocker_id = COALESCE($6::uuid, $4::uuid) AND (b.blocked_id = m.sender_id OR (m.author_org_id IS NOT NULL AND b.blocked_id = m.author_org_id)))
                    ) THEN true 
                    ELSE false 
                END as is_blocked,
                m.text_content,
                CASE 
                    -- RULE 1 + 3: Shared Post — post itself is deleted/removed/inactive (BOTH SIDES)
                    --             OR post author's account is deactivated/deleted (BOTH SIDES)
                    --             OR post author/org and viewer have a block between them (BIDIRECTIONAL)
                    WHEN m.shared_post_id IS NOT NULL AND (
                        sp.post_id IS NULL 
                        OR sp.is_active = FALSE 
                        OR sp.is_removed = TRUE
                        -- Author's user account is deleted (row missing or deletion_execute_at set) or deactivated
                        OR (sp.author_id IS NOT NULL AND NOT EXISTS (
                            SELECT 1 FROM users u_a
                            WHERE u_a.user_id = sp.author_id 
                              AND (u_a.is_deactivated IS FALSE OR u_a.is_deactivated IS NULL)
                              AND u_a.deletion_execute_at IS NULL
                        ))
                        -- Author's org is deleted or deactivated
                        OR (sp.author_org_id IS NOT NULL AND EXISTS (
                            SELECT 1 FROM organizations o_a
                            WHERE o_a.org_id = sp.author_org_id 
                              AND (o_a.is_deleted = TRUE OR o_a.is_deactivated = TRUE)
                        ))
                        -- RULE 2: Post author/org has a bidirectional block with current viewer
                        OR (sp.author_org_id IS NULL AND EXISTS (
                            SELECT 1 FROM blocks b
                            WHERE (b.blocker_id = sp.author_id AND b.blocked_id = COALESCE($6::uuid, $4::uuid))
                               OR (b.blocker_id = COALESCE($6::uuid, $4::uuid) AND b.blocked_id = sp.author_id)
                        ))
                        OR (sp.author_org_id IS NOT NULL AND EXISTS (
                            SELECT 1 FROM blocks b
                            WHERE (b.blocker_id = sp.author_org_id AND b.blocked_id = COALESCE($6::uuid, $4::uuid))
                               OR (b.blocker_id = COALESCE($6::uuid, $4::uuid) AND b.blocked_id = sp.author_org_id)
                        ))
                    ) THEN true

                    -- RULE 1: Post URL in text — post is deleted/removed/inactive OR author blocked
                    WHEN m.shared_post_id IS NULL AND m.text_content LIKE '%/post/%' AND (
                        NOT EXISTS (
                            SELECT 1 FROM posts p
                            WHERE m.text_content LIKE '%' || p.post_id::text || '%'
                              AND p.is_active = TRUE 
                              AND (p.is_removed IS FALSE OR p.is_removed IS NULL)
                        )
                        OR EXISTS (
                            SELECT 1 FROM posts p
                            WHERE m.text_content LIKE '%' || p.post_id::text || '%'
                              AND (
                                  (p.author_org_id IS NULL AND EXISTS (
                                      SELECT 1 FROM blocks b
                                      WHERE (b.blocker_id = p.author_id AND b.blocked_id = COALESCE($6::uuid, $4::uuid))
                                         OR (b.blocker_id = COALESCE($6::uuid, $4::uuid) AND b.blocked_id = p.author_id)
                                  ))
                                  OR
                                  (p.author_org_id IS NOT NULL AND EXISTS (
                                      SELECT 1 FROM blocks b
                                      WHERE (b.blocker_id = p.author_org_id AND b.blocked_id = COALESCE($6::uuid, $4::uuid))
                                         OR (b.blocker_id = COALESCE($6::uuid, $4::uuid) AND b.blocked_id = p.author_org_id)
                                  ))
                              )
                        )
                    ) THEN true

                    -- RULE 1 + 2 + 3: Shared USER profile (by shared_profile_id, entity_type='profile', or /profile/ URL)
                    WHEN ((m.shared_profile_id IS NOT NULL AND m.shared_profile_type = 'user') OR (m.entity_type = 'profile' AND m.entity_id IS NOT NULL) OR (m.text_content LIKE '%/profile/%')) AND EXISTS (
                        SELECT 1 FROM users u2 
                        LEFT JOIN blocks b ON (
                            (b.blocker_id = u2.user_id AND b.blocked_id = COALESCE($6::uuid, $4::uuid))
                            OR (b.blocker_id = COALESCE($6::uuid, $4::uuid) AND b.blocked_id = u2.user_id)
                        )
                        WHERE (
                            (m.shared_profile_id IS NOT NULL AND u2.user_id = m.shared_profile_id)
                            OR (m.entity_id IS NOT NULL AND (u2.user_id::text = m.entity_id OR u2.account_name = m.entity_id))
                            OR (m.text_content LIKE '%' || u2.user_id::text || '%' OR m.text_content LIKE '%' || u2.account_name || '%')
                        )
                        AND (
                            b.blocker_id IS NOT NULL
                            OR u2.is_deactivated = TRUE
                            OR u2.deletion_execute_at IS NOT NULL
                        )
                    ) THEN true

                    -- RULE 1 + 2 + 3: Shared ORG profile (by shared_profile_id, entity_type='company', or /organization/ URL)
                    WHEN ((m.shared_profile_id IS NOT NULL AND m.shared_profile_type = 'company') OR (m.entity_type = 'company' AND m.entity_id IS NOT NULL) OR (m.text_content LIKE '%/organization/%')) AND EXISTS (
                        SELECT 1 FROM organizations o2
                        LEFT JOIN blocks b ON (
                            (b.blocked_id = COALESCE($6::uuid, $4::uuid) AND b.blocker_id = o2.org_id)
                            OR (b.blocker_id = COALESCE($6::uuid, $4::uuid) AND b.blocked_id = o2.org_id)
                        )
                        WHERE (
                            (m.shared_profile_id IS NOT NULL AND o2.org_id = m.shared_profile_id)
                            OR (m.entity_id IS NOT NULL AND (o2.org_id::text = m.entity_id OR o2.slug = m.entity_id))
                            OR (m.text_content LIKE '%' || o2.org_id::text || '%' OR m.text_content LIKE '%' || o2.slug || '%')
                        )
                        AND (
                            b.blocker_id IS NOT NULL
                            OR o2.is_deleted = TRUE
                            OR o2.is_deactivated = TRUE
                        )
                    ) THEN true

                    -- RULE 1 + 2 + 3: Shared Job/Offer — job is deleted/inactive OR recruiter/org has bidirectional block
                    WHEN m.entity_type IN ('job', 'offer') AND m.entity_id IS NOT NULL AND m.entity_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AND (
                        NOT EXISTS (
                            SELECT 1 FROM jobs j
                            WHERE j.job_id = (
                                CASE WHEN m.entity_type = 'offer' THEN (SELECT job_id FROM job_offers WHERE offer_id = m.entity_id::uuid)
                                     ELSE m.entity_id::uuid END
                            )
                            AND j.is_active = TRUE
                        )
                        OR EXISTS (
                            SELECT 1 FROM jobs j
                            LEFT JOIN active_users u ON j.recruiter_id = u.user_id
                            LEFT JOIN organizations c ON j.org_id = c.org_id
                            WHERE j.job_id = (
                                CASE WHEN m.entity_type = 'offer' THEN (SELECT job_id FROM job_offers WHERE offer_id = m.entity_id::uuid)
                                     ELSE m.entity_id::uuid END
                            )
                            AND (
                                u.user_id IS NULL
                                OR (j.org_id IS NOT NULL AND (c.is_deleted = TRUE OR c.is_deactivated = TRUE))
                                OR EXISTS (
                                    SELECT 1 FROM blocks b
                                    WHERE (j.org_id IS NULL AND (
                                        (b.blocker_id = j.recruiter_id AND b.blocked_id = COALESCE($6::uuid, $4::uuid))
                                        OR (b.blocker_id = COALESCE($6::uuid, $4::uuid) AND b.blocked_id = j.recruiter_id)
                                    ))
                                    OR (j.org_id IS NOT NULL AND (
                                        (b.blocker_id = j.org_id AND b.blocked_id = COALESCE($6::uuid, $4::uuid))
                                        OR (b.blocker_id = COALESCE($6::uuid, $4::uuid) AND b.blocked_id = j.org_id)
                                    ))
                                )
                            )
                        )
                    ) THEN true

                    -- RULE 1 + 2 + 3: Job/Offer URL in text — job is deleted/inactive OR recruiter/org has bidirectional block
                    WHEN (m.text_content LIKE '%/job%' OR m.text_content LIKE '%/offer%') AND EXISTS (
                        SELECT 1 FROM jobs j
                        LEFT JOIN active_users u ON j.recruiter_id = u.user_id
                        LEFT JOIN organizations o ON j.org_id = o.org_id
                        WHERE (m.text_content LIKE '%' || j.job_id::text || '%')
                          AND (
                              j.is_active = FALSE 
                              OR u.user_id IS NULL 
                              OR (j.org_id IS NOT NULL AND (o.is_deleted = TRUE OR o.is_deactivated = TRUE))
                              OR EXISTS (
                                  SELECT 1 FROM blocks b 
                                  WHERE (j.org_id IS NULL AND (
                                      (b.blocker_id = j.recruiter_id AND b.blocked_id = COALESCE($6::uuid, $4::uuid))
                                      OR (b.blocker_id = COALESCE($6::uuid, $4::uuid) AND b.blocked_id = j.recruiter_id)
                                  ))
                                  OR (j.org_id IS NOT NULL AND (
                                      (b.blocker_id = j.org_id AND b.blocked_id = COALESCE($6::uuid, $4::uuid))
                                      OR (b.blocker_id = COALESCE($6::uuid, $4::uuid) AND b.blocked_id = j.org_id)
                                  ))
                              )
                          )
                    ) THEN true

                    -- RULE: Message sent while block is active between sender and viewer (from block timestamp onward)
                    WHEN m.sender_id IS NOT NULL AND EXISTS (
                        SELECT 1 FROM blocks b
                        WHERE b.blocker_id = m.sender_id AND b.blocked_id = COALESCE($6::uuid, $4::uuid)
                          AND m.created_at >= b.created_at
                    ) THEN true

                    ELSE false
                END AS is_unavailable,
                CASE 
                    WHEN m.shared_post_id IS NOT NULL AND sp.post_id IS NOT NULL AND sp.is_active = TRUE AND (sp.is_removed IS FALSE OR sp.is_removed IS NULL)
                    THEN
                        json_build_object(
                            'post_id', sp.post_id,
                            'content', sp.content,
                            'post_type', sp.post_type,
                            'title', sp.title,
                            'author', COALESCE(sp_org.name, au.display_name, 'Unknown Author'),
                            'author_avatar', COALESCE(sp_org.logo_url, au.display_avatar, NULL),
                            'author_headline', COALESCE(sp_org.headline, au.display_headline, NULL),
                            'author_username', au.display_username,
                            'is_organization_post', (sp.author_org_id IS NOT NULL),
                            'media', (SELECT json_agg(json_build_object('url', url, 'media_type', media_type)) FROM post_media WHERE post_id = sp.post_id),
                            'poll', (
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
                                FROM post_polls pp WHERE pp.post_id = sp.post_id
                            )
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
                            'name', pu.display_name,
                            'avatar', pu.display_avatar,
                            'headline', pu.display_headline,
                            'location', pu.location,
                            'username', pu.display_username
                        ) FROM user_display_profiles pu WHERE pu.user_id = m.shared_profile_id)
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
                            'sender_name', COALESCE(rc.name, ru.display_name, 'Deleted User'),
                            'message_type', rm.message_type,
                            'media', (SELECT json_agg(json_build_object('url', rmm.url, 'media_type', rmm.media_type, 'filename', rmm.filename)) FROM message_media rmm WHERE rmm.message_id = rm.message_id)
                        ) 
                        FROM messages rm 
                        LEFT JOIN user_display_profiles ru ON rm.sender_id = ru.user_id
                        LEFT JOIN organization_display_profiles rc ON rm.author_org_id = rc.org_id
                        WHERE rm.message_id = m.replied_msg_id)
                    ELSE NULL
                END AS reply_message,
                COALESCE(
                    (SELECT JSON_AGG(
                        JSON_BUILD_OBJECT(
                            'user_id', mr.user_id,
                            'full_name', rru.display_name,
                            'avatar', rru.display_avatar,
                            'emoji', mr.emoji,
                            'created_at', mr.created_at,
                            'updated_at', mr.updated_at
                        ) ORDER BY mr.updated_at DESC
                    ) FILTER (WHERE mr.reaction_id IS NOT NULL AND mr.emoji IS NOT NULL AND mr.emoji != '')
                    FROM message_reactions mr
                    JOIN user_display_profiles rru ON rru.user_id = mr.user_id
                    WHERE mr.message_id = m.message_id),
                    '[]'::json
                ) AS reactions
             FROM messages m
             LEFT JOIN user_display_profiles u ON m.sender_id = u.user_id
             LEFT JOIN users raw_u_msg ON m.sender_id = raw_u_msg.user_id
             LEFT JOIN organization_display_profiles c ON m.author_org_id = c.org_id
             LEFT JOIN organizations raw_org ON m.author_org_id = raw_org.org_id
             LEFT JOIN posts sp ON m.shared_post_id = sp.post_id
             LEFT JOIN user_display_profiles au ON sp.author_id = au.user_id
             LEFT JOIN organization_display_profiles sp_org ON sp.author_org_id = sp_org.org_id
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
             -- Filter out messages created before this participant deleted/cleared the chat
             AND NOT EXISTS (
                SELECT 1 FROM conversation_participants cp_del
                WHERE cp_del.conversation_id = m.conversation_id
                AND (
                    ($6::uuid IS NOT NULL AND cp_del.org_id = $6)
                    OR
                    ($6::uuid IS NULL AND cp_del.user_id = $4)
                )
                AND cp_del.deleted_at IS NOT NULL
                AND m.created_at <= cp_del.deleted_at
             )
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
                        text_content: "This message was deleted for you.",
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
        const actorScope = getSocialActorScope(req, req.query.companyId || null);
        const companyId = actorScope.orgId;

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

        if (companyId) {
            await logAudit(pool, {
                entityId: companyId,
                actorId: userId,
                action: "EDIT_MESSAGE",
                metadata: { messageId: message_id, conversationId: updatedMessage.conversation_id }
            });
        }

        // Notify all participants that the message was edited
        const { conversation_id } = updatedMessage;
        socketService.notifyConversation(conversation_id, "message_edited", {
            messageId: message_id,
            conversationId: conversation_id,
            text_content
        });

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
                    WHEN COALESCE(NULLIF(n.metadata->>'org_id', ''), NULLIF(n.metadata->>'orgId', '')) IS NOT NULL THEN c.name 
                    ELSE u.display_name 
                END as actor_name, 
                CASE 
                    WHEN COALESCE(NULLIF(n.metadata->>'org_id', ''), NULLIF(n.metadata->>'orgId', '')) IS NOT NULL THEN c.logo_url 
                    ELSE u.display_avatar 
                END as actor_avatar,
                COALESCE(c.slug, u.display_username) as actor_slug,
                (COALESCE(NULLIF(n.metadata->>'org_id', ''), NULLIF(n.metadata->>'orgId', '')) IS NOT NULL) as is_company_actor,
                cr.request_id as request_id, 
                cr.status as request_status
            FROM notifications n 
            LEFT JOIN user_display_profiles u ON n.sender_id = u.user_id 
            LEFT JOIN organization_display_profiles c ON COALESCE(NULLIF(n.metadata->>'org_id', ''), NULLIF(n.metadata->>'orgId', ''))::uuid = c.org_id
            LEFT JOIN connection_requests cr ON n.sender_id = cr.sender_id AND n.user_id = cr.receiver_id AND cr.status = 'pending'
            WHERE 
        `;

        if (companyId) {
            query += `
                n.recipient_org_id = $1
                AND NOT EXISTS (
                    SELECT 1
                    FROM blocks b
                    WHERE (b.blocker_id = $1 AND ((n.sender_id IS NOT NULL AND b.blocked_id = n.sender_id) OR (NULLIF(n.metadata->>'org_id', '')::uuid IS NOT NULL AND b.blocked_id = (n.metadata->>'org_id')::uuid)))
                       OR (b.blocked_id = $1 AND ((n.sender_id IS NOT NULL AND b.blocker_id = n.sender_id) OR (NULLIF(n.metadata->>'org_id', '')::uuid IS NOT NULL AND b.blocker_id = (n.metadata->>'org_id')::uuid)))
                )
            `;
        } else {
            query += `
                n.user_id = $1
                AND n.recipient_org_id IS NULL
                AND NOT EXISTS (
                    SELECT 1
                    FROM blocks b
                    WHERE (b.blocker_id = $1 AND ((n.sender_id IS NOT NULL AND b.blocked_id = n.sender_id) OR (NULLIF(n.metadata->>'org_id', '')::uuid IS NOT NULL AND b.blocked_id = (n.metadata->>'org_id')::uuid)))
                       OR (b.blocked_id = $1 AND ((n.sender_id IS NOT NULL AND b.blocker_id = n.sender_id) OR (NULLIF(n.metadata->>'org_id', '')::uuid IS NOT NULL AND b.blocker_id = (n.metadata->>'org_id')::uuid)))
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
    const isOrgActor = req.actor?.type === "ORGANIZATION";
    const blockerId = isOrgActor ? req.actor.orgId : req.user?.sub;
    const targetId = req.params.id;

    if (!blockerId || !targetId) {
        return res.status(400).json({ message: "Invalid request parameters" });
    }

    if (blockerId === targetId) {
        return res.status(400).json({ message: isOrgActor ? "An organization cannot block itself" : "Cannot block yourself" });
    }

    try {
        // Actor & Ownership Validation
        if (!isOrgActor) {
            // User is blocking target. Verify target is not an organization created/managed by this user
            const orgCheck = await pool.query(
                `SELECT org_id, created_by FROM organizations WHERE org_id = $1`,
                [targetId]
            );
            if (orgCheck.rowCount > 0) {
                const org = orgCheck.rows[0];
                if (org.created_by === blockerId) {
                    return res.status(400).json({ message: "You cannot block an organization that you own or manage" });
                }
                const memberCheck = await pool.query(
                    `SELECT 1 FROM organization_members WHERE org_id = $1 AND user_id = $2 AND status = 'ACTIVE'`,
                    [targetId, blockerId]
                );
                if (memberCheck.rowCount > 0) {
                    return res.status(400).json({ message: "You cannot block an organization that you own or manage" });
                }
            }
        } else {
            // Check if acting user on behalf of organization is Owner or Admin
            const isOwner = req.actor.roleName === 'Owner' || (req.actor.permissions && req.actor.permissions.includes('*'));
            const isAdmin = (req.actor.roleName || '').toUpperCase() === 'ADMIN' || isOwner;

            if (!isOwner && !isAdmin) {
                return res.status(403).json({ success: false, message: "Only organization owners or administrators can block accounts" });
            }

            // Organization is blocking target. Verify target is not an Owner or Admin of this organization.
            const targetRoleCheck = await pool.query(
                `SELECT om.role_id, r.name AS role_name, r.permissions, o.created_by
                 FROM organizations o
                 LEFT JOIN organization_members om ON om.org_id = o.org_id AND om.user_id = $2 AND om.status = 'ACTIVE'
                 LEFT JOIN organization_roles r ON om.role_id = r.role_id
                 WHERE o.org_id = $1`,
                [blockerId, targetId]
            );

            if (targetRoleCheck.rowCount > 0) {
                const row = targetRoleCheck.rows[0];
                const isCreator = row.created_by === targetId;
                const roleName = (row.role_name || '').toUpperCase();
                const isTargetOwner = isCreator || roleName === 'OWNER' || (row.permissions && Array.isArray(row.permissions) && row.permissions.includes('*'));
                const isTargetAdmin = roleName === 'ADMIN' || isTargetOwner;

                if (isTargetAdmin) {
                    return res.status(400).json({ success: false, message: "An organization cannot block its own owner or administrator." });
                }
            }
        }

        const BlockModel = require("../../models/block.model");

        // Use model to record block (foreign key is safe)
        await BlockModel.blockUser(blockerId, targetId, isOrgActor);
        // NEW: Immediately invalidate the blocked user's feed cache
        await BlockModel.invalidateCache(targetId);

        // Remove any existing relationships (membership, followers, following, connections, requests)
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            if (isOrgActor) {
                // Delete membership if target was a non-admin member
                await client.query(
                    "DELETE FROM organization_members WHERE org_id = $1 AND user_id = $2",
                    [blockerId, targetId]
                );

                // Delete followers (target user following org)
                await client.query(
                    "DELETE FROM organization_followers WHERE org_id = $1 AND user_id = $2",
                    [blockerId, targetId]
                );

                // Delete org follows (org following target user)
                await client.query(
                    "DELETE FROM organization_user_follows WHERE org_id = $1 AND user_id = $2",
                    [blockerId, targetId]
                );

                // Delete org-to-org follows (bidirectional)
                await client.query(
                    "DELETE FROM organization_org_follows WHERE (follower_org_id = $1 AND following_org_id = $2) OR (follower_org_id = $2 AND following_org_id = $1)",
                    [blockerId, targetId]
                );

                // Delete org connections & connection requests
                await client.query(
                    "DELETE FROM organization_connections WHERE (org_id = $1 AND user_id = $2) OR (org_id = $2 AND user_id = $1)",
                    [blockerId, targetId]
                );
                await client.query(
                    "DELETE FROM organization_connection_requests WHERE (org_id = $1 AND user_id = $2) OR (org_id = $2 AND user_id = $1)",
                    [blockerId, targetId]
                );
                // Delete notifications between org blocker and target user
                await client.query(
                    `DELETE FROM notifications 
                     WHERE (user_id = $2 AND (sender_id = $1 OR NULLIF(metadata->>'org_id', '')::uuid = $1))
                        OR (recipient_org_id = $1 AND sender_id = $2)`,
                    [blockerId, targetId]
                );
            } else {
                // Delete user connections (bidirectional)
                await client.query(
                    "DELETE FROM connections WHERE (user_id = $1 AND connected_user_id = $2) OR (user_id = $2 AND connected_user_id = $1)",
                    [blockerId, targetId]
                );
                // Delete follows (bidirectional)
                await client.query(
                    "DELETE FROM followers WHERE (follower_id = $1 AND following_id = $2) OR (follower_id = $2 AND following_id = $1)",
                    [blockerId, targetId]
                );
                // Delete pending requests (bidirectional)
                await client.query(
                    "DELETE FROM connection_requests WHERE (sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1)",
                    [blockerId, targetId]
                );
                // Delete org follows / connections if targetId is an org
                await client.query(
                    "DELETE FROM organization_user_follows WHERE user_id = $1 AND org_id = $2",
                    [blockerId, targetId]
                );
                await client.query(
                    "DELETE FROM organization_followers WHERE user_id = $1 AND org_id = $2",
                    [blockerId, targetId]
                );
                await client.query(
                    "DELETE FROM organization_connections WHERE user_id = $1 AND org_id = $2",
                    [blockerId, targetId]
                );
                await client.query(
                    "DELETE FROM organization_connection_requests WHERE user_id = $1 AND org_id = $2",
                    [blockerId, targetId]
                );
                await client.query(
                    "DELETE FROM community_subscriptions WHERE user_id = $1 AND community_id IN (SELECT community_id FROM communities WHERE org_id = $2)",
                    [blockerId, targetId]
                );
                // Delete notifications between user blocker and target
                await client.query(
                    `DELETE FROM notifications 
                     WHERE (user_id = $1 AND (sender_id = $2 OR NULLIF(metadata->>'org_id', '')::uuid = $2))
                        OR (user_id = $2 AND (sender_id = $1 OR NULLIF(metadata->>'org_id', '')::uuid = $1))`,
                    [blockerId, targetId]
                );
            }

            await client.query("COMMIT");
        } catch (e) {
            await client.query("ROLLBACK");
            console.error("Block cleanup error", e);
        } finally {
            client.release();
        }

        const blockerRes = isOrgActor
            ? await pool.query(`SELECT name as full_name, logo_url as avatar_url FROM organizations WHERE org_id = $1`, [blockerId])
            : await pool.query(`SELECT full_name, avatar_url FROM users WHERE user_id = $1`, [blockerId]);
        const blockerInfo = blockerRes.rows[0] || {};

        const convRes = await pool.query(
            `SELECT c.conversation_id
             FROM conversations c
             JOIN conversation_participants cp1 ON c.conversation_id = cp1.conversation_id AND cp1.user_id = $1
             JOIN conversation_participants cp2 ON c.conversation_id = cp2.conversation_id AND cp2.user_id = $2
             WHERE c.is_group = FALSE AND c.is_active = TRUE`,
            [req.user.sub, targetId]
        );
        const conversation_id = convRes.rowCount > 0 ? convRes.rows[0].conversation_id : null;

        const payload = {
            blocked_by_user_id: blockerId,
            blocker_id: blockerId,
            target_id: targetId,
            user_id: targetId,
            blocked_by_name: blockerInfo.full_name,
            blocked_by_avatar: blockerInfo.avatar_url,
            is_org_block: isOrgActor,
            is_blocked: true,
            status: "blocked",
            conversation_id
        };

        socketService.notifyUser(targetId, "user_blocked", payload);
        socketService.notifyUser(targetId, "relationshipUpdated", payload);
        socketService.notifyUser(req.user.sub, "block_confirmed", payload);
        socketService.notifyUser(req.user.sub, "relationshipUpdated", payload);

        if (conversation_id && socketService.io) {
            const convRoom = `conversation_${conversation_id}`;
            socketService.io.to(convRoom).emit("user_blocked", payload);
            socketService.io.to(convRoom).emit("relationshipUpdated", payload);
            socketService.io.to(convRoom).emit("conversation_updated", {
                conversation_id,
                is_blocked: true,
                blocked_by: blockerId,
            });
        }

        if (isOrgActor) {
            const { logAudit } = require("../../services/audit.service");
            logAudit(pool, {
                entityId: blockerId,
                entityType: 'ORGANIZATION',
                actorId: req.user.sub,
                action: 'ORGANIZATION_BLOCK_ADDED',
                metadata: { targetId }
            }).catch(e => console.error("Audit log error:", e));

            if (socketService.io) {
                socketService.io.to(`org_${blockerId}`).emit("ORGANIZATION_USER_BLOCKED", payload);
                socketService.io.to(`org_${blockerId}`).emit("ORGANIZATION_BLOCK_UPDATED", payload);
            }
        }

        res.json({ message: isOrgActor ? "User blocked for organization" : "User blocked successfully" });
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
    const isOrgActor = req.actor?.type === "ORGANIZATION";
    const blockerId = isOrgActor ? req.actor.orgId : req.user.sub;
    const targetId = req.params.id;

    if (isOrgActor) {
        const isOwner = req.actor.roleName === 'Owner' || (req.actor.permissions && req.actor.permissions.includes('*'));
        const isAdmin = (req.actor.roleName || '').toUpperCase() === 'ADMIN' || isOwner;

        if (!isOwner && !isAdmin) {
            return res.status(403).json({ success: false, message: "Only organization owners or administrators can unblock accounts" });
        }
    }

    try {
        const BlockModel = require("../../models/block.model");
        await BlockModel.unblockUser(blockerId, targetId, isOrgActor);

        const unblockerRes = isOrgActor
            ? await pool.query(`SELECT name as full_name, logo_url as avatar_url FROM organizations WHERE org_id = $1`, [blockerId])
            : await pool.query(`SELECT full_name, avatar_url FROM users WHERE user_id = $1`, [blockerId]);
        const unblockerInfo = unblockerRes.rows[0] || {};

        const convRes = await pool.query(
            `SELECT c.conversation_id
             FROM conversations c
             JOIN conversation_participants cp1 ON c.conversation_id = cp1.conversation_id AND cp1.user_id = $1
             JOIN conversation_participants cp2 ON c.conversation_id = cp2.conversation_id AND cp2.user_id = $2
             WHERE c.is_group = FALSE AND c.is_active = TRUE`,
            [req.user.sub, targetId]
        );
        const conversation_id = convRes.rowCount > 0 ? convRes.rows[0].conversation_id : null;

        const payload = {
            unblocked_by_user_id: blockerId,
            blocker_id: blockerId,
            target_id: targetId,
            user_id: targetId,
            unblocked_by_name: unblockerInfo.full_name,
            unblocked_by_avatar: unblockerInfo.avatar_url,
            is_org_block: isOrgActor,
            is_blocked: false,
            status: "none",
            conversation_id
        };

        socketService.notifyUser(targetId, "user_unblocked", payload);
        socketService.notifyUser(targetId, "relationshipUpdated", payload);
        socketService.notifyUser(req.user.sub, "unblock_confirmed", payload);
        socketService.notifyUser(req.user.sub, "relationshipUpdated", payload);

        if (conversation_id && socketService.io) {
            const convRoom = `conversation_${conversation_id}`;
            socketService.io.to(convRoom).emit("user_unblocked", payload);
            socketService.io.to(convRoom).emit("relationshipUpdated", payload);
            socketService.io.to(convRoom).emit("conversation_updated", {
                conversation_id,
                is_blocked: false,
                blocked_by: null,
            });
        }

        if (isOrgActor) {
            const { logAudit } = require("../../services/audit.service");
            logAudit(pool, {
                entityId: blockerId,
                entityType: 'ORGANIZATION',
                actorId: req.user.sub,
                action: 'ORGANIZATION_BLOCK_REMOVED',
                metadata: { targetId }
            }).catch(e => console.error("Audit log error:", e));

            if (socketService.io) {
                socketService.io.to(`org_${blockerId}`).emit("ORGANIZATION_USER_UNBLOCKED", payload);
                socketService.io.to(`org_${blockerId}`).emit("ORGANIZATION_BLOCK_UPDATED", payload);
            }
        }

        res.json({ message: isOrgActor ? "User unblocked for organization" : "User unblocked successfully" });
    } catch (err) {
        console.error("Unblock user error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.getBlockedUsers = async (req, res) => {
    const isOrgActor = req.actor?.type === "ORGANIZATION";
    const blockerId = isOrgActor ? req.actor.orgId : req.user.sub;
    try {
        const BlockModel = require("../../models/block.model");
        const blockedUsers = isOrgActor
            ? await BlockModel.getOrgBlockedUsersDetails(blockerId)
            : await BlockModel.getBlockedUsersDetails(blockerId);
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
                (
                    SELECT COUNT(*) 
                    FROM followers f
                    JOIN active_users u ON f.follower_id = u.user_id
                    WHERE f.following_id = $1
                      AND NOT EXISTS (
                          SELECT 1 FROM blocks b
                          WHERE (b.blocker_id = $1 AND b.blocked_id = u.user_id)
                             OR (b.blocker_id = u.user_id AND b.blocked_id = $1)
                      )
                ) + (
                    SELECT COUNT(*) 
                    FROM organization_user_follows ouf
                    JOIN organizations o ON ouf.org_id = o.org_id
                    WHERE ouf.user_id = $1 AND o.is_deleted = FALSE
                ) as followers_count,
                (
                    SELECT COUNT(*) 
                    FROM followers f
                    JOIN active_users u ON f.following_id = u.user_id
                    WHERE f.follower_id = $1
                      AND NOT EXISTS (
                          SELECT 1 FROM blocks b
                          WHERE (b.blocker_id = $1 AND b.blocked_id = u.user_id)
                             OR (b.blocker_id = u.user_id AND b.blocked_id = $1)
                      )
                ) + (
                    SELECT COUNT(*) 
                    FROM organization_followers cf 
                    JOIN organizations c ON cf.org_id = c.org_id 
                    WHERE cf.user_id = $1 AND c.is_deleted = FALSE
                ) as following_count,
                (
                    SELECT COUNT(*) 
                    FROM connections c
                    JOIN active_users u ON c.connected_user_id = u.user_id
                    WHERE c.user_id = $1
                      AND NOT EXISTS (
                          SELECT 1 FROM blocks b 
                          WHERE (b.blocker_id = $1 AND b.blocked_id = u.user_id)
                             OR (b.blocker_id = u.user_id AND b.blocked_id = $1)
                      )
                ) + (
                    SELECT COUNT(*) 
                    FROM organization_connections cc 
                    JOIN organizations c ON cc.org_id = c.org_id 
                    WHERE cc.user_id = $1 AND c.is_deleted = FALSE
                ) as connections_count`,
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
            text: "wants to connect with you",
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
                text: "and you are now connected!",
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
                    text: "accepted the company's connection request",
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
                 JOIN active_users u ON u.user_id = mr.user_id
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
            // Update the reaction to have empty emoji
            await pool.query(
                `UPDATE message_reactions
                 SET emoji = '', updated_at = now()
                 WHERE message_id = $1 AND user_id = $2`,
                [messageId, userId]
            );

            // Fetch the cleared reaction details (including empty emoji)
            const clearedReactionRes = await pool.query(
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
                 JOIN active_users u ON u.user_id = mr.user_id
                 WHERE mr.message_id = $1 AND mr.user_id = $2`,
                [messageId, userId]
            );
            const clearedReaction = clearedReactionRes.rows[0];

            // Notify all conversation participants via socket
            socketService.notifyConversation(conversation_id, "message_reaction_updated", {
                messageId,
                conversationId: conversation_id,
                reaction: clearedReaction
            });

            return res.json({ success: true, reaction: clearedReaction });
        }
    } catch (err) {
        console.error("Upsert reaction error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

// Check if job/offer context has already been sent in a conversation and not deleted
exports.checkContextSent = async (req, res) => {
    const { conversationId } = req.params;
    const { entityId, entityType } = req.query;
    const userId = req.user.sub || req.user.user_id;

    if (!conversationId || !entityId || !entityType) {
        return res.status(400).json({ message: "conversationId, entityId, and entityType are required" });
    }

    try {
        // 1. Verify if user is participant of the conversation
        const partCheck = await pool.query(
            `SELECT 1 FROM conversation_participants 
             WHERE conversation_id = $1 
             AND (user_id = $2 OR org_id IN (SELECT org_id FROM organization_members WHERE user_id = $2)) 
             AND left_at IS NULL`,
            [conversationId, userId]
        );

        if (partCheck.rowCount === 0) {
            return res.status(403).json({ message: "Not a participant in this conversation" });
        }

        // 2. Identify potential entity IDs to search
        let entityIdsToCheck = [entityId];
        let jobId = null;

        if (entityType === 'job') {
            jobId = entityId;
        } else if (entityType === 'offer') {
            const offerRes = await pool.query(
                `SELECT job_id FROM job_offers WHERE offer_id = $1`,
                [entityId]
            );
            if (offerRes.rowCount > 0 && offerRes.rows[0].job_id) {
                jobId = offerRes.rows[0].job_id;
                entityIdsToCheck.push(jobId);
            }
        }

        if (jobId) {
            const offersRes = await pool.query(
                `SELECT offer_id FROM job_offers WHERE job_id = $1`,
                [jobId]
            );
            for (const row of offersRes.rows) {
                if (row.offer_id && !entityIdsToCheck.includes(row.offer_id)) {
                    entityIdsToCheck.push(row.offer_id);
                }
            }
        }

        // 3. Search messages for matching entity context
        // Check for any message in this conversation with entity_id equal to entityId or jobIdOfOffer
        // and is_deleted_for_everyone is FALSE
        // and is not deleted for the user
        const msgCheck = await pool.query(
            `SELECT 1 FROM messages m
             WHERE m.conversation_id = $1 
               AND m.is_deleted_for_everyone = FALSE 
               AND NOT EXISTS (
                 SELECT 1 FROM message_delete md 
                 WHERE md.message_id = m.message_id AND md.user_id = $3
               )
               AND m.entity_id::text = ANY($2::text[])
             LIMIT 1`,
            [conversationId, entityIdsToCheck, userId]
        );

        const isSent = msgCheck.rowCount > 0;
        return res.json({ sent: isSent });

    } catch (err) {
        console.error("Check context sent error:", err);
        return res.status(500).json({ message: "Internal server error" });
    }
};

// --- ORGANIZATION FOLLOWING (Option B) ---

// Organization follows a user
exports.organizationFollowUser = async (req, res) => {
    const { orgId, userId } = req.params;
    const { sourcePostId } = req.body || {};
    try {
        await pool.query(
            `INSERT INTO organization_user_follows (org_id, user_id, source_post_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
            [orgId, userId, sourcePostId || null]
        );
        res.status(200).json({ success: true, message: "Organization followed user" });
    } catch (err) {
        console.error("organizationFollowUser error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

// Organization unfollows a user
exports.organizationUnfollowUser = async (req, res) => {
    const { orgId, userId } = req.params;
    try {
        await pool.query(
            `DELETE FROM organization_user_follows WHERE org_id = $1 AND user_id = $2`,
            [orgId, userId]
        );
        res.status(200).json({ success: true, message: "Organization unfollowed user" });
    } catch (err) {
        console.error("organizationUnfollowUser error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

// Organization follows an organization
exports.organizationFollowOrganization = async (req, res) => {
    const { orgId, targetOrgId } = req.params;
    const { sourcePostId } = req.body || {};
    if (orgId === targetOrgId) {
        return res.status(400).json({ message: "Cannot follow yourself" });
    }
    try {
        await pool.query(
            `INSERT INTO organization_org_follows (follower_org_id, following_org_id, source_post_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
            [orgId, targetOrgId, sourcePostId || null]
        );
        res.status(200).json({ success: true, message: "Organization followed organization" });
    } catch (err) {
        console.error("organizationFollowOrganization error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

// Organization unfollows an organization
exports.organizationUnfollowOrganization = async (req, res) => {
    const { orgId, targetOrgId } = req.params;
    try {
        await pool.query(
            `DELETE FROM organization_org_follows WHERE follower_org_id = $1 AND following_org_id = $2`,
            [orgId, targetOrgId]
        );
        res.status(200).json({ success: true, message: "Organization unfollowed organization" });
    } catch (err) {
        console.error("organizationUnfollowOrganization error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

// Get list of entities an organization is following
exports.getOrganizationFollowing = async (req, res) => {
    const { orgId } = req.params;
    const { search } = req.query;

    try {
        const isOwnOrgActor = req.actor && req.actor.type === "ORGANIZATION" && req.actor.orgId === orgId;

        if (!isOwnOrgActor) {
            const privacyRes = await pool.query(
                `SELECT following_visibility FROM organization_privacy_settings WHERE org_id = $1`,
                [orgId]
            );
            const followingVisibility = privacyRes.rows[0]?.following_visibility || "everyone";

            if (followingVisibility === "no_one") {
                return res.status(200).json({ success: true, data: [], is_restricted: true, message: "The business page owner has restricted access to their following." });
            } else if (followingVisibility === "followers_only") {
                let isFollower = false;
                if (req.actor && req.actor.type === "ORGANIZATION" && req.actor.orgId) {
                    const check = await pool.query(
                        `SELECT 1 FROM organization_org_follows WHERE following_org_id = $1 AND follower_org_id = $2`,
                        [orgId, req.actor.orgId]
                    );
                    isFollower = check.rowCount > 0;
                } else if (req.user?.sub) {
                    const check = await pool.query(
                        `SELECT 1 FROM organization_followers WHERE org_id = $1 AND user_id = $2`,
                        [orgId, req.user.sub]
                    );
                    isFollower = check.rowCount > 0;
                }
                if (!isFollower) {
                    return res.status(200).json({ success: true, data: [], is_restricted: true, message: "The business page owner has restricted access to their following." });
                }
            }
        }
        let userQuery = `
            SELECT u.user_id, u.full_name AS name, u.avatar_url AS avatar, u.headline, f.created_at, 'user' as type
            FROM organization_user_follows f
            JOIN active_users u ON f.user_id = u.user_id
            WHERE f.org_id = $1
        `;

        let companyQuery = `
            SELECT c.org_id as user_id, c.name AS name, c.logo_url as avatar, c.industry as headline, cf.created_at, 'company' as type
            FROM organization_org_follows cf
            JOIN organizations c ON cf.following_org_id = c.org_id
            WHERE cf.follower_org_id = $1 AND c.is_deleted = FALSE
        `;

        const params = [orgId];

        if (search && search.trim()) {
            userQuery += ` AND (u.full_name ILIKE $2 OR u.headline ILIKE $2)`;
            companyQuery += ` AND (c.name ILIKE $2 OR c.industry ILIKE $2)`;
            params.push(`%${search.trim()}%`);
        }

        const fullQuery = `(${userQuery}) UNION ALL (${companyQuery}) ORDER BY created_at DESC`;
        const result = await pool.query(fullQuery, params);

        res.status(200).json({ success: true, data: result.rows });
    } catch (err) {
        console.error("getOrganizationFollowing error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

// Toggle conversation category between General and Jobs tabs (Context menu action)
exports.toggleJobChatCategory = async (req, res, next) => {
    try {
        const { conversationId } = req.params;
        const { isJobChat } = req.body;

        if (typeof isJobChat !== "boolean") {
            return res.status(400).json({ message: "isJobChat boolean parameter required" });
        }

        const updateRes = await pool.query(
            `UPDATE conversations SET is_job_chat = $2, updated_at = NOW() WHERE conversation_id = $1 RETURNING *`,
            [conversationId, isJobChat]
        );

        if (updateRes.rowCount === 0) {
            return res.status(404).json({ message: "Conversation not found" });
        }

        const socketService = require("../../core/infrastructure/socket.service");
        const socketPayload = { conversationId, isJobChat };
        socketService.notifyParticipants(conversationId, "conversationCategoryUpdated", socketPayload);
        socketService.notifyParticipants(conversationId, "conversation_updated", socketPayload);
        socketService.notifyParticipants(conversationId, "conversation_job_status_changed", socketPayload);

        return res.json({
            success: true,
            conversationId,
            isJobChat,
            message: `Conversation categorized under ${isJobChat ? "Jobs" : "General"}`
        });
    } catch (err) {
        if (typeof next === "function") return next(err);
        return res.status(500).json({ message: err.message || "Failed to update conversation category" });
    }
};


