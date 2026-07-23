/**
 * Organization Chat Session Controller
 * Implements: getActive, getHistory (read-only audit views)
 * Claiming/releasing/takeover has been removed from the active chat flow (see ID-296).
 */

const pool = require("../../core/db/pool");

const CHAT_VIEW_PERMISSIONS = [
    'VIEW_ORGANIZATION_CHATS',
    'MANAGE_ORGANIZATION_CHATS',
    'VIEW_COMPANY_CHATS',
    'MANAGE_COMPANY_CHATS',
];

// Feature flag check
function isFeatureEnabled(orgId) {
    // Environment-level flag
    if (process.env.organization_chat_sessions_ENABLED === 'false') return false;
    // Per-organization flag (comma-separated organization IDs or 'all')
    const perOrg = process.env.organization_chat_sessions_COMPANIES || 'all';
    if (perOrg === 'all') return true;
    return perOrg.split(',').map(s => s.trim()).includes(orgId);
}

function hasAnyPermission(permissions = [], requiredPermissions = []) {
    if (permissions.includes('*')) return true;
    return requiredPermissions.some((permission) => permissions.includes(permission));
}

function getRequestedOrganizationActorId(req, fallbackOrgId = null) {
    const actorOrgId = req.actor?.type === 'ORGANIZATION' ? req.actor.orgId : null;

    if (actorOrgId && fallbackOrgId && actorOrgId !== fallbackOrgId) {
        const err = new Error("Active organization actor does not match requested organization");
        err.statusCode = 403;
        throw err;
    }

    return actorOrgId;
}

async function getChatActorContext(client, req, orgId, { requiredPermissions = [] } = {}) {
    if (req.actor?.type === 'ORGANIZATION') {
        if (req.actor.orgId !== orgId) {
            const err = new Error("Active organization actor does not match requested organization");
            err.statusCode = 403;
            throw err;
        }

        const actorPermissions = req.actor.permissions || [];
        if (!hasAnyPermission(actorPermissions, requiredPermissions)) {
            const err = new Error("Missing required organization chat permission");
            err.statusCode = 403;
            throw err;
        }

        return {
            userId: req.user.sub,
            roleId: req.actor.roleId || null,
            roleName: req.actor.roleName || null,
            permissions: actorPermissions,
        };
    }

    const memberRes = await client.query(
        `SELECT cm.user_id, cm.role_id, cr.name AS role_name, cr.permissions
         FROM organization_members cm
         LEFT JOIN organization_roles cr ON cm.role_id = cr.role_id
         WHERE cm.org_id = $1 AND cm.user_id = $2 AND cm.status = 'ACTIVE'`,
        [orgId, req.user.sub]
    );
    if (memberRes.rowCount === 0) {
        const err = new Error("Not an active member of this organization");
        err.statusCode = 403;
        throw err;
    }

    const member = memberRes.rows[0];
    const permissions = member.permissions || [];
    if (!hasAnyPermission(permissions, requiredPermissions)) {
        const err = new Error("Missing required organization chat permission");
        err.statusCode = 403;
        throw err;
    }

    return {
        userId: req.user.sub,
        roleId: member.role_id || null,
        roleName: member.role_name || null,
        permissions,
    };
}

/**
 * GET /api/organization-chat-sessions/active
 * Query: ?conversationId=...
 */
exports.getActiveSession = async (req, res) => {
    const { conversationId } = req.query;
    let targetOrgId;

    try {
        targetOrgId = getRequestedOrganizationActorId(req);
    } catch (err) {
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }

    if (!targetOrgId) {
        return res.status(403).json({ message: "Organization actor context is required" });
    }

    if (!conversationId) {
        return res.status(400).json({ message: "conversationId is required" });
    }

    // Handle "new" conversation flow (not yet created)
    if (conversationId === 'new') {
        // Return null session but indicate feature state if needed
        return res.json({ session: null, featureEnabled: isFeatureEnabled(targetOrgId) });
    }

    if (!isFeatureEnabled(targetOrgId)) {
        return res.json({ session: null, featureEnabled: false });
    }

    try {
        const result = await pool.query(
            `SELECT ccs.session_id, ccs.handler_user_id, ccs.handler_name_snapshot,
                    ccs.handler_role_name_snapshot, ccs.status, ccs.started_at,
                    ccs.last_activity_at, ccs.message_count
             FROM organization_chat_sessions ccs
             WHERE ccs.conversation_id = $1 AND ccs.org_id = $2 AND ccs.status = 'ACTIVE'`,
            [conversationId, targetOrgId]
        );

        if (result.rowCount === 0) {
            return res.json({ session: null, featureEnabled: true });
        }

        return res.json({ session: result.rows[0], featureEnabled: true });
    } catch (err) {
        console.error("Error in getActiveSession:", err);
        return res.status(500).json({ message: "Internal server error" });
    }
};

/**
 * GET /api/organization-chat-sessions/history
 * Query: ?memberId=...&page=1&limit=20
 * Requires VIEW_ORGANIZATION_CHATS permission
 */
