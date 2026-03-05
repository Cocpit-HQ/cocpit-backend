/**
 * Universal Share Controller
 *
 * POST /api/share              — Universal share endpoint
 * GET  /api/entity/preview/:entityType/:entityId — Preview metadata API
 */

const { shareEntity } = require("./share.service");
const { resolveEntity, resolveBatch } = require("./entityResolver");

/**
 * POST /api/share
 *
 * Body: {
 *   entityType:      "post" | "profile" | "company" | "job" | "event"
 *   entityId:        string
 *   shareMethod:     "message" | "notification" | "copy_link"
 *   targetId?:       string   (required for message / notification)
 *   targetType?:     "user" | "company"  (default: "user")
 *   message?:        string
 *   senderCompanyId?: string
 * }
 */
exports.share = async (req, res) => {
    const senderId = req.user.sub || req.user.user_id;
    const { entityType, entityId, shareMethod, targetId, targetType, message, senderCompanyId } = req.body;

    // Validation
    if (!entityType || !entityId || !shareMethod) {
        return res.status(400).json({ message: "entityType, entityId, and shareMethod are required" });
    }

    if (["message", "notification"].includes(shareMethod) && !targetId) {
        return res.status(400).json({ message: "targetId is required for message and notification share methods" });
    }

    if (shareMethod === "message" && senderId === targetId && !senderCompanyId) {
        return res.status(400).json({ message: "Cannot share with yourself" });
    }

    try {
        const result = await shareEntity(senderId, {
            entityType,
            entityId,
            shareMethod,
            targetId,
            targetType: targetType || "user",
            message,
            senderCompanyId,
        });

        res.status(200).json(result);
    } catch (err) {
        if (err.status) {
            return res.status(err.status).json({ message: err.message });
        }
        console.error("[ShareController] Share error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

/**
 * GET /api/entity/preview/:entityType/:entityId
 *
 * Returns lightweight preview metadata.
 * Flow: Redis cache check → DB query if miss → cache result → return
 *
 * Response: { entityType, entityId, title, subtitle, image, url }
 */
exports.getPreview = async (req, res) => {
    const { entityType, entityId } = req.params;

    if (!entityType || !entityId) {
        return res.status(400).json({ message: "entityType and entityId are required" });
    }

    const validTypes = ["post", "profile", "company", "job", "event"];
    if (!validTypes.includes(entityType)) {
        return res.status(400).json({ message: `Invalid entityType. Supported: ${validTypes.join(", ")}` });
    }

    try {
        const preview = await resolveEntity(entityType, entityId);

        if (!preview) {
            return res.status(404).json({ message: `${entityType} not found` });
        }

        res.status(200).json(preview);
    } catch (err) {
        console.error("[ShareController] Preview error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

/**
 * POST /api/entity/preview/batch
 *
 * Body: [ { type: "post", id: "..." }, { type: "profile", id: "..." } ]
 * Returns multiple preview metadata objects.
 */
exports.batchGetPreview = async (req, res) => {
    const entities = req.body;

    if (!Array.isArray(entities)) {
        return res.status(400).json({ message: "Body must be an array of {type, id} objects" });
    }

    try {
        const previews = await resolveBatch(entities);
        res.status(200).json(previews);
    } catch (err) {
        console.error("[ShareController] Batch preview error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

/**
 * Share a profile inside a DM conversation (NO notification created)
 * POST /api/messages/share-profile
 * Body: { conversation_id, profile_id, profile_type, authorOrgId? }
 *
 * Moved here from message.controller.js to consolidate share logic.
 */
exports.shareProfileInDM = async (req, res) => {
    const pool = require("../../core/db/pool");
    const socketService = require("../../core/infrastructure/socket.service");

    const userId = req.user.sub || req.user.user_id;
    const { conversation_id, profile_id, profile_type, authorOrgId } = req.body;

    if (!conversation_id || !profile_id || !profile_type) {
        return res.status(400).json({ message: "conversation_id, profile_id, and profile_type are required" });
    }

    if (!['user', 'company'].includes(profile_type)) {
        return res.status(400).json({ message: "profile_type must be 'user' or 'company'" });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Validate sender belongs to the conversation
        const participantCheck = await client.query(
            `SELECT 1 FROM conversation_participants cp
             WHERE cp.conversation_id = $1 AND cp.left_at IS NULL
             AND (
               cp.user_id = $2
               OR cp.org_id IN (SELECT org_id FROM organization_members WHERE user_id = $2 AND status = 'ACTIVE')
             )`,
            [conversation_id, userId]
        );

        if (participantCheck.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(403).json({ message: "You are not a participant of this conversation" });
        }

        // 2. Validate company authorization if acting as company
        if (authorOrgId) {
            const memberCheck = await client.query(
                `SELECT 1 FROM organization_members WHERE org_id = $1 AND user_id = $2 AND status = 'ACTIVE'`,
                [authorOrgId, userId]
            );
            if (memberCheck.rowCount === 0) {
                await client.query('ROLLBACK');
                return res.status(403).json({ message: "Not authorized to act as this organization" });
            }
        }

        // 3. Validate profile exists
        let sharedProfileData = null;
        if (profile_type === 'user') {
            const upRes = await client.query(
                `SELECT user_id, full_name AS name, avatar_url AS avatar, headline, location, account_name AS username
                 FROM users WHERE user_id = $1`,
                [profile_id]
            );
            if (upRes.rowCount === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ message: "User profile not found" });
            }
            sharedProfileData = upRes.rows[0];
        } else {
            const cpRes = await client.query(
                `SELECT org_id, name, logo_url AS avatar, industry AS headline, slug, industry
                 FROM organizations WHERE org_id = $1 AND is_deleted = FALSE`,
                [profile_id]
            );
            if (cpRes.rowCount === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ message: "Organization profile not found" });
            }
            sharedProfileData = cpRes.rows[0];
        }

        // 4. Check block status (only for DM conversations, not group)
        const convCheck = await client.query(
            `SELECT is_group FROM conversations WHERE conversation_id = $1`,
            [conversation_id]
        );
        if (convCheck.rowCount > 0 && !convCheck.rows[0].is_group) {
            const BlockModel = require("../../models/block.model");
            const otherParticipant = await client.query(
                `SELECT user_id FROM conversation_participants
                 WHERE conversation_id = $1 AND user_id != $2 AND left_at IS NULL LIMIT 1`,
                [conversation_id, userId]
            );
            if (otherParticipant.rowCount > 0) {
                const otherUserId = otherParticipant.rows[0].user_id;
                const isBlocked = await BlockModel.isBlocked(userId, otherUserId);
                const isBlockedByOther = await BlockModel.isBlocked(otherUserId, userId);
                if (isBlocked || isBlockedByOther) {
                    await client.query('ROLLBACK');
                    return res.status(403).json({ message: "Cannot send message to blocked user" });
                }
            }
        }

        // 5. Fetch sender info
        let senderName, senderAvatar;
        if (authorOrgId) {
            const companyRes = await client.query(
                `SELECT name, logo_url FROM organizations WHERE org_id = $1`,
                [authorOrgId]
            );
            senderName = companyRes.rows[0]?.name || 'Organization';
            senderAvatar = companyRes.rows[0]?.logo_url || null;
        } else {
            const userRes = await client.query(
                `SELECT full_name, avatar_url FROM users WHERE user_id = $1`,
                [userId]
            );
            senderName = userRes.rows[0]?.full_name || 'Someone';
            senderAvatar = userRes.rows[0]?.avatar_url || null;
        }

        // 6. Insert message (NO notification)
        const entityType = profile_type === 'company' ? 'company' : 'profile';
        const msgRes = await client.query(
            `INSERT INTO messages(
                conversation_id, sender_id, text_content,
                message_type, shared_profile_id, shared_profile_type,
                entity_type, entity_id,
                author_org_id
            )
            VALUES($1, $2, $3, 'profile_share', $4, $5, $6, $7, $8)
            RETURNING *`,
            [
                conversation_id,
                userId,
                '', // No text content for profile shares
                profile_id,
                profile_type,
                entityType,
                profile_id,
                authorOrgId || null
            ]
        );

        const insertedMessage = msgRes.rows[0];

        // 7. Update conversation timestamps
        const previewText = profile_type === 'user'
            ? `Shared a profile: ${sharedProfileData.name}`
            : `Shared an organization: ${sharedProfileData.name}`;

        await client.query(
            `UPDATE conversations SET last_message = $1, last_message_at = NOW(), updated_at = NOW()
             WHERE conversation_id = $2`,
            [previewText, conversation_id]
        );

        await client.query('COMMIT');

        // 8. Emit socket event (new_message) — NO notification
        const socketPayload = {
            ...insertedMessage,
            sender_name: senderName,
            sender_avatar: senderAvatar,
            shared_profile: sharedProfileData,
            shared_profile_id: profile_id,
            shared_profile_type: profile_type,
        };

        socketService.notifyConversation(conversation_id, "new_message", socketPayload);

        // Also emit conversation-updated for sidebar refresh
        socketService.notifyConversation(conversation_id, "conversation-updated", {
            conversationId: conversation_id,
            lastMessage: previewText,
            updatedAt: new Date().toISOString()
        });

        res.status(200).json({
            message: "Profile shared in conversation",
            data: socketPayload
        });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Share profile in DM error:", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

/**
 * Share a profile via notification + DM message
 * POST /api/profile/share
 * Body: { profileId, profileType, receiverId, receiverType, message, senderOrgId? }
 *
 * Moved from social.controller.js to consolidate share logic.
 */
exports.shareProfile = async (req, res) => {
    const pool = require("../../core/db/pool");
    const socketService = require("../../core/infrastructure/socket.service");
    const senderId = req.user.sub || req.user.user_id;
    const { profileId, profileType, receiverId, receiverType, message, senderOrgId } = req.body;

    if (!profileId || !profileType || !receiverId || !receiverType) {
        return res.status(400).json({ message: "profileId, profileType, receiverId, and receiverType are required" });
    }

    if (senderId === receiverId && receiverType === 'user' && !senderOrgId) {
        return res.status(400).json({ message: "Cannot share profile with yourself" });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 0. Verify company membership if acting as company
        if (senderOrgId) {
            const memberCheck = await client.query(
                `SELECT 1 FROM organization_members WHERE org_id = $1 AND user_id = $2 AND status = 'ACTIVE'`,
                [senderOrgId, senderId]
            );
            if (memberCheck.rowCount === 0) {
                await client.query('ROLLBACK');
                return res.status(403).json({ message: "Not authorized to act as this organization" });
            }
        }

        // 1. Fetch sender identity (company or user)
        let senderName, senderAvatar;
        if (senderOrgId) {
            const companyRes = await client.query(
                `SELECT name, logo_url, slug FROM organizations WHERE org_id = $1 AND is_deleted = FALSE`,
                [senderOrgId]
            );
            if (companyRes.rowCount === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ message: "Sender organization not found" });
            }
            senderName = companyRes.rows[0].name;
            senderAvatar = companyRes.rows[0].logo_url;
        } else {
            const userRes = await client.query(
                `SELECT full_name, avatar_url FROM users WHERE user_id = $1`,
                [senderId]
            );
            senderName = userRes.rows[0]?.full_name || 'Someone';
            senderAvatar = userRes.rows[0]?.avatar_url || null;
        }

        // 2. Fetch shared profile info for preview data
        let sharedProfileData = null;
        if (profileType === 'user') {
            const upRes = await client.query(
                `SELECT full_name as name, avatar_url as avatar, headline, account_name FROM users WHERE user_id = $1`,
                [profileId]
            );
            sharedProfileData = upRes.rows[0];
        } else {
            const cpRes = await client.query(
                `SELECT name, logo_url as avatar, slogan as headline, slug FROM organizations WHERE org_id = $1`,
                [profileId]
            );
            sharedProfileData = cpRes.rows[0];
        }

        if (!sharedProfileData) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: "Shared profile not found" });
        }

        // 3. Conversation Lookup/Creation Logic
        let conversationId;

        if (senderOrgId && receiverType === 'company') {
            // Company-to-Company conversation
            const existingConv = await client.query(
                `SELECT c.conversation_id
                 FROM conversations c
                 JOIN conversation_participants cp1 ON c.conversation_id = cp1.conversation_id AND cp1.org_id = $1
                 JOIN conversation_participants cp2 ON c.conversation_id = cp2.conversation_id AND cp2.org_id = $2
                 WHERE c.is_group = FALSE`,
                [senderOrgId, receiverId]
            );

            if (existingConv.rowCount > 0) {
                conversationId = existingConv.rows[0].conversation_id;
            } else {
                const convRes = await client.query(
                    `INSERT INTO conversations(is_group) VALUES(FALSE) RETURNING conversation_id`
                );
                conversationId = convRes.rows[0].conversation_id;

                await client.query(
                    `INSERT INTO conversation_participants(conversation_id, org_id) VALUES($1, $2)`,
                    [conversationId, senderOrgId]
                );
                await client.query(
                    `INSERT INTO conversation_participants(conversation_id, org_id) VALUES($1, $2)`,
                    [conversationId, receiverId]
                );
            }
        } else if (senderOrgId && receiverType === 'user') {
            // Company-to-User conversation
            const existingConv = await client.query(
                `SELECT c.conversation_id
                 FROM conversations c
                 JOIN conversation_participants cp1 ON c.conversation_id = cp1.conversation_id AND cp1.org_id = $1
                 JOIN conversation_participants cp2 ON c.conversation_id = cp2.conversation_id AND cp2.user_id = $2
                 WHERE c.is_group = FALSE`,
                [senderOrgId, receiverId]
            );

            if (existingConv.rowCount > 0) {
                conversationId = existingConv.rows[0].conversation_id;
            } else {
                const convRes = await client.query(
                    `INSERT INTO conversations(is_group) VALUES(FALSE) RETURNING conversation_id`
                );
                conversationId = convRes.rows[0].conversation_id;

                await client.query(
                    `INSERT INTO conversation_participants(conversation_id, org_id) VALUES($1, $2)`,
                    [conversationId, senderOrgId]
                );
                await client.query(
                    `INSERT INTO conversation_participants(conversation_id, user_id) VALUES($1, $2)`,
                    [conversationId, receiverId]
                );
            }
        } else if (!senderOrgId && receiverType === 'company') {
            // User-to-Company conversation
            const existingConv = await client.query(
                `SELECT c.conversation_id
                 FROM conversations c
                 JOIN conversation_participants cp1 ON c.conversation_id = cp1.conversation_id AND cp1.user_id = $1
                 JOIN conversation_participants cp2 ON c.conversation_id = cp2.conversation_id AND cp2.org_id = $2
                 WHERE c.is_group = FALSE`,
                [senderId, receiverId]
            );

            if (existingConv.rowCount > 0) {
                conversationId = existingConv.rows[0].conversation_id;
            } else {
                const convRes = await client.query(
                    `INSERT INTO conversations(is_group) VALUES(FALSE) RETURNING conversation_id`
                );
                conversationId = convRes.rows[0].conversation_id;

                await client.query(
                    `INSERT INTO conversation_participants(conversation_id, user_id) VALUES($1, $2)`,
                    [conversationId, senderId]
                );
                await client.query(
                    `INSERT INTO conversation_participants(conversation_id, org_id) VALUES($1, $2)`,
                    [conversationId, receiverId]
                );
            }
        } else {
            // User-to-User conversation
            const existingConv = await client.query(
                `SELECT c.conversation_id
                 FROM conversations c
                 JOIN conversation_participants cp1 ON c.conversation_id = cp1.conversation_id AND cp1.user_id = $1
                 JOIN conversation_participants cp2 ON c.conversation_id = cp2.conversation_id AND cp2.user_id = $2
                 WHERE c.is_group = FALSE`,
                [senderId, receiverId]
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
                    [conversationId, senderId, receiverId]
                );
            }
        }

        // 4. Insert Message
        const msgRes = await client.query(
            `INSERT INTO messages(
                conversation_id, sender_id, text_content, 
                message_type, shared_profile_id, shared_profile_type,
                sender_type
            )
            VALUES($1, $2, $3, 'profile_share', $4, $5, $6)
            RETURNING *`,
            [conversationId, senderId, message || '', profileId, profileType, senderOrgId ? 'COMPANY' : 'USER']
        );

        // 5. Update Conversation Timestamp
        await client.query(
            `UPDATE conversations SET updated_at = NOW() WHERE conversation_id = $1`,
            [conversationId]
        );

        // 6. Build notification metadata
        const notifMeta = {
            profileType,
            ...(senderOrgId ? { org_id: senderOrgId } : {}),
            ...(receiverType === 'company' ? { receiverType, receiverId } : {}),
            ...(profileType === 'company' && sharedProfileData?.slug ? { slug: sharedProfileData.slug } : {}),
            ...(profileType === 'user' && sharedProfileData?.account_name ? { account_name: sharedProfileData.account_name } : {})
        };

        // 7. Create Persistent Notification
        if (receiverType === 'company') {
            const adminsRes = await client.query(
                `SELECT user_id FROM organization_members WHERE org_id = $1 AND status = 'ACTIVE' LIMIT 1`,
                [receiverId]
            );
            const firstMemberId = adminsRes.rows[0]?.user_id || senderId;
            await client.query(
                `INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata, recipient_org_id)
                 VALUES ($1, $2, 'profile_share', $3, $4, $5, $6)`,
                [firstMemberId, senderId, `${senderName} shared a ${profileType} profile with your organization`, profileId, JSON.stringify(notifMeta), receiverId]
            );
        } else {
            await client.query(
                `INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata)
                 VALUES ($1, $2, 'profile_share', $3, $4, $5)`,
                [receiverId, senderId, `${senderName} shared a ${profileType} profile with you`, profileId, JSON.stringify(notifMeta)]
            );
        }

        await client.query('COMMIT');

        // 8. Notify via Socket
        const socketData = {
            ...msgRes.rows[0],
            sender_name: senderName,
            sender_avatar: senderAvatar,
            shared_profile: sharedProfileData,
            is_organization_actor: !!senderOrgId,
            sender_org_id: senderOrgId || null
        };

        if (receiverType === 'company') {
            const membersRes = await client.query(
                `SELECT user_id FROM organization_members WHERE org_id = $1 AND status = 'ACTIVE'`,
                [receiverId]
            );
            for (const member of membersRes.rows) {
                socketService.notifyUser(member.user_id, "newMessage", socketData);
                socketService.notifyUser(member.user_id, "notification", {
                    type: "message",
                    from: senderOrgId || senderId,
                    senderName,
                    senderAvatar,
                    conversationId,
                    text: `Shared a ${profileType} profile`,
                    recipient_org_id: receiverId,
                    isOrganizationNotification: true,
                    is_organization_actor: !!senderOrgId,
                    metadata: notifMeta
                });
            }
        } else {
            socketService.notifyUser(receiverId, "newMessage", socketData);
            socketService.notifyUser(receiverId, "notification", {
                type: "message",
                from: senderOrgId || senderId,
                senderName,
                senderAvatar,
                conversationId,
                text: `Shared a ${profileType} profile`,
                is_organization_actor: !!senderOrgId,
                metadata: notifMeta
            });
        }

        res.status(200).json({
            message: "Profile shared successfully",
            conversationId,
            messageData: socketData
        });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Share profile error:", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

/**
 * Batch share post to multiple conversations
 * POST /api/social/share
 * Body: { postId, targetUserIds, message }
 */
exports.sharePostToConversations = async (req, res) => {
    const pool = require("../../core/db/pool");
    const socketService = require("../../core/infrastructure/socket.service");

    const senderId = req.user.sub || req.user.user_id;
    const { postId, targetUserIds, message } = req.body;

    if (!postId || !targetUserIds || !Array.isArray(targetUserIds) || targetUserIds.length === 0) {
        return res.status(400).json({ message: "postId and targetUserIds (array) are required" });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const senderRes = await client.query(
            `SELECT full_name, avatar_url FROM users WHERE user_id = $1`,
            [senderId]
        );
        if (senderRes.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: "Sender not found" });
        }
        const { full_name: senderName, avatar_url: senderAvatar } = senderRes.rows[0];

        const spRes = await client.query(`
            SELECT p.post_id, p.content, p.created_at,
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
        const sharedPostData = spRes.rows[0];
        const results = [];

        for (const targetUserId of targetUserIds) {
            if (targetUserId === senderId) continue;

            let conversationId;
            const existingConv = await client.query(
                `SELECT c.conversation_id FROM conversations c
                 JOIN conversation_participants cp1 ON c.conversation_id = cp1.conversation_id AND cp1.user_id = $1
                 JOIN conversation_participants cp2 ON c.conversation_id = cp2.conversation_id AND cp2.user_id = $2
                 WHERE c.is_group = FALSE`,
                [senderId, targetUserId]
            );

            if (existingConv.rowCount > 0) {
                conversationId = existingConv.rows[0].conversation_id;
            } else {
                const convRes = await client.query(`INSERT INTO conversations(is_group) VALUES(FALSE) RETURNING conversation_id`);
                conversationId = convRes.rows[0].conversation_id;
                await client.query(`INSERT INTO conversation_participants(conversation_id, user_id) VALUES($1, $2), ($1, $3)`, [conversationId, senderId, targetUserId]);
            }

            const msgRes = await client.query(
                `INSERT INTO messages(conversation_id, sender_id, text_content, shared_post_id, entity_type, entity_id)
                 VALUES($1, $2, $3, $4, 'post', $5) RETURNING *`,
                [conversationId, senderId, message || '', postId, postId]
            );

            await client.query(`UPDATE conversations SET updated_at = now() WHERE conversation_id = $1`, [conversationId]);
            results.push({ targetUserId, conversationId, messageData: { ...msgRes.rows[0], shared_post: sharedPostData } });
        }

        await client.query('COMMIT');

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

        res.status(200).json({ message: "Shared successfully", sentCount: results.length });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Batch share error:", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

/**
 * Share to Feed (Repost)
 * POST /api/share/feed
 */
exports.shareToFeed = async (req, res) => {
    const contentController = require("../content/content.controller");
    const { postId, content, category, visibility, orgId } = req.body;

    if (!postId) return res.status(400).json({ message: "postId is required" });

    req.body = {
        ...req.body,
        shared_post_id: postId,
        content: content || '',
        category: category || 'Professional',
        visibility: visibility || 'public',
        orgId: orgId || undefined,
    };

    return contentController.createPost(req, res);
};

/**
 * Share to Story
 * POST /api/share/story
 */
exports.shareToStory = async (req, res) => {
    const contentController = require("../content/content.controller");
    const { postId } = req.body;

    if (!postId) return res.status(400).json({ message: "postId is required" });

    req.body = { ...req.body, shared_post_id: postId };
    return contentController.createStory(req, res);
};
