const pool = require("../../../core/db/pool");

/**
 * Channel (Community) Adapter
 * Converts community entity to universal preview metadata.
 */
async function resolve(communityId) {
    const res = await pool.query(
        `SELECT community_id, name, description, banner_url, org_id
         FROM communities WHERE community_id = $1 AND is_active = TRUE`,
        [communityId]
    );
    if (res.rowCount === 0) return null;

    const c = res.rows[0];
    return {
        entityType: "channel",
        entityId: communityId,
        title: c.name,
        subtitle: c.description || "Cocpit Channel",
        image: c.banner_url || null,
        url: `/channels/${communityId}`,
    };
}

module.exports = { resolve };
