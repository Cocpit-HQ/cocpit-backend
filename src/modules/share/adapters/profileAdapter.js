const pool = require("../../../core/db/pool");

/**
 * Profile Adapter
 * Converts user profile entity to universal preview metadata.
 */
async function resolve(userId) {
    const res = await pool.query(
        `SELECT user_id, full_name, headline, avatar_url, account_name, location
         FROM users WHERE user_id = $1`,
        [userId]
    );
    if (res.rowCount === 0) return null;

    const u = res.rows[0];
    return {
        entityType: "profile",
        entityId: userId,
        title: u.full_name,
        subtitle: u.headline || "Cocpit Member",
        image: u.avatar_url,
        url: `/profile/${u.account_name || userId}`,
    };
}

module.exports = { resolve };
