/**
 * Universal Share Service
 *
 * Central entry point for all share operations.
 * Routes to: shareViaMessage | shareViaNotification | shareViaCopyLink
 *
 * Flow:
 *   shareEntity(senderId, payload)
 *     → Validate entity exists
 *     → Route to share method
 *     → Return result
 */

const pool = require("../../core/db/pool");
const redisClient = require("../../core/db/redis");
const socketService = require("../../core/infrastructure/socket.service");
const { resolveEntity, generateEntityUrl } = require("./entityResolver");
const { validateShareRules } = require("./shareRules");

// ─── Share Tracking (non-blocking) ──────────────────────────

/**
 * Track a share event in the `shares` table.
 * Non-blocking: errors are logged but never thrown.
 */
async function trackShare(senderId, receiverId, entityType, entityId, shareMethod) {
    try {
        const result = await pool.query(
            `INSERT INTO shares (sender_id, receiver_id, entity_type, entity_id, share_method)
             SELECT $1::TEXT, $2::TEXT, $3::TEXT, $4::TEXT, $5::TEXT
             WHERE NOT EXISTS (
                 SELECT 1 FROM shares 
                 WHERE sender_id = $1 
                   AND receiver_id IS NOT DISTINCT FROM $2
                   AND entity_type = $3 
                   AND entity_id = $4 
                   AND share_method = $5
             )
             RETURNING id`,
            [senderId, receiverId || null, entityType, entityId, shareMethod]
        );
        let tracked = false;
        if (result.rowCount > 0) {
            tracked = true;
            if (entityType === 'post' && redisClient.isOpen) {
                await redisClient.incr(`post:${entityId}:share_count`);
            }
        }
        return tracked;
    } catch (err) {
        console.warn("[ShareTracking] Failed to track share event:", err.message);
        return false;
    }
}

// ─── Share Method Handlers ──────────────────────────────────

/**
 * Share via Message (DM)
 *
 * Flow:
 *   1. Resolve sender identity (user or company)
 *   2. Find or create conversation
 *   3. Insert message with message_type = "share", entity_type, entity_id
 *   4. Update conversation timestamp
 *   5. Emit WebSocket event
 */
async function shareViaMessage(senderId, { entityType, entityId, targetId, targetType, message, senderOrgId }) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // 1. Verify company membership if acting as company
        if (senderOrgId) {
            const memberCheck = await client.query(
                `SELECT 1 FROM organization_members WHERE org_id = $1 AND user_id = $2 AND status = 'ACTIVE'`,
                [senderOrgId, senderId]
            );
            if (memberCheck.rowCount === 0) {
                await client.query("ROLLBACK");
                throw { status: 403, message: "Not authorized to act as this company" };
            }
        }

        // 2. Resolve sender identity
        let senderName, senderAvatar;
        if (senderOrgId) {
            const companyRes = await client.query(
                `SELECT name, logo_url FROM organizations WHERE org_id = $1 AND is_deleted = FALSE`,
                [senderOrgId]
            );
            if (companyRes.rowCount === 0) {
                await client.query("ROLLBACK");
                throw { status: 404, message: "Sender company not found" };
            }
            senderName = companyRes.rows[0].name;
            senderAvatar = companyRes.rows[0].logo_url;
        } else {
            const userRes = await client.query(
                `SELECT full_name, avatar_url FROM users WHERE user_id = $1`,
                [senderId]
            );
            senderName = userRes.rows[0]?.full_name || "Someone";
            senderAvatar = userRes.rows[0]?.avatar_url || null;
        }

        // 3. Find or create conversation
        const conversationId = await findOrCreateConversation(client, senderId, targetId, targetType || "user", senderOrgId);

        // 4. Insert message with universal entity fields
        //    Also set legacy fields for backward compatibility
        const legacyFields = buildLegacyFields(entityType, entityId);

        const msgRes = await client.query(
            `INSERT INTO messages(
                conversation_id, sender_id, text_content,
                message_type, entity_type, entity_id,
                ${legacyFields.columns}
                author_org_id, sender_type
            )
            VALUES($1, $2, $3, 'share', $4, $5,
                ${legacyFields.placeholders}
                $${legacyFields.nextIdx}, $${legacyFields.nextIdx + 1}
            )
            RETURNING *`,
            [
                conversationId, senderId, message || "",
                entityType, entityId,
                ...legacyFields.values,
                senderOrgId || null,
                senderOrgId ? "COMPANY" : "USER",
            ]
        );

        // 5. Update conversation timestamp
        const previewText = `Shared a ${entityType}`;
        await client.query(
            `UPDATE conversations SET updated_at = NOW() WHERE conversation_id = $1`,
            [conversationId]
        );

        await client.query("COMMIT");

        // 6. Resolve entity preview for socket payload
        const entityPreview = await resolveEntity(entityType, entityId);

        // 7. Build socket payload
        const socketPayload = {
            ...msgRes.rows[0],
            sender_name: senderName,
            sender_avatar: senderAvatar,
            entity_type: entityType,
            entity_id: entityId,
            entity_preview: entityPreview,
            // Legacy fields for backward compat
            ...(entityType === "post" && entityPreview ? { shared_post: buildLegacyPostPreview(entityPreview) } : {}),
            ...(["profile", "company"].includes(entityType) && entityPreview ? { shared_profile: buildLegacyProfilePreview(entityPreview) } : {}),
        };

        // 8. Emit WebSocket events
        if (targetType === "company") {
            const membersRes = await pool.query(
                `SELECT user_id FROM organization_members WHERE org_id = $1 AND status = 'ACTIVE'`,
                [targetId]
            );
            for (const member of membersRes.rows) {
                socketService.notifyUser(member.user_id, "newMessage", socketPayload);
                socketService.notifyUser(member.user_id, "notification", {
                    type: "message",
                    from: senderOrgId || senderId,
                    senderName,
                    senderAvatar,
                    conversationId,
                    text: previewText,
                });
            }
        } else {
            socketService.notifyUser(targetId, "newMessage", socketPayload);
            socketService.notifyUser(targetId, "notification", {
                type: "message",
                from: senderOrgId || senderId,
                senderName,
                senderAvatar,
                conversationId,
                text: previewText,
            });
        }

        return {
            success: true,
            message: "Shared successfully",
            conversationId,
            messageData: socketPayload,
        };
    } catch (err) {
        await client.query("ROLLBACK").catch(() => { });
        throw err;
    } finally {
        client.release();

        // Non-blocking: track share event after releasing connection
        trackShare(senderId, targetId, entityType, entityId, "message");
    }
}

