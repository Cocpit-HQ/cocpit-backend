/**
 * Organization Chat Session Controller
 * Implements: claim, release, takeover, getActive, getHistory
 * State machine: ACTIVE → TIMED_OUT | ENDED | TRANSFERRED (all terminal per row)
 */

const pool = require("../../core/db/pool");
const socketService = require("../../core/infrastructure/socket.service");
const { logAudit } = require("../../core/infrastructure/audit.service");
const { checkRateLimit } = require("../../core/utils/sessionRateLimiter");

// Feature flag check
function isFeatureEnabled(orgId) {
    // Environment-level flag
    if (process.env.organization_chat_sessions_ENABLED === 'false') return false;
    // Per-organization flag (comma-separated organization IDs or 'all')
    const perOrg = process.env.organization_chat_sessions_COMPANIES || 'all';
    if (perOrg === 'all') return true;
    return perOrg.split(',').map(s => s.trim()).includes(orgId);
}

// Valid state transitions
const VALID_TRANSITIONS = {
    'ACTIVE': ['TIMED_OUT', 'ENDED', 'TRANSFERRED'],
};

function isValidTransition(from, to) {
    return VALID_TRANSITIONS[from]?.includes(to) || false;
}

/**
 * POST /api/organization-chat-sessions/claim
 * Body: { conversationId, orgId }
 */
exports.claimSession = async (req, res) => {
    const userId = req.user.sub;
    const { conversationId, orgId, companyId } = req.body;
    const targetOrgId = orgId || companyId;

    if (!conversationId || !targetOrgId || conversationId === 'new') {
        return res.status(400).json({ message: "Valid conversationId and orgId are required" });
    }

    // Feature flag
    if (!isFeatureEnabled(targetOrgId)) {
        return res.status(403).json({ message: "Chat sessions are not enabled for this organization" });
    }

    // Rate limit
    const rateCheck = checkRateLimit(userId, 'session:claim');
    if (!rateCheck.allowed) {
        return res.status(429).json({ message: "Too many claim attempts", retryAfterMs: rateCheck.retryAfterMs });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');

        // 1. RBAC: verify membership + permissions
        const memberRes = await client.query(
            `SELECT cm.user_id, cr.name AS role_name, cr.role_id, cr.permissions
             FROM organization_members cm
             LEFT JOIN organization_roles cr ON cm.role_id = cr.role_id
             WHERE cm.org_id = $1 AND cm.user_id = $2 AND cm.status = 'ACTIVE'`,
            [targetOrgId, userId]
        );
        if (memberRes.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(403).json({ message: "Not an active member of this organization" });
        }

        const member = memberRes.rows[0];
        const permissions = member.permissions || [];
        const hasPermission = permissions.includes('*') ||
            permissions.includes('MANAGE_ORGANIZATION_CHATS') ||
            permissions.includes('VIEW_ORGANIZATION_CHATS') ||
            permissions.includes('MANAGE_COMPANY_CHATS') ||
            permissions.includes('VIEW_COMPANY_CHATS');
        if (!hasPermission) {
            await client.query('ROLLBACK');
            return res.status(403).json({ message: "Missing MANAGE_ORGANIZATION_CHATS permission" });
        }

        // 2. Verify conversation exists and company is a participant
        const convCheck = await client.query(
            `SELECT 1 FROM conversation_participants
             WHERE conversation_id = $1 AND org_id = $2 AND left_at IS NULL`,
            [conversationId, targetOrgId]
        );
        if (convCheck.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: "Organization is not a participant in this conversation" });
        }

        // 3. Self-guard: check if the other participant is the claiming user
        const selfCheck = await client.query(
            `SELECT 1 FROM conversation_participants
             WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`,
            [conversationId, userId]
        );
        if (selfCheck.rowCount > 0) {
            await client.query('ROLLBACK');
            return res.status(403).json({ message: "Cannot claim a conversation where you are the other participant" });
        }

        // 4. Check for existing ACTIVE session (SELECT FOR UPDATE for race safety)
        const activeSession = await client.query(
            `SELECT ccs.session_id, ccs.handler_user_id, ccs.handler_name_snapshot
             FROM organization_chat_sessions ccs
             WHERE ccs.conversation_id = $1 AND ccs.org_id = $2 AND ccs.status = 'ACTIVE'
             FOR UPDATE`,
            [conversationId, targetOrgId]
        );
        if (activeSession.rowCount > 0) {
            await client.query('ROLLBACK');
            const existing = activeSession.rows[0];
            return res.status(409).json({
                message: `Already claimed by ${existing.handler_name_snapshot}`,
                claimedBy: existing.handler_name_snapshot,
                sessionId: existing.session_id
            });
        }

        // 5. Snapshot handler info
        const userRes = await client.query(
            `SELECT full_name FROM users WHERE user_id = $1`, [userId]
        );
        const handlerName = userRes.rows[0]?.full_name || 'Unknown';

        // 6. Insert new session
        const insertRes = await client.query(
            `INSERT INTO organization_chat_sessions 
             (conversation_id, org_id, handler_user_id, 
              handler_name_snapshot, handler_role_id_snapshot, handler_role_name_snapshot,
              status)
             VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE')
             RETURNING session_id, started_at`,
            [conversationId, targetOrgId, userId, handlerName, member.role_id || null, member.role_name || null]
        );
        const session = insertRes.rows[0];

        // 7. Audit log
        await logAudit(client, {
            entityType: 'ORGANIZATION_CHAT_SESSION',
            entityId: targetOrgId,
            actorId: userId,
            action: 'SESSION_CLAIMED',
            metadata: { sessionId: session.session_id, conversationId }
        });

        await client.query('COMMIT');

        // 8. Notify all organization members via socket
        const members = await pool.query(
            'SELECT user_id FROM organization_members WHERE org_id = $1 AND status = $2',
            [targetOrgId, 'ACTIVE']
        );
        for (const m of members.rows) {
            socketService.notifyUser(m.user_id, 'session_claimed', {
                conversationId,
                sessionId: session.session_id,
                handlerUserId: userId,
                handlerName
            });
        }

        return res.status(201).json({
            sessionId: session.session_id,
            status: 'ACTIVE',
            startedAt: session.started_at,
            handlerName
        });

    } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '40001') {
            // Serialization failure — another claim won
            return res.status(409).json({ message: "Concurrent claim detected. Please retry." });
        }
        console.error("Error in claimSession:", err);
        return res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

