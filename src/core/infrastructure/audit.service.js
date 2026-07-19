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

module.exports = { logAudit };