/**
 * Share via Notification
 *
 * Flow:
 *   1. Resolve sender identity
 *   2. Insert notification with entity_type + entity_id
 *   3. Emit socket notification event
 */
async function shareViaNotification(senderId, { entityType, entityId, targetId, targetType, message, senderOrgId }) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // 1. Verify company membership if acting as company
        if (senderOrgId) {
            const memberCheck = await client.query(
                `SELECT 1 FROM organization_members WHERE org_id = $1 AND user_id = $2 AND status = 'ACTIVE'`,
                [senderOrgId, senderId]
            );
            if (memberCheck.rowCount === 0) {
                await client.query("ROLLBACK");
                throw { status: 403, message: "Not authorized to act as this company" };
            }
        }

        // 2. Resolve sender identity
        let senderName, senderAvatar;
        if (senderOrgId) {
            const companyRes = await client.query(
                `SELECT name, logo_url FROM organizations WHERE org_id = $1 AND is_deleted = FALSE`,
                [senderOrgId]
            );
            senderName = companyRes.rows[0]?.name || "Company";
            senderAvatar = companyRes.rows[0]?.logo_url || null;
        } else {
            const userRes = await client.query(
                `SELECT full_name, avatar_url FROM users WHERE user_id = $1`,
                [senderId]
            );
            senderName = userRes.rows[0]?.full_name || "Someone";
            senderAvatar = userRes.rows[0]?.avatar_url || null;
        }

        // 3. Resolve entity slug/account_name/name for navigation and notification text
        let entitySlug = null;
        let entityAccountName = null;
        let entityName = null;
        if (entityType === "company") {
            const orgRes = await client.query(
                `SELECT slug, name FROM organizations WHERE org_id = $1`, [entityId]
            );
            entitySlug = orgRes.rows[0]?.slug || null;
            entityName = orgRes.rows[0]?.name || null;
        } else if (entityType === "profile") {
            const profileRes = await client.query(
                `SELECT account_name, full_name FROM users WHERE user_id = $1`, [entityId]
            );
            entityAccountName = profileRes.rows[0]?.account_name || null;
            entityName = profileRes.rows[0]?.full_name || null;
        }

        // 4. Build notification text
        let notifText;
        if (entityName) {
            notifText = `${senderName} shared ${entityName}'s ${entityType} with you`;
        } else {
            notifText = `${senderName} shared a ${entityType} with you`;
        }

        // 4. Build metadata for navigation
        const metadata = {
            entityType,
            entityId,
            ...(senderOrgId ? { org_id: senderOrgId } : {}),
            ...(entitySlug ? { slug: entitySlug } : {}),
            ...(entityAccountName ? { account_name: entityAccountName } : {}),
        };

        // 5. Insert notification
        let notifRes;
        if (targetType === "company") {
            const adminsRes = await client.query(
                `SELECT user_id FROM organization_members WHERE org_id = $1 AND status = 'ACTIVE' LIMIT 1`,
                [targetId]
            );
            const recipientUserId = adminsRes.rows[0]?.user_id || senderId;
            notifRes = await client.query(
                `INSERT INTO notifications (user_id, sender_id, type, text, reference_id, entity_type, entity_id, metadata, recipient_org_id)
                 VALUES ($1, $2, 'share', $3, $4, $5, $6, $7, $8) RETURNING *`,
                [recipientUserId, senderId, notifText, entityId, entityType, entityId, JSON.stringify(metadata), targetId]
            );
        } else {
            notifRes = await client.query(
                `INSERT INTO notifications (user_id, sender_id, type, text, reference_id, entity_type, entity_id, metadata)
                 VALUES ($1, $2, 'share', $3, $4, $5, $6, $7) RETURNING *`,
                [targetId, senderId, notifText, entityId, entityType, entityId, JSON.stringify(metadata)]
            );
        }

        await client.query("COMMIT");

        // 6. Emit socket notification
        const socketNotif = {
            notification_id: notifRes.rows[0].notification_id,
            type: "share",
            text: notifText,
            from: senderOrgId || senderId,
            senderName,
            senderAvatar,
            entity_type: entityType,
            entity_id: entityId,
            referenceId: entityId,
            created_at: notifRes.rows[0].created_at?.toISOString() || new Date().toISOString(),
            time: "Just now",
            metadata,
        };

        if (targetType === "company") {
            const membersRes = await pool.query(
                `SELECT user_id FROM organization_members WHERE org_id = $1 AND status = 'ACTIVE'`,
                [targetId]
            );
            for (const member of membersRes.rows) {
                socketService.notifyUser(member.user_id, "notification", socketNotif);
            }
        } else {
            socketService.notifyUser(targetId, "notification", socketNotif);
        }

        return {
            success: true,
            message: "Notification sent",
        };
    } catch (err) {
        await client.query("ROLLBACK").catch(() => { });
        throw err;
    } finally {
        client.release();

        // Non-blocking: track share event after releasing connection
        trackShare(senderId, targetId, entityType, entityId, "notification");
    }
}

