const logAudit = async (client, { entityId, entityType = 'COMPANY', actorId, action, metadata = {} }) => {
    try {
        const query = `
            INSERT INTO audit_logs (entity_type, entity_id, actor_id, action, metadata)
            VALUES ($1, $2, $3, $4, $5)
        `;
        await client.query(query, [entityType, entityId, actorId, action, metadata]);
    } catch (err) {
        console.error("Audit Log Error:", err);
    }
};

module.exports = { logAudit };
