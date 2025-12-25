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
