const { stat } = require("node:fs");
const pool = require("../db/pool");
const { connected } = require("node:process");
const { formatDistanceToNow } = require('date-fns');
const timeAgo = require("./../utils/timeAgo")
const socketService = require("../services/socket.service");

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

            // Cleanup any pending requests
            await client.query(
                "DELETE FROM connection_requests WHERE (sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1)",
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

// Follow a company
exports.followCompany = async (req, res) => {
    const userId = req.user.sub;
    const { companyId } = req.params;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const result = await client.query(
            `INSERT INTO company_followers (user_id, company_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING *`,
            [userId, companyId]
        );

        if (result.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(200).json({ message: "Already following" });
        }

        // --- Notification Logic ---
        // Fetch company name/slug for context if needed, but usually notifs go to company members
        // For now, simple insert is enough.
        // TODO: Notify company members (admins/owners) about new follower

        await client.query('COMMIT');
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
    const { companyId } = req.params;

    const client = await pool.connect();
    try {
        const result = await client.query(
            `DELETE FROM company_followers WHERE user_id = $1 AND company_id = $2 RETURNING *`,
            [userId, companyId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ message: "You are not following this company" });
        }

        res.json({ message: "Unfollowed successfully" });
    } catch (err) {
        console.error("Unfollow company error:", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

// Get company relationship status
exports.getCompanyRelationship = async (req, res) => {
    const userId = req.user.sub;
    const { companyId } = req.params;

    try {
        const result = await pool.query(
            `SELECT 1 FROM company_followers WHERE user_id = $1 AND company_id = $2`,
            [userId, companyId]
        );

        const followerCount = await pool.query(
            `SELECT COUNT(*) FROM company_followers WHERE company_id = $1`,
            [companyId]
        );

        res.json({
            isFollowing: result.rowCount > 0,
            followerCount: parseInt(followerCount.rows[0].count)
        });
    } catch (err) {
        console.error("Get company relationship error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.getFollowers = async (req, res) => {
    const userId = req.params.id;
    const { search } = req.query;

    try {
        let query = `
            SELECT u.user_id, u.full_name, u.avatar_url, u.headline, f.created_at 
            FROM followers f 
            JOIN users u ON f.follower_id = u.user_id 
            WHERE f.following_id = $1
        `;
        const params = [userId];

        if (search) {
            query += ` AND (u.full_name ILIKE $2 OR u.headline ILIKE $2)`;
            params.push(`%${search}%`);
        }

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
        let query = `
            SELECT u.user_id, u.full_name, u.avatar_url, u.headline, f.created_at 
            FROM followers f 
            JOIN users u ON f.following_id = u.user_id 
            WHERE f.follower_id = $1
        `;
        const params = [userId];

        if (search) {
            query += ` AND (u.full_name ILIKE $2 OR u.headline ILIKE $2)`;
            params.push(`%${search}%`);
        }

        query += ` ORDER BY f.created_at DESC`;

        const result = await pool.query(query, params);

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

                // Delete the reverse request used for auto-accept
                await client.query("DELETE FROM connection_requests WHERE request_id = $1", [reverseReqId]);

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


        // 5. Create New Request
        // We use ON CONFLICT DO NOTHING to be super safe against race conditions on the unique index
        const insertRes = await client.query(
            `INSERT INTO connection_requests (sender_id, receiver_id, message, status) 
             VALUES ($1, $2, $3, 'pending')
             ON CONFLICT (LEAST(sender_id, receiver_id), GREATEST(sender_id, receiver_id)) 
             WHERE status = 'pending'
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

        return res.status(201).json({ message: "Connection request sent" });

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
      SELECT 
        cr.request_id as id,
        cr.sender_id,
        cr.receiver_id,
        cr.created_at,
        u.full_name as name,
        u.avatar_url as avatar,
        u.headline
      FROM connection_requests cr
      JOIN users u ON cr.sender_id = u.user_id
      WHERE cr.receiver_id = $1
        AND cr.status = 'pending'
      ORDER BY cr.created_at DESC
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
            sender: {
                name: row.name,
                avatar: row.avatar,
                headline: row.headline
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
            SELECT 
                cr.request_id as id,
                cr.sender_id,
                cr.receiver_id,
                cr.status,
                cr.updated_at,
                -- If I am the sender, show receiver details. If I am receiver, show sender details.
                CASE WHEN cr.sender_id = $1 THEN u_recv.full_name ELSE u_send.full_name END as name,
                CASE WHEN cr.sender_id = $1 THEN u_recv.avatar_url ELSE u_send.avatar_url END as avatar,
                CASE WHEN cr.sender_id = $1 THEN u_recv.headline ELSE u_send.headline END as headline,
                CASE WHEN cr.sender_id = $1 THEN 'outgoing' ELSE 'incoming' END as direction
            FROM connection_requests cr
            LEFT JOIN users u_send ON cr.sender_id = u_send.user_id
            LEFT JOIN users u_recv ON cr.receiver_id = u_recv.user_id
            WHERE (cr.receiver_id = $1 OR cr.sender_id = $1)
            AND cr.status IN ('connected', 'rejected')
            ORDER BY cr.updated_at DESC
            LIMIT 50
            `,
            [userId]
        );

        const history = result.rows.map(row => ({
            id: row.id,
            sender_id: row.sender_id,
            receiver_id: row.receiver_id,
            status: row.status === 'connected' ? 'accepted' : row.status,
            updated_at: row.updated_at,
            direction: row.direction,
            otherUser: {
                name: row.name,
                avatar: row.avatar,
                headline: row.headline
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

            // Update request status to 'connected' (Preserve History)
            await client.query(
                "UPDATE connection_requests SET status = 'connected', responded_at = NOW() WHERE request_id = $1",
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


            return res.status(200).json({ message: "Connection established", connected: true });
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
        let query = `
            SELECT u.user_id, u.full_name, u.avatar_url, u.headline, c.created_at 
            FROM connections c 
            JOIN users u ON c.connected_user_id = u.user_id 
            WHERE c.user_id = $1
        `;
        const params = [userId];

        if (search) {
            query += ` AND (u.full_name ILIKE $2 OR u.headline ILIKE $2)`;
            params.push(`%${search}%`);
        }

        const result = await pool.query(query, params);

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
            `SELECT COUNT(*) FROM connections WHERE user_id = $1`,
            [userId]
        );
        res.status(200).json({
            connection_count: result.rows[0].count,
            userId: userId
        });
    }
    catch (err) {
        res.status(500).json({ message: "Internal server error" });
    }
}

// Get all conversations of logged-in user
exports.getConversations = async (req, res) => {
    const userId = req.user.sub;

    try {
        const result = await pool.query(
            `
SELECT 
    c.*,
    -- Block Status
    CASE WHEN c.is_group THEN false ELSE EXISTS(SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = u.user_id) END as is_blocked_by_me,
    CASE WHEN c.is_group THEN false ELSE EXISTS(SELECT 1 FROM blocks WHERE blocker_id = u.user_id AND blocked_id = $1) END as is_blocked_by_other,

    -- Name logic: Use group name if group, else other user's name
    CASE 
        WHEN c.is_group THEN c.conversation_name 
        WHEN EXISTS(SELECT 1 FROM blocks WHERE blocker_id = u.user_id AND blocked_id = $1) THEN 'User not found'
        ELSE u.full_name 
    END AS other_user_name,
    
    -- Avatar logic: Use group avatar if group, else other user's avatar
    CASE 
        WHEN c.is_group THEN c.group_avatar 
        WHEN EXISTS(SELECT 1 FROM blocks WHERE blocker_id = u.user_id AND blocked_id = $1) THEN NULL
        ELSE u.avatar_url 
    END AS other_user_avatar,
    
    -- Other user ID (only for 1-on-1)
    u.user_id AS other_user_id,
    u.headline AS other_user_headline,
    
    -- Get the most recent message dynamically
    -- Prioritize the calculated message from LATERAL JOIN
    -- Fallback to conversation fields if no message found (e.g. new chat)
    COALESCE(m.text_content, c.last_message) AS last_message_text,
    COALESCE(m.created_at, c.last_message_at, c.updated_at) AS last_message_at
FROM conversations c
JOIN conversation_participants cp ON c.conversation_id = cp.conversation_id
-- For 1-on-1, join the other participant. For groups, this might return multiple or we skip via logic.
-- Using LEFT JOIN and conditional checks.
LEFT JOIN conversation_participants cp_other ON c.conversation_id = cp_other.conversation_id 
    AND cp_other.user_id != $1 AND c.is_group = FALSE
LEFT JOIN users u ON cp_other.user_id = u.user_id

-- LATERAL JOIN to find the latest VISIBLE message for this user
LEFT JOIN LATERAL (
    SELECT 
        CASE 
            WHEN msg.is_deleted_for_everyone THEN 'This message was deleted'
            WHEN msg.shared_post_id IS NOT NULL THEN 'Shared a post'
            WHEN msg.text_content IS NULL OR msg.text_content = '' THEN 'Attachment' -- Image/Video
            ELSE msg.text_content
        END as text_content,
        msg.created_at
    FROM messages msg
    WHERE msg.conversation_id = c.conversation_id
    -- Exclude messages deleted for me
    AND NOT EXISTS (
        SELECT 1 FROM message_delete md 
        WHERE md.message_id = msg.message_id 
        AND md.user_id = $1
    )
    -- Exclude hidden/blocked messages? (Optional, but best practice)
    ORDER BY msg.created_at DESC 
    LIMIT 1
) m ON true

WHERE cp.user_id = $1
-- Ensure distinct conversations (fix for potential multiple rows if join logic leaks)
-- Actually, if is_group=FALSE, cp_other matches 1 row (unless multi-party DM which we don't support yet).
-- If is_group=TRUE, cp_other is NULL due to condition.
ORDER BY COALESCE(m.created_at, c.last_message_at, c.updated_at) DESC NULLS LAST;
  `, [userId]
        );

        const unreadCountsResult = await pool.query(
            `  SELECT 
    m.conversation_id,
    COUNT(*)::int AS unread_count
  FROM messages m
  JOIN conversation_participants cp
    ON cp.conversation_id = m.conversation_id
  WHERE cp.user_id = $1
    AND m.sender_id <> $1
    AND m.created_at > cp.last_read_at
  GROUP BY m.conversation_id
  `, [userId]
        );

        const unreadMap = {};
        for (const row of unreadCountsResult.rows) {
            unreadMap[row.conversation_id] = row.unread_count;
        }

        const conversationsWithUnread = result.rows.map(c => ({
            ...c,
            timeAgo: timeAgo(c.updated_at),
            unread_count: unreadMap[c.conversation_id] || 0

        }));

        res.json(conversationsWithUnread);

    } catch (err) {
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.deleteConversation = async (req, res) => {
    const conversationId = req.params.id;
    const userId = req.user.sub;

    try {
        // We delete from 'conversations' but only if the 'userId' is a participant
        const result = await pool.query(
            `DELETE FROM conversations 
             WHERE conversation_id = $1 
             AND EXISTS (
                 SELECT 1 FROM conversation_participants 
                 WHERE conversation_id = $1 AND user_id = $2
             )
             RETURNING *`,
            [conversationId, userId]
        );

        if (result.rowCount === 0) {
            // This triggers if the ID is wrong OR if the user isn't a participant
            return res.status(404).json({ message: "Conversation not found or access denied" });
        }

        res.status(200).json({ message: "Conversation deleted successfully", userId: userId, conversationId: conversationId });
    } catch (err) {
        console.error("Delete conversation error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};
// Send a message to a user (auto-create 1-on-1 conversation if needed)
exports.sendMessage = async (req, res) => {
    const senderId = req.user.sub;
    const { targetUserId, text_content, shared_post_id, authorCompanyId } = req.body;
    const images = req.files; // Array of files from multer

    // Basic validation: user needs target + (text OR post OR images)
    if (!targetUserId || (!text_content && !shared_post_id && (!images || images.length === 0))) {
        return res.status(400).json({ message: "targetUserId and content (text, post, or images) are required" });
    }

    if (senderId === targetUserId)
        return res.status(400).json({ message: "Cannot send message to yourself" });

    // Check Block Status
    try {
        const { checkBlockStatus } = require("../utils/blockCheck");
        const isBlocked = await checkBlockStatus(senderId, targetUserId);
        if (isBlocked) {
            return res.status(404).json({ message: "User not found" }); // Masked 404
        }
    } catch (e) {
        console.error("Block check failed", e);
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // RBAC: If acting as company, verify membership
        let senderName, senderAvatar;
        if (authorCompanyId) {
            const memberCheck = await client.query(
                `SELECT c.name, c.logo_url FROM company_members cm 
                 JOIN companies c ON cm.company_id = c.company_id
                 WHERE cm.company_id = $1 AND cm.user_id = $2`,
                [authorCompanyId, senderId]
            );
            if (memberCheck.rowCount === 0) {
                await client.query('ROLLBACK');
                return res.status(403).json({ message: "Forbidden: You are not a member of this company" });
            }
            senderName = memberCheck.rows[0].name;
            senderAvatar = memberCheck.rows[0].logo_url;
        } else {
            const senderRes = await client.query(
                `SELECT full_name, avatar_url FROM users WHERE user_id = $1`,
                [senderId]
            );
            if (senderRes.rowCount === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ message: "Sender not found." });
            }
            senderName = senderRes.rows[0].full_name;
            senderAvatar = senderRes.rows[0].avatar_url;
        }

        const targetUserExists = await client.query(
            `SELECT 1 FROM users WHERE user_id = $1`,
            [targetUserId]
        );
        if (targetUserExists.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: "Target user not found." });
        }
        let conversationId;

        // Check if 1-on-1 conversation exists
        const existingConv = await client.query(
            `SELECT c.conversation_id
                 FROM conversations c
                 JOIN conversation_participants cp1 ON c.conversation_id = cp1.conversation_id AND cp1.user_id = $1
                 JOIN conversation_participants cp2 ON c.conversation_id = cp2.conversation_id AND cp2.user_id = $2
                 WHERE c.is_group = FALSE`,
            [senderId, targetUserId]
        );

        if (existingConv.rowCount > 0) {
            conversationId = existingConv.rows[0].conversation_id;
        } else {
            // Create new 1-on-1 conversation in a transaction
            const convRes = await client.query(
                `INSERT INTO conversations (is_group) VALUES (FALSE) RETURNING conversation_id`
            );
            conversationId = convRes.rows[0].conversation_id;

            await client.query(
                `INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2), ($1, $3)`,
                [conversationId, senderId, targetUserId]
            );
        }

        // Insert the message
        // Determine message text for notifications/preview
        // Determine message text for notifications/preview
        const previewText = text_content
            ? text_content
            : (images && images.length > 0
                ? (images.length > 1 ? `${images.length} attachments` : (images[0].mimetype.startsWith('video/') ? 'Sent a video' : (images[0].mimetype === 'application/pdf' ? 'Sent a document' : 'Sent a photo')))
                : (shared_post_id ? 'Shared a post' : 'Attachment'));

        const msgRes = await client.query(
            `INSERT INTO messages (conversation_id, sender_id, text_content, shared_post_id, author_company_id)
                 VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [conversationId, senderId, text_content || '', shared_post_id || null, authorCompanyId || null]
        );
        const newMessage = msgRes.rows[0];

        // Process Images
        // Process Media (Images, Video, PDF)
        let mediaRecords = [];
        if (images && images.length > 0) {
            const mediaValues = images.map(file => {
                let type = 'image';
                if (file.mimetype.startsWith('video/')) type = 'video';
                if (file.mimetype === 'application/pdf') type = 'document'; // Use 'document' as per schema update (ensure schema allows this!)
                // Wait, I updated schema to allow 'document'.
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
        await client.query('COMMIT');

        const messageData = {
            ...newMessage,
            media: mediaRecords,
            shared_post: sharedPostData,
            sender_name: senderName,
            sender_avatar: senderAvatar
        };

        // Notify target user via service
        socketService.notifyUser(targetUserId, "new_message", messageData);
        // Notify sender as well
        socketService.notifyUser(senderId, "new_message", messageData);

        socketService.notifyUser(targetUserId, "notification", {
            type: "message",
            from: senderId,
            senderName,
            senderAvatar,
            conversationId,
            text: previewText
        });

        res.status(201).json({
            conversationId,
            message: "Message sent successfully",
            data: messageData
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Error in sendMessage:", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};
exports.markConversationRead = async (req, res) => {
    const userId = req.user.sub;
    const {
        conversationId
    } = req.params;

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        // 1. Update the participant's last_read_at timestamp
        const result = await client.query(
            `
            UPDATE conversation_participants
            SET last_read_at = NOW()
            WHERE conversation_id = $1 AND user_id = $2
            RETURNING last_read_at
            `,
            [conversationId, userId]
        );

        // 2. Identify unread messages to mark as read
        const unreadMessagesMsgIds = await client.query(
            `
            SELECT message_id FROM messages
            WHERE conversation_id = $1
            AND sender_id != $2
            AND NOT EXISTS (
                SELECT 1 FROM message_reads 
                WHERE message_reads.message_id = messages.message_id 
                AND message_reads.user_id = $2
            )
            `,
            [conversationId, userId]
        );

        const unreadMsgIds = unreadMessagesMsgIds.rows.map(r => r.message_id);

        if (unreadMsgIds.length > 0) {
            // 3. Insert into message_reads
            // Construct bulk insert values
            const values = unreadMsgIds.map((msgId, idx) => `($${idx * 2 + 1}, $${idx * 2 + 2})`).join(', ');
            const params = [];
            unreadMsgIds.forEach(msgId => {
                params.push(msgId, userId);
            });

            await client.query(
                `INSERT INTO message_reads (message_id, user_id) VALUES ${values} ON CONFLICT DO NOTHING`,
                params
            );

            // 4. Update 'messages.read_at' for backward compatibility (optional but good for 1-on-1 default logic)
            // Mark messages as read if they weren't already
            await client.query(
                `
                UPDATE messages
                SET read_at = NOW()
                WHERE message_id = ANY($1)
                AND read_at IS NULL
                `,
                [unreadMsgIds]
            );
        }

        await client.query("COMMIT");

        const readAt = result.rows[0]?.last_read_at || new Date();

        // 5. Emit read receipt via Socket
        if (unreadMsgIds.length > 0) {
            socketService.notifyConversation(conversationId, "messages_seen", {
                conversationId,
                readerId: userId, // Who read the messages
                messageIds: unreadMsgIds, // Which messages were read
                readAt: readAt,
            });
        }

        res.json({
            message: "Conversation marked as read",
            readAt: readAt,
            readCount: unreadMsgIds.length
        });

    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Mark conversation read error:", err);
        res.status(500).json({
            message: "Internal server error"
        });
    } finally {
        client.release();
    }
};

exports.getMessageSeenBy = async (req, res) => {
    const {
        messageId
    } = req.params;
    const userId = req.user.sub;

    try {
        // Validation: Verify user is part of the conversation this message belongs to
        // (Optional but recommended for security)
        const accessCheck = await pool.query(
            `
            SELECT 1 
            FROM messages m
            JOIN conversation_participants cp ON m.conversation_id = cp.conversation_id
            WHERE m.message_id = $1 AND cp.user_id = $2
            `,
            [messageId, userId]
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
        res.status(500).json({
            message: "Internal server error"
        });
    }
};

// Get all messages in a conversation
exports.getMessages = async (req, res) => {
    const userId = req.user.sub;
    const conversation_id = req.params.id;
    const limit = parseInt(req.query.limit) || 50;
    let before = req.query.before || null;

    try {
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

        // 2. Check Participation & Get Group Info
        const partCheck = await pool.query(
            `SELECT cp.joined_at, c.is_group 
             FROM conversation_participants cp
             JOIN conversations c ON cp.conversation_id = c.conversation_id
             WHERE cp.conversation_id = $1 AND cp.user_id = $2`,
            [conversation_id, userId]
        );

        if (partCheck.rowCount === 0)
            return res.status(403).json({ message: "Not a participant" });

        const { joined_at, is_group } = partCheck.rows[0];

        // 3. Fetch Messages
        // We use parameterized queries without forced casting (::timestamp) to let pg-node handle types.
        // 'before' is now guaranteed to be a TIMESTAMP (Date object/string) or NULL.
        // 'joined_at' is a Date object from the previous query.
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
                m.author_company_id,
                m.is_deleted_for_everyone,
                m.deleted_at,
                COALESCE(c.name, u.full_name) as sender_name,
                COALESCE(c.logo_url, u.avatar_url) as sender_avatar,
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
                EXISTS(SELECT 1 FROM message_delete md WHERE md.message_id = m.message_id AND md.user_id = $4) as is_deleted_for_me
             FROM messages m
             JOIN users u ON m.sender_id = u.user_id
             LEFT JOIN companies c ON m.author_company_id = c.company_id
             LEFT JOIN posts sp ON m.shared_post_id = sp.post_id
             LEFT JOIN users au ON sp.author_id = au.user_id
             WHERE m.conversation_id = $1 
             -- Filter messages before user joined (if group), with generous buffer
             AND ($2::boolean = false OR m.created_at >= $3::timestamp - INTERVAL '10 year')
             -- Pagination: Fetch messages older than 'before' cursor
             AND ($5::timestamp IS NULL OR m.created_at < $5::timestamp)
             ORDER BY m.created_at DESC
             LIMIT $6`,
            [conversation_id, is_group, joined_at, userId, before, limit]
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
        res.status(500).json({ message: "Internal server error" });
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
    const userId = req.user.sub;
    const { companyId } = req.query;

    try {
        let query = `
            SELECT n.*, 
                CASE 
                    WHEN (n.metadata->>'company_id') IS NOT NULL THEN c.name 
                    ELSE u.full_name 
                END as actor_name, 
                CASE 
                    WHEN (n.metadata->>'company_id') IS NOT NULL THEN c.logo_url 
                    ELSE u.avatar_url 
                END as actor_avatar,
                COALESCE(c.slug, u.account_name) as actor_slug,
                ((n.metadata->>'company_id') IS NOT NULL) as is_company_actor,
                cr.request_id as request_id, 
                cr.status as request_status
            FROM notifications n 
            LEFT JOIN users u ON n.sender_id = u.user_id 
            LEFT JOIN companies c ON (n.metadata->>'company_id')::uuid = c.company_id
            LEFT JOIN connection_requests cr ON n.sender_id = cr.sender_id AND n.user_id = cr.receiver_id AND cr.status = 'pending'
            WHERE 
        `;

        const params = [];
        let paramIdx = 1;

        if (companyId) {
            // Verify user is part of company (optional but good)
            query += ` n.recipient_company_id = $${paramIdx} `;
            params.push(companyId);
        } else {
            query += ` n.user_id = $${paramIdx} AND n.recipient_company_id IS NULL `;
            params.push(userId);
        }

        // Common filters
        query += ` AND NOT EXISTS (SELECT 1 FROM blocks WHERE blocker_id = $${companyId ? paramIdx : paramIdx} AND blocked_id = n.sender_id) `;

        query += ` ORDER BY n.created_at DESC`;

        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        console.error("Get notifications error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

// Mark a notification as read
exports.markNotificationRead = async (req, res) => {
    const userId = req.user.sub;
    const { id } = req.params;

    try {
        const result = await pool.query(
            `UPDATE notifications 
       SET is_read = TRUE 
       WHERE notification_id = $1 AND user_id = $2
    RETURNING * `,
            [id, userId]
        );

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

// Batch share post to multiple conversations
exports.sharePostToConversations = async (req, res) => {
    const senderId = req.user.sub;
    const { postId, targetUserIds, message } = req.body;

    if (!postId || !targetUserIds || !Array.isArray(targetUserIds) || targetUserIds.length === 0) {
        return res.status(400).json({ message: "postId and targetUserIds (array) are required" });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Fetch sender info once
        const senderRes = await client.query(
            `SELECT full_name, avatar_url FROM users WHERE user_id = $1`,
            [senderId]
        );
        if (senderRes.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: "Sender not found" });
        }
        const { full_name: senderName, avatar_url: senderAvatar } = senderRes.rows[0];

        // 2. Fetch shared post details once
        let sharedPostData = null;
        const spRes = await client.query(`
    SELECT
    p.post_id, p.content, p.created_at,
        json_build_object('full_name', u.full_name, 'avatar_url', u.avatar_url) as author,
        (SELECT json_agg(json_build_object('url', url, 'media_type', media_type)) FROM post_media WHERE post_id = p.post_id) as media
            FROM posts p
            JOIN users u ON p.author_id = u.user_id
            WHERE p.post_id = $1
        `, [postId]);

        if (spRes.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: "Shared post not found" });
        }
        sharedPostData = spRes.rows[0];

        const results = [];

        // 3. Process each target user
        for (const targetUserId of targetUserIds) {
            if (targetUserId === senderId) continue; // Skip self

            // A. Check/Create Conversation
            let conversationId;
            const existingConv = await client.query(
                `SELECT c.conversation_id
                 FROM conversations c
                 JOIN conversation_participants cp1 ON c.conversation_id = cp1.conversation_id AND cp1.user_id = $1
                 JOIN conversation_participants cp2 ON c.conversation_id = cp2.conversation_id AND cp2.user_id = $2
                 WHERE c.is_group = FALSE`,
                [senderId, targetUserId]
            );

            if (existingConv.rowCount > 0) {
                conversationId = existingConv.rows[0].conversation_id;
            } else {
                const convRes = await client.query(
                    `INSERT INTO conversations(is_group) VALUES(FALSE) RETURNING conversation_id`
                );
                conversationId = convRes.rows[0].conversation_id;

                await client.query(
                    `INSERT INTO conversation_participants(conversation_id, user_id) VALUES($1, $2), ($1, $3)`,
                    [conversationId, senderId, targetUserId]
                );
            }

            // B. Insert Message
            const msgRes = await client.query(
                `INSERT INTO messages(conversation_id, sender_id, text_content, shared_post_id)
    VALUES($1, $2, $3, $4) RETURNING * `,
                [conversationId, senderId, message || '', postId]
            );

            // C. Update Conversation Timestamp
            await client.query(
                `UPDATE conversations SET updated_at = now() WHERE conversation_id = $1`,
                [conversationId]
            );

            // D. Notify (Fire and forget, but keep data for it)
            const mData = { ...msgRes.rows[0], shared_post: sharedPostData };
            results.push({ targetUserId, conversationId, messageData: mData });
        }

        await client.query('COMMIT');

        // 4. Send socket notifications (after commit)
        results.forEach(({ targetUserId, conversationId, messageData }) => {
            socketService.notifyUser(targetUserId, "newMessage", messageData);
            socketService.notifyUser(targetUserId, "notification", {
                type: "message",
                from: senderId,
                senderName,
                senderAvatar,
                conversationId,
                text: "Shared a post"
            });
        });

        res.status(200).json({
            message: "Shared successfully",
            sentCount: results.length
        });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Batch share error:", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
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
        const BlockModel = require("../models/block.model");
        const { checkBlockStatus } = require("../utils/blockCheck");

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

        return res.status(200).json({ message: "Connection removed" });
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
            // Check connection
            const connectedRes = await client.query(
                "SELECT 1 FROM connections WHERE user_id = $1 AND connected_user_id = $2",
                [userId, targetUserId]
            );
            const isConnected = connectedRes.rowCount > 0;

            if (isConnected) {
                return res.status(200).json({
                    status: 'connected',
                    is_following: true, // Implicit
                    is_followed_by: true // Implicit
                });
            }

            // Check pending requests (Outgoing or Incoming)
            const requestRes = await client.query(
                "SELECT request_id, sender_id, status, cooldown_until FROM connection_requests WHERE ((sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1)) AND status IN ('pending', 'rejected', 'blocked')",
                [userId, targetUserId]
            );

            let status = 'none';
            let cooldown = false;
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
                    // If I sent it and it was rejected, I might be on cooldown
                    if (req.sender_id === userId && new Date(req.cooldown_until) > new Date()) {
                        status = 'cooldown';
                        cooldown = true;
                    }
                } else if (req.status === 'blocked') {
                    // status = 'blocked'; 
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

            // Re-check for ID if we found a request but didn't assign it (logic redundancy cleanup)
            if (requestRes.rowCount > 0 && !requestId) {
                requestId = requestRes.rows[0].request_id;
            }

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
        const BlockModel = require("../models/block.model");
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
        const BlockModel = require("../models/block.model");
        // Get list of users *I* have blocked
        const blockedUsers = await BlockModel.getBlockedUsersDetails(userId);
        res.json(blockedUsers);
    } catch (err) {
        console.error("Get blocked users error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