/**
 * POST /api/organization-chat-sessions/release
 * Body: { sessionId }
 */
exports.releaseSession = async (req, res) => {
    const userId = req.user.sub;
    const { sessionId } = req.body;

    if (!sessionId) {
        return res.status(400).json({ message: "sessionId is required" });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const sessionRes = await client.query(
            `SELECT * FROM organization_chat_sessions WHERE session_id = $1 FOR UPDATE`,
            [sessionId]
        );
        if (sessionRes.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: "Session not found" });
        }

        const session = sessionRes.rows[0];

        // Only the handler can release their own session
        if (session.handler_user_id !== userId) {
            await client.query('ROLLBACK');
            return res.status(403).json({ message: "Only the session handler can release this session" });
        }

        // Validate transition
        if (!isValidTransition(session.status, 'ENDED')) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: `Cannot end session in '${session.status}' state` });
        }

        // Feature flag
        if (!isFeatureEnabled(session.org_id)) {
            await client.query('ROLLBACK');
            return res.status(403).json({ message: "Chat sessions are not enabled for this organization" });
        }

        await client.query(
            `UPDATE organization_chat_sessions
             SET status = 'ENDED', ended_at = NOW(), end_reason = 'manual'
             WHERE session_id = $1`,
            [sessionId]
        );

        await logAudit(client, {
            entityType: 'ORGANIZATION_CHAT_SESSION',
            entityId: session.org_id,
            actorId: userId,
            action: 'SESSION_ENDED',
            metadata: { sessionId, conversationId: session.conversation_id, messageCount: session.message_count }
        });

        await client.query('COMMIT');

        // Notify organization members
        const members = await pool.query(
            'SELECT user_id FROM organization_members WHERE org_id = $1 AND status = $2',
            [session.org_id, 'ACTIVE']
        );
        for (const m of members.rows) {
            socketService.notifyUser(m.user_id, 'session_released', {
                conversationId: session.conversation_id,
                sessionId,
                reason: 'manual'
            });
        }

        return res.json({ message: "Session ended", sessionId });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Error in releaseSession:", err);
        return res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

/**
 * POST /api/organization-chat-sessions/takeover
 * Body: { conversationId, orgId }
 * Requires FORCE_TAKEOVER permission
 */