exports.getSessionHistory = async (req, res) => {
    const { memberId, startDate, endDate, page = 1, limit = 20 } = req.query;
    let targetOrgId;

    try {
        targetOrgId = getRequestedOrganizationActorId(req);
    } catch (err) {
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }

    if (!targetOrgId) {
        return res.status(403).json({ message: "Organization actor context is required" });
    }

    if (!isFeatureEnabled(targetOrgId)) {
        return res.status(403).json({ message: "Chat sessions are not enabled for this organization" });
    }

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const safeLimit = Math.min(parseInt(limit) || 20, 100);

    try {
        await getChatActorContext(pool, req, targetOrgId, {
            requiredPermissions: CHAT_VIEW_PERMISSIONS,
        });

        let query = `
            SELECT ccs.session_id, ccs.conversation_id, ccs.handler_user_id,
                   ccs.handler_name_snapshot, ccs.handler_role_name_snapshot,
                   ccs.status, ccs.started_at, ccs.ended_at, ccs.end_reason,
                   ccs.message_count, ccs.last_activity_at,
                   ccs.transferred_to, ccs.transferred_from_session_id
            FROM organization_chat_sessions ccs
            WHERE ccs.org_id = $1
        `;
        const params = [targetOrgId];
        let paramIdx = 2;

        if (memberId) {
            query += ` AND ccs.handler_user_id = $${paramIdx}`;
            params.push(memberId);
            paramIdx++;
        }

        if (startDate) {
            query += ` AND ccs.started_at >= $${paramIdx}`;
            params.push(startDate);
            paramIdx++;
        }

        if (endDate) {
            query += ` AND ccs.started_at <= $${paramIdx}`;
            params.push(endDate);
            paramIdx++;
        }

        query += ` ORDER BY ccs.started_at DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;
        params.push(safeLimit, offset);

        const result = await pool.query(query, params);

        // Count total
        let countQuery = `SELECT COUNT(*)::int AS total FROM organization_chat_sessions WHERE org_id = $1`;
        const countParams = [targetOrgId];
        if (memberId) {
            countQuery += ` AND handler_user_id = $${countParams.length + 1}`;
            countParams.push(memberId);
        }
        if (startDate) {
            countQuery += ` AND started_at >= $${countParams.length + 1}`;
            countParams.push(startDate);
        }
        if (endDate) {
            countQuery += ` AND started_at <= $${countParams.length + 1}`;
            countParams.push(endDate);
        }
        const countRes = await pool.query(countQuery, countParams);

        return res.json({
            sessions: result.rows,
            total: countRes.rows[0].total,
            page: parseInt(page),
            limit: safeLimit
        });
    } catch (err) {
        console.error("Error in getSessionHistory:", err);
        return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }
};

/**
 * GET /api/organization-chat-sessions/:sessionId/messages
 * Fetch messages belonging to a specific session
 */
exports.getSessionMessages = async (req, res) => {
    const { sessionId } = req.params;

    try {
        // Get session details first to verify permissions and get context
        const sessionRes = await pool.query(
            `SELECT * FROM organization_chat_sessions WHERE session_id = $1`,
            [sessionId]
        );

        if (sessionRes.rowCount === 0) {
            return res.status(404).json({ message: "Session not found" });
        }

        const session = sessionRes.rows[0];

        try {
            await getChatActorContext(pool, req, session.org_id, {
                requiredPermissions: CHAT_VIEW_PERMISSIONS,
            });
        } catch (err) {
            return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
        }

        // Fetch messages with session_id
        const messagesRes = await pool.query(
            `SELECT m.*, 
                    CASE WHEN m.sender_type = 'ORGANIZATION' THEN $2
                         WHEN m.sender_type = 'COMPANY' THEN $2
                         ELSE u.full_name END as sender_name,
                    CASE WHEN m.sender_type = 'ORGANIZATION' THEN NULL
                         WHEN m.sender_type = 'COMPANY' THEN NULL
                         ELSE u.avatar_url END as sender_avatar
             FROM messages m
             LEFT JOIN active_users u ON m.sender_id = u.user_id
             WHERE m.session_id = $1
             ORDER BY m.created_at ASC`,
            [sessionId, session.handler_name_snapshot] // Use snapshot name for organization messages in this session
        );

        res.json(messagesRes.rows);

    } catch (err) {
        console.error("Error in getSessionMessages:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

/**
 * Helper: End all active sessions for a member (e.g. on removal)
 * Executed within an external transaction (client)
 */
exports.endAllSessionsForMember = async (client, orgId, memberId, actorId) => {
    // Audit logging happens in the caller or triggered by status change, 
    // but here we force update status
    const result = await client.query(
        `UPDATE organization_chat_sessions
         SET status = 'ENDED', 
             ended_at = NOW(), 
             end_reason = 'member_removed'
         WHERE org_id = $1 
           AND handler_user_id = $2 
           AND status = 'ACTIVE'
         RETURNING session_id`,
        [orgId, memberId]
    );

    if (result.rowCount > 0) {
        // Emit events for each ended session
        // Note: we might not be able to emit to the removed member effectively if they are disconnected,
        // but we should notify the organization room or conversation room
        // Since we are inside a transaction, we should technically wait for commit,
        // but for socket events we often emit immediately or fire-and-forget.
        // Better pattern: return the list of ended sessions and let the controller emit after commit.
        // However, this is a helper. We'll rely on the caller or just emit best-effort.

        // Let's return the sessions so caller can log/emit if needed
        return result.rows;
    }
    return [];
};

/**
 * Helper: End all active sessions for an organization (e.g. on deactivation)
 */
exports.endAllSessionsForOrganization = async (client, orgId, actorId) => {
    const result = await client.query(
        `UPDATE organization_chat_sessions
         SET status = 'ENDED', 
             ended_at = NOW(), 
             end_reason = 'company_deactivated'
         WHERE org_id = $1 
           AND status = 'ACTIVE'
         RETURNING session_id`,
        [orgId]
    );
    return result.rows;
};
