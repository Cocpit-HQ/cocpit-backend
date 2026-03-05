const pool = require("../../../core/db/pool");

/**
 * Event Adapter
 * Converts event entity to universal preview metadata.
 */
async function resolve(eventId) {
    const res = await pool.query(
        `SELECT event_id, title, description, banner_url
         FROM events WHERE event_id = $1`,
        [eventId]
    );
    if (res.rowCount === 0) return null;

    const e = res.rows[0];
    return {
        entityType: "event",
        entityId: eventId,
        title: e.title,
        subtitle: e.description ? e.description.substring(0, 120) : "Event",
        image: e.banner_url || null,
        url: `/events/${eventId}`,
    };
}

module.exports = { resolve };