/**
 * Share via Copy Link
 *
 * No DB write. Generate URL and return.
 */
async function shareViaCopyLink(senderId, { entityType, entityId }) {
    const url = generateEntityUrl(entityType, entityId);

    // Non-blocking: track copy_link share event
    trackShare(senderId, null, entityType, entityId, "copy_link");

    return {
        success: true,
        message: "Link generated",
        url,
    };
}

// ─── Main Entry Point ───────────────────────────────────────

const SHARE_METHODS = {
    message: shareViaMessage,
    notification: shareViaNotification,
    copy_link: shareViaCopyLink,
};

/**
 * shareEntity — Universal share entry point
 *
 * @param {string} senderId
 * @param {object} payload  { entityType, entityId, shareMethod, targetId?, targetType?, message?, senderOrgId? }
 * @returns {Promise<object>}
 */
async function shareEntity(senderId, payload) {
    const { entityType, entityId, shareMethod } = payload;

    // Validate entity type
    const validTypes = ["post", "profile", "company", "job", "event"];
    if (!validTypes.includes(entityType)) {
        throw { status: 400, message: `Invalid entityType: ${entityType}. Supported: ${validTypes.join(", ")}` };
    }

    // Validate share method
    const handler = SHARE_METHODS[shareMethod];
    if (!handler) {
        throw { status: 400, message: `Invalid shareMethod: ${shareMethod}. Supported: message, notification, copy_link` };
    }

    // Validate share rules (e.g., user profile → company blocked, users → companies blocked)
    const targetType = payload.targetType || "user";
    if (payload.targetId) {
        await validateShareRules({
            senderId,
            entityType,
            entityId,
            receiverType: targetType,
            senderOrgId: payload.senderOrgId
        });
    }

    // Route to handler
    return handler(senderId, payload);
}

// ─── Helper Functions ───────────────────────────────────────

/**
 * Find or create a 1-on-1 conversation between sender and target.
 * Handles: user↔user, company↔user, company↔company, user↔company
 */
