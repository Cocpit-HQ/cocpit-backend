/**
 * Event Repository
 * All database queries for events, registrations, and saves.
 */
const pool = require("../../core/db/pool");

// ─── Events ─────────────────────────────────────────────────────────────────────

const queryEvents = async (query, values) => {
    const result = await pool.query(query, values);
    return result.rows;
};

const getEventById = async (eventId) => {
    const result = await pool.query(
        `SELECT e.*, COALESCE(c.name, u.full_name) as organizer_name,
            c.name as company_name, c.logo_url as company_logo,
            u.full_name as user_name, u.avatar_url as user_avatar,
            COUNT(er.user_id) AS registered_count
     FROM events e
     LEFT JOIN users u ON e.organizer_id = u.user_id
     LEFT JOIN organizations c ON e.org_id = c.org_id
     LEFT JOIN event_registrations er ON e.event_id = er.event_id
     WHERE e.event_id = $1
     GROUP BY e.event_id, u.full_name, c.name, c.logo_url, u.avatar_url`,
        [eventId]
    );
    return result.rows[0] || null;
};

const createEvent = async (data) => {
    const { organizerId, companyId, title, description, category, eventType, location, virtualLink,
        startTime, endTime, bannerUrl, maxAttendees, waitlist, registrationDeadline } = data;
    const result = await pool.query(
        `INSERT INTO events (organizer_id, org_id, title, description, category, event_type, location,
       virtual_link, start_time, end_time, banner_url, max_attendees, waitlist_enabled, registration_deadline)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING event_id`,
        [organizerId, companyId, title, description, category, eventType,
            eventType === "InPerson" ? location : null, eventType === "Online" ? virtualLink : null,
            startTime, endTime, bannerUrl, maxAttendees ? Number(maxAttendees) : null,
            Boolean(waitlist), registrationDeadline]
    );
    return result.rows[0].event_id;
};

const getEventOwnership = async (eventId) => {
    const result = await pool.query(
        "SELECT organizer_id, org_id, banner_url FROM events WHERE event_id = $1",
        [eventId]
    );
    return result.rows[0] || null;
};

const updateEvent = async (eventId, updates, values) => {
    values.push(eventId);
    const query = `UPDATE events SET ${updates.join(", ")} WHERE event_id = $${values.length} RETURNING *`;
    const result = await pool.query(query, values);
    return result.rows[0] || null;
};

const deleteEvent = async (eventId) => {
    await pool.query("DELETE FROM event_registrations WHERE event_id = $1", [eventId]);
    await pool.query("DELETE FROM event_saves WHERE event_id = $1", [eventId]);
    await pool.query("DELETE FROM events WHERE event_id = $1", [eventId]);
};

// ─── Registrations ──────────────────────────────────────────────────────────────

const checkRegistration = async (eventId, userId) => {
    const result = await pool.query(
        "SELECT 1 FROM event_registrations WHERE event_id=$1 AND user_id=$2",
        [eventId, userId]
    );
    return result.rowCount > 0;
};

const getRegistrationCount = async (eventId) => {
    const result = await pool.query(
        "SELECT COUNT(*) FROM event_registrations WHERE event_id=$1",
        [eventId]
    );
    return Number(result.rows[0].count);
};

const getEventCapacity = async (eventId) => {
    const result = await pool.query(
        "SELECT max_attendees, waitlist_enabled FROM events WHERE event_id=$1",
        [eventId]
    );
    return result.rows[0] || null;
};

