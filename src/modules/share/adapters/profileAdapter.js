const pool = require("../../../core/db/pool");

/**
 * Profile Adapter
 * Converts user profile entity to universal preview metadata.
 */
async function resolve(userId) {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId);
    const query = isUuid
        ? `SELECT user_id, full_name, headline, avatar_url, account_name, location FROM users WHERE user_id = $1`
        : `SELECT user_id, full_name, headline, avatar_url, account_name, location FROM users WHERE account_name = $1`;

    const res = await pool.query(query, [userId]);
    if (res.rowCount === 0) return null;

    const u = res.rows[0];
    return {
        entityType: "profile",
        entityId: u.user_id,
        title: u.full_name,
        subtitle: u.headline || "Cocpit Member",
        image: u.avatar_url,
        url: `/profile/${u.account_name || u.user_id}`,
    };
}

module.exports = { resolve };