exports.takeoverSession = async (req, res) => {
    const userId = req.user.sub;
    const { conversationId, orgId, companyId } = req.body;
    const targetOrgId = orgId || companyId;

    if (!conversationId || !targetOrgId || conversationId === 'new') {
        return res.status(400).json({ message: "Valid conversationId and orgId are required" });
    }

    if (!isFeatureEnabled(targetOrgId)) {
        return res.status(403).json({ message: "Chat sessions are not enabled for this organization" });
    }

    // Rate limit
    const rateCheck = checkRateLimit(userId, 'session:takeover');
    if (!rateCheck.allowed) {
        // Audit repeated attempts
        const auditClient = await pool.connect();
        try {
            await logAudit(auditClient, {
                entityType: 'ORGANIZATION_CHAT_SESSION',
                entityId: targetOrgId,
                actorId: userId,
                action: 'REPEATED_TAKEOVER_ATTEMPTS',
                metadata: { conversationId }
            });
        } finally { auditClient.release(); }

        return res.status(429).json({ message: "Too many takeover attempts", retryAfterMs: rateCheck.retryAfterMs });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');

        // 1. RBAC: verify FORCE_TAKEOVER permission
        const memberRes = await client.query(
            `SELECT cm.user_id, cr.name AS role_name, cr.role_id, cr.permissions
             FROM organization_members cm
             LEFT JOIN organization_roles cr ON cm.role_id = cr.role_id
             WHERE cm.org_id = $1 AND cm.user_id = $2 AND cm.status = 'ACTIVE'`,
            [targetOrgId, userId]
        );
        if (memberRes.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(403).json({ message: "Not an active member of this organization" });
        }

        const member = memberRes.rows[0];
        const permissions = member.permissions || [];
        const hasTakeoverPerm = permissions.includes('*') || permissions.includes('FORCE_TAKEOVER');
        if (!hasTakeoverPerm) {
            await client.query('ROLLBACK');
            return res.status(403).json({ message: "Missing FORCE_TAKEOVER permission" });
        }

        // 2. Self-guard
        const selfCheck = await client.query(
            `SELECT 1 FROM conversation_participants
             WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`,
            [conversationId, userId]
        );
        if (selfCheck.rowCount > 0) {
            await client.query('ROLLBACK');
            return res.status(403).json({ message: "Cannot take over a conversation where you are the other participant" });
        }

        // 3. Find active session
        const activeSession = await client.query(
            `SELECT * FROM organization_chat_sessions
             WHERE conversation_id = $1 AND org_id = $2 AND status = 'ACTIVE'
             FOR UPDATE`,
            [conversationId, targetOrgId]
        );
        if (activeSession.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: "No active session to take over. Use claim instead." });
        }

        const oldSession = activeSession.rows[0];

        // Cannot take over your own session
        if (oldSession.handler_user_id === userId) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: "You already hold this session" });
        }

        // 4. Transition old session: ACTIVE → TRANSFERRED
        if (!isValidTransition(oldSession.status, 'TRANSFERRED')) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: `Cannot transfer session in '${oldSession.status}' state` });
        }

        await client.query(
            `UPDATE organization_chat_sessions
             SET status = 'TRANSFERRED', ended_at = NOW(), end_reason = 'force_takeover', transferred_to = $2
             WHERE session_id = $1`,
            [oldSession.session_id, userId]
        );

        // 5. Snapshot new handler info
        const userRes = await client.query(
            `SELECT full_name FROM users WHERE user_id = $1`, [userId]
        );
        const handlerName = userRes.rows[0]?.full_name || 'Unknown';

        // 6. Create new session
        const newSessionRes = await client.query(
            `INSERT INTO organization_chat_sessions 
             (conversation_id, org_id, handler_user_id,
              handler_name_snapshot, handler_role_id_snapshot, handler_role_name_snapshot,
              status, transferred_from_session_id)
             VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7)
             RETURNING session_id, started_at`,
            [conversationId, targetOrgId, userId, handlerName,
                member.role_id || null, member.role_name || null,
                oldSession.session_id]
        );
        const newSession = newSessionRes.rows[0];

        // 7. Audit
        await logAudit(client, {
            entityType: 'ORGANIZATION_CHAT_SESSION',
            entityId: targetOrgId,
            actorId: userId,
            action: 'FORCE_TAKEOVER',
            metadata: {
                oldSessionId: oldSession.session_id,
                newSessionId: newSession.session_id,
                previousHandler: oldSession.handler_user_id,
                conversationId
            }
        });

        await client.query('COMMIT');

        // 8. Socket: notify old handler
        socketService.notifyUser(oldSession.handler_user_id, 'session_takeover_forced', {
            conversationId,
            oldSessionId: oldSession.session_id,
            newHandlerName: handlerName
        });

        // Notify all organization members
        const members = await pool.query(
            'SELECT user_id FROM organization_members WHERE org_id = $1 AND status = $2',
            [targetOrgId, 'ACTIVE']
        );
        for (const m of members.rows) {
            socketService.notifyUser(m.user_id, 'session_claimed', {
                conversationId,
                sessionId: newSession.session_id,
                handlerUserId: userId,
                handlerName
            });
        }

        return res.status(201).json({
            sessionId: newSession.session_id,
            status: 'ACTIVE',
            startedAt: newSession.started_at,
            handlerName,
            previousSessionId: oldSession.session_id
        });

    } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '40001') {
            return res.status(409).json({ message: "Concurrent operation detected. Please retry." });
        }
        console.error("Error in takeoverSession:", err);
        return res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

