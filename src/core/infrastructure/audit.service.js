const logAudit = async (client, { entityId, entityType = 'ORGANIZATION', actorId, actorRole = null, action, metadata = {} }) => {
    try {
        const query = `
            INSERT INTO audit_logs (entity_type, entity_id, actor_id, actor_role, action, metadata)
            VALUES ($1, $2, $3, $4, $5, $6)
        `;
        await client.query(query, [entityType, entityId, actorId, actorRole, action, metadata]);
    } catch (err) {
        console.error("Audit Log Error:", err);
    }
};

/**
 * Resolves actor role details and logs audit entry within current or new DB client.
 * Also emits real-time 'activity_updated' notification to organization room.
 */
const logOrgActivity = async (clientOrPool, { orgId, userId, action, metadata = {}, req = null }) => {
    if (!orgId) return;

    let actorRole = req?.actor?.roleName || null;
    let roleId = req?.actor?.roleId || null;

    if (!actorRole && userId) {
        try {
            const memberRes = await clientOrPool.query(
                `SELECT r.name as role_name, r.role_id 
                 FROM organization_members m
                 JOIN organization_roles r ON m.role_id = r.role_id
                 WHERE m.org_id = $1 AND m.user_id = $2
                 UNION
                 SELECT 'Owner' as role_name, NULL as role_id
                 FROM organizations
                 WHERE org_id = $1 AND created_by = $2
                 LIMIT 1`,
                [orgId, userId]
            );
            if (memberRes.rows.length > 0) {
                actorRole = memberRes.rows[0].role_name;
                roleId = memberRes.rows[0].role_id;
            }
        } catch (e) {
            console.error('[logOrgActivity] Failed to resolve member role:', e);
        }
    }

    const enrichedMetadata = {
        ...metadata,
        ...(roleId ? { roleId: String(roleId) } : {}),
        ...(actorRole ? { roleName: actorRole } : {})
    };

    await logAudit(clientOrPool, {
        entityId: orgId,
        entityType: 'ORGANIZATION',
        actorId: userId,
        actorRole: actorRole || 'Member',
        action,
        metadata: enrichedMetadata
    });

    try {
        const socketService = require("./socket.service");
        socketService.notifyOrg(orgId, "activity_updated", {
            action,
            targetType: metadata?.targetType || 'job',
            timestamp: new Date().toISOString()
        });
    } catch (sockErr) {
        // Non-blocking socket error
    }
};

module.exports = { logAudit, logOrgActivity };