const registerUser = async (eventId, userId, data) => {
    const { name, email, mobile_number, company_name, job_title } = data;
    await pool.query(
        `INSERT INTO event_registrations (event_id, user_id, name, email, mobile_number, company_name, job_title)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [eventId, userId, name, email, mobile_number, company_name, job_title]
    );
};

const unregisterUser = async (eventId, userId) => {
    const result = await pool.query(
        "DELETE FROM event_registrations WHERE event_id = $1 AND user_id = $2",
        [eventId, userId]
    );
    return result.rowCount > 0;
};

const getMyRegisteredEvents = async (userId) => {
    const result = await pool.query(
        `SELECT e.*, COALESCE(c.name, u.full_name) as organizer_name, c.name as company_name,
            (SELECT COUNT(*)::int FROM event_registrations er WHERE er.event_id = e.event_id) AS registered_count,
            CASE WHEN es.event_id IS NOT NULL THEN true ELSE false END AS "isSaved"
     FROM event_registrations er
     JOIN events e ON er.event_id = e.event_id
     LEFT JOIN users u ON e.organizer_id = u.user_id
     LEFT JOIN organizations c ON e.org_id = c.org_id
     LEFT JOIN event_saves es ON es.event_id = e.event_id AND es.user_id = $1
     WHERE er.user_id = $1 AND (e.end_time IS NULL OR e.end_time > NOW()) ORDER BY e.start_time ASC`,
        [userId]
    );
    return result.rows;
};

const getMyCreatedEvents = async (userId, companyId = null) => {
    let query = `SELECT e.*, COALESCE(c.name, u.full_name) as organizer_name, c.name as company_name,
    (SELECT COUNT(*)::int FROM event_registrations er WHERE er.event_id = e.event_id) AS registered_count,
    CASE WHEN es.event_id IS NOT NULL THEN true ELSE false END AS "isSaved"
    FROM events e LEFT JOIN users u ON e.organizer_id = u.user_id
    LEFT JOIN organizations c ON e.org_id = c.org_id
    LEFT JOIN event_saves es ON es.event_id = e.event_id AND es.user_id = $1`;
    const params = [userId];

    if (companyId) {
        query += ` WHERE e.org_id = $2 ORDER BY e.start_time ASC`;
        params.push(companyId);
    } else {
        query += ` WHERE e.organizer_id = $1 AND e.org_id IS NULL ORDER BY e.start_time ASC`;
    }

    const result = await pool.query(query, params);
    return result.rows;
};

// ─── Saves ──────────────────────────────────────────────────────────────────────

const eventExists = async (eventId) => {
    const result = await pool.query("SELECT 1 FROM events WHERE event_id = $1", [eventId]);
    return result.rowCount > 0;
};

const saveEvent = async (userId, eventId) => {
    await pool.query(
        "INSERT INTO event_saves (user_id, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [userId, eventId]
    );
};

const unsaveEvent = async (userId, eventId) => {
    const result = await pool.query(
        "DELETE FROM event_saves WHERE user_id = $1 AND event_id = $2",
        [userId, eventId]
    );
    return result.rowCount > 0;
};

const getMySavedEvents = async (userId) => {
    const result = await pool.query(
        `SELECT e.*, COALESCE(c.name, u.full_name) as organizer_name, c.name as company_name,
            (SELECT COUNT(*)::int FROM event_registrations er WHERE er.event_id = e.event_id) AS registered_count
     FROM event_saves es JOIN events e ON es.event_id = e.event_id
     LEFT JOIN users u ON e.organizer_id = u.user_id
     LEFT JOIN organizations c ON e.org_id = c.org_id
     WHERE es.user_id = $1 ORDER BY es.saved_at DESC`,
        [userId]
    );
    return result.rows;
};

// ─── Ticket ─────────────────────────────────────────────────────────────────────

const getTicketByEventAndUser = async (eventId, userId) => {
    const result = await pool.query(
        `SELECT
            er.event_id,
            er.user_id,
            er.name,
            er.email,
            er.mobile_number,
            er.registered_at,
            e.title AS event_title,
            e.start_time,
            e.end_time,
            e.location,
            e.event_type,
            e.virtual_link,
            COALESCE(c.name, u.full_name) AS organizer_name,
            u.email AS organizer_email
        FROM event_registrations er
        JOIN events e ON er.event_id = e.event_id
        LEFT JOIN users u ON e.organizer_id = u.user_id
        LEFT JOIN organizations c ON e.org_id = c.org_id
        WHERE er.event_id = $1 AND er.user_id = $2`,
        [eventId, userId]
    );
    return result.rows[0] || null;
};

module.exports = {
    queryEvents, getEventById, createEvent, getEventOwnership, updateEvent, deleteEvent,
    checkRegistration, getRegistrationCount, getEventCapacity, registerUser, unregisterUser,
    getMyRegisteredEvents, getMyCreatedEvents,
    eventExists, saveEvent, unsaveEvent, getMySavedEvents,
    getTicketByEventAndUser,
};