/**
 * GET /api/organization-chat-sessions/active
 * Query: ?conversationId=...&orgId=...
 */
exports.getActiveSession = async (req, res) => {
    const { conversationId, orgId, companyId } = req.query;
    const targetOrgId = orgId || companyId;

    if (!conversationId || !targetOrgId) {
        return res.status(400).json({ message: "conversationId and orgId are required" });
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
 * Query: ?orgId=...&memberId=...&page=1&limit=20
 * Requires VIEW_ORGANIZATION_CHATS permission
 */
exports.getSessionHistory = async (req, res) => {
    const { orgId, companyId, memberId, startDate, endDate, page = 1, limit = 20 } = req.query;
    const targetOrgId = orgId || companyId;

    if (!targetOrgId) {
        return res.status(400).json({ message: "orgId is required" });
    }

    if (!isFeatureEnabled(targetOrgId)) {
        return res.status(403).json({ message: "Chat sessions are not enabled for this organization" });
    }

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const safeLimit = Math.min(parseInt(limit) || 20, 100);

    try {
        // RBAC check
        const userId = req.user.sub;
        const memberCheck = await pool.query(
            `SELECT cr.permissions FROM organization_members cm
             LEFT JOIN organization_roles cr ON cm.role_id = cr.role_id
             WHERE cm.org_id = $1 AND cm.user_id = $2 AND cm.status = 'ACTIVE'`,
            [targetOrgId, userId]
        );
        if (memberCheck.rowCount === 0) {
            return res.status(403).json({ message: "Not a member of this organization" });
        }
        const perms = memberCheck.rows[0].permissions || [];
        if (!perms.includes('*') && !perms.includes('VIEW_ORGANIZATION_CHATS') && !perms.includes('MANAGE_ORGANIZATION_CHATS') && !perms.includes('VIEW_COMPANY_CHATS') && !perms.includes('MANAGE_COMPANY_CHATS')) {
            return res.status(403).json({ message: "Missing VIEW_ORGANIZATION_CHATS permission" });
        }

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
        return res.status(500).json({ message: "Internal server error" });
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

        // RBAC: Check if requester has VIEW_ORGANIZATION_CHATS for this organization
        const userId = req.user.sub;
        const memberCheck = await pool.query(
            `SELECT cr.permissions FROM organization_members cm
             LEFT JOIN organization_roles cr ON cm.role_id = cr.role_id
             WHERE cm.org_id = $1 AND cm.user_id = $2 AND cm.status = 'ACTIVE'`,
            [session.org_id, userId]
        );

        if (memberCheck.rowCount === 0) {
            return res.status(403).json({ message: "Not a member of the organization" });
        }
        const perms = memberCheck.rows[0].permissions || [];
        if (!perms.includes('*') && !perms.includes('VIEW_COMPANY_CHATS') && !perms.includes('MANAGE_COMPANY_CHATS')) {
            return res.status(403).json({ message: "Missing VIEW_COMPANY_CHATS permission" });
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
             LEFT JOIN users u ON m.sender_id = u.user_id
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
        [companyId]
    );
    return result.rows;
};
