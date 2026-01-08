const pool = require("../db/pool");

exports.getEvents = async (req, res) => {
    try {
        const result = await pool.query(
            `
            SELECT e.*, u.full_name as organizer_name
            FROM events e
            JOIN users u ON e.organizer_id = u.user_id
            WHERE e.start_time > now()
            ORDER BY e.start_time ASC
            `
        );
        res.json(result.rows);
    } catch (err) {
        console.error("Get events error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};
exports.getEventById = async (req, res) => {
    try {
        const { id } = req.params;         // get the id from URL
        const trimmedId = id.trim();       // optional: remove extra spaces

        const result = await pool.query(
            `
            SELECT 
                e.*,
                u.full_name AS organizer_name,
                COUNT(er.user_id) AS registered_count
            FROM events e
            JOIN users u ON e.organizer_id = u.user_id
            LEFT JOIN event_registrations er ON e.event_id = er.event_id
            WHERE e.event_id = $1
            GROUP BY e.event_id, u.full_name
            `,
            [trimmedId]                     // now this variable exists
        );

        console.log("Query result rows:", result.rows);

        if (result.rowCount === 0) {
            return res.status(404).json({ message: "Event not found" });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error("Get event by id error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.createEvent = async (req, res) => {
    const userId = req.user.sub;
    const { title, description, start_time, end_time, location, event_type, max_attendees } = req.body;

    try {
        const result = await pool.query(
            `
            INSERT INTO events (organizer_id, title, description, start_time, end_time, location, event_type, max_attendees)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING event_id
            `,
            [userId, title, description, start_time, end_time, location, event_type, max_attendees]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error("Create event error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.registerForEvent = async (req, res) => {
    const userId = req.user.sub;
    const { id } = req.params; // event_id

    try {
        // Check capacity
        const eventRes = await pool.query(`SELECT max_attendees FROM events WHERE event_id = $1`, [id]);
        if (eventRes.rowCount === 0) return res.status(404).json({ message: "Event not found" });

        const max = eventRes.rows[0].max_attendees;
        if (max) {
             const countRes = await pool.query(`SELECT COUNT(*) FROM event_registrations WHERE event_id = $1`, [id]);
             if (parseInt(countRes.rows[0].count) >= max) {
                 return res.status(409).json({ message: "Event is full" });
             }
        }

        await pool.query(
            `INSERT INTO event_registrations (event_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [id, userId]
        );
        res.status(200).json({ message: "Registered successfully" });
    } catch (err) {
        console.error("Register event error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};
exports.unregisterFromEvent = async (req, res) => {
    const eventId = req.params.id;
    const userId = req.user.id; // from requireAuth

    try {
        // Check if registration exists
        const registration = await pool.query(
            "SELECT * FROM event_registrations WHERE event_id = $1 AND user_id = $2",
            [eventId, userId]
        );

        if (registration.rowCount === 0) {
            return res.status(400).json({ message: "You are not registered for this event" });
        }

        // Delete registration
        await pool.query(
            "DELETE FROM event_registrations WHERE event_id = $1 AND user_id = $2",
            [eventId, userId]
        );

        res.json({ message: "Successfully unregistered from event" });
    } catch (err) {
        console.error("Unregister error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};
exports.checkRegistrationStatus = async (req, res) => {
    const userId = req.user.sub;
    const { id } = req.params; // event_id

    try {
        const result = await pool.query(
            `
            SELECT EXISTS(
                SELECT 1
                FROM event_registrations
                WHERE event_id = $1 AND user_id = $2
            ) AS "isRegistered"
            `,
            [id, userId]
        );

        res.json({ isRegistered: result.rows[0].isRegistered });
    } catch (err) {
        console.error("Check registration status error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};
exports.getMyRegisteredEvents = async (req, res) => {
    const userId = req.user.sub;

    try {
        const result = await pool.query(
            `
            SELECT e.*, u.full_name AS organizer_name
            FROM event_registrations er
            JOIN events e ON er.event_id = e.event_id
            JOIN users u ON e.organizer_id = u.user_id
            WHERE er.user_id = $1
            ORDER BY e.start_time ASC
            `,
            [userId]
        );

        res.json(result.rows);
    } catch (err) {
        console.error("Get my registered events error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};
exports.getMyCreatedEvents = async (req, res) => {
    const userId = req.user.sub;

    try {
        const result = await pool.query(
            `
            SELECT e.*, u.full_name AS organizer_name
            FROM events e
            JOIN users u ON e.organizer_id = u.user_id
            WHERE e.organizer_id = $1
            ORDER BY e.start_time ASC
            `,
            [userId]
        );

        res.json(result.rows);
    } catch (err) {
        console.error("Get my created events error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};
exports.saveEvent = async (req, res) => {
    const userId = req.user.sub;
    const eventId = req.params.id;

    try {
        // Insert into event_saves, ignore if already saved
        await pool.query(
            `
            INSERT INTO event_saves (user_id, event_id)
            VALUES ($1, $2)
            ON CONFLICT DO NOTHING
            `,
            [userId, eventId]
        );

        res.status(201).json({ message: "Event saved successfully" });
    } catch (err) {
        console.error("Save event error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.unsaveEvent = async (req, res) => {
    const userId = req.user.sub;
    const eventId = req.params.id;

    try {
        const result = await pool.query(
            `
            DELETE FROM event_saves
            WHERE user_id = $1 AND event_id = $2
            `,
            [userId, eventId]
        );

        if (result.rowCount === 0) {
            return res.status(400).json({ message: "Event was not saved" });
        }

        res.json({ message: "Event removed from saved list" });
    } catch (err) {
        console.error("Unsave event error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.getMySavedEvents = async (req, res) => {
    const userId = req.user.sub;

    try {
        const result = await pool.query(
            `
            SELECT e.*, u.full_name AS organizer_name
            FROM event_saves es
            JOIN events e ON es.event_id = e.event_id
            JOIN users u ON e.organizer_id = u.user_id
            WHERE es.user_id = $1
            ORDER BY es.saved_at DESC
            `,
            [userId]
        );

        res.json(result.rows);
    } catch (err) {
        console.error("Get saved events error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};