async function findOrCreateConversation(client, senderId, targetId, targetType, senderOrgId) {
    let existingConv;

    if (senderOrgId && targetType === "company") {
        // Company-to-Company
        existingConv = await client.query(
            `SELECT c.conversation_id FROM conversations c
             JOIN conversation_participants cp ON c.conversation_id = cp.conversation_id
             WHERE c.is_group = FALSE AND c.is_active = TRUE
               AND cp.org_id IN ($1, $2)
             GROUP BY c.conversation_id
             HAVING COUNT(*) = 2`,
            [senderOrgId, targetId]
        );
    } else if (senderOrgId && targetType === "user") {
        // Company-to-User
        existingConv = await client.query(
            `SELECT c.conversation_id FROM conversations c
             JOIN conversation_participants cp1 ON c.conversation_id = cp1.conversation_id AND cp1.org_id = $1
             JOIN conversation_participants cp2 ON c.conversation_id = cp2.conversation_id AND cp2.user_id = $2
             WHERE c.is_group = FALSE AND c.is_active = TRUE`,
            [senderOrgId, targetId]
        );
    } else if (!senderOrgId && targetType === "company") {
        // User-to-Company
        existingConv = await client.query(
            `SELECT c.conversation_id FROM conversations c
             JOIN conversation_participants cp1 ON c.conversation_id = cp1.conversation_id AND cp1.user_id = $1
             JOIN conversation_participants cp2 ON c.conversation_id = cp2.conversation_id AND cp2.org_id = $2
             WHERE c.is_group = FALSE AND c.is_active = TRUE`,
            [senderId, targetId]
        );
    } else {
        // User-to-User
        existingConv = await client.query(
            `SELECT c.conversation_id FROM conversations c
             JOIN conversation_participants cp ON c.conversation_id = cp.conversation_id
             WHERE c.is_group = FALSE AND c.is_active = TRUE
               AND cp.user_id IN ($1, $2)
             GROUP BY c.conversation_id
             HAVING COUNT(*) = 2`,
            [senderId, targetId]
        );
    }

    if (existingConv.rowCount > 0) {
        return existingConv.rows[0].conversation_id;
    }

    // Create new conversation
    const convRes = await client.query(
        `INSERT INTO conversations(is_group) VALUES(FALSE) RETURNING conversation_id`
    );
    const conversationId = convRes.rows[0].conversation_id;

    // Add participants
    if (senderOrgId && targetType === "company") {
        await client.query(`INSERT INTO conversation_participants(conversation_id, org_id, last_read_at) VALUES($1, $2, NOW())`, [conversationId, senderOrgId]);
        await client.query(`INSERT INTO conversation_participants(conversation_id, org_id, last_read_at) VALUES($1, $2, NULL)`, [conversationId, targetId]);
    } else if (senderOrgId && targetType === "user") {
        await client.query(`INSERT INTO conversation_participants(conversation_id, org_id, last_read_at) VALUES($1, $2, NOW())`, [conversationId, senderOrgId]);
        await client.query(`INSERT INTO conversation_participants(conversation_id, user_id, last_read_at) VALUES($1, $2, NULL)`, [conversationId, targetId]);
    } else if (!senderOrgId && targetType === "company") {
        await client.query(`INSERT INTO conversation_participants(conversation_id, user_id, last_read_at) VALUES($1, $2, NOW())`, [conversationId, senderId]);
        await client.query(`INSERT INTO conversation_participants(conversation_id, org_id, last_read_at) VALUES($1, $2, NULL)`, [conversationId, targetId]);
    } else {
        await client.query(
            `INSERT INTO conversation_participants(conversation_id, user_id, last_read_at) VALUES($1, $2, NOW()), ($1, $3, NULL)`,
            [conversationId, senderId, targetId]
        );
    }

    return conversationId;
}

/**
 * Build legacy DB columns for backward compatibility.
 * Maps entityType → shared_post_id / shared_profile_id + shared_profile_type
 */
function buildLegacyFields(entityType, entityId) {
    if (entityType === "post") {
        return {
            columns: "shared_post_id,",
            placeholders: "$6,",
            values: [entityId],
            nextIdx: 7,
        };
    }
    if (entityType === "profile" || entityType === "company") {
        const profileType = entityType === "company" ? "company" : "user";
        return {
            columns: "shared_profile_id, shared_profile_type,",
            placeholders: "$6, $7,",
            values: [entityId, profileType],
            nextIdx: 8,
        };
    }
    // Future entities — no legacy columns
    return {
        columns: "",
        placeholders: "",
        values: [],
        nextIdx: 6,
    };
}

/**
 * Build legacy shared_post object from entity preview (for existing frontend compat)
 */
function buildLegacyPostPreview(preview) {
    return {
        post_id: preview.entityId,
        content: preview.subtitle,
        author: { full_name: preview.title.replace("Post by ", ""), avatar_url: preview.image },
        media: null,
        post_type: preview.post_type || "text",
        title: preview.post_title || null,
        poll: preview.poll || null,
    };
}

/**
 * Build legacy shared_profile object from entity preview (for existing frontend compat)
 */
function buildLegacyProfilePreview(preview) {
    return {
        name: preview.title,
        avatar: preview.image,
        headline: preview.subtitle,
    };
}

module.exports = { shareEntity, trackShare };
