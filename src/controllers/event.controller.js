const pool = require("../db/pool");

exports.getEvents = async (req, res) => {
  const { location, type, date } = req.query;

  try {
    if (date) {
        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
        if (!dateRegex.test(date)) {
            return res.status(400).json({
                message: "Date must be in YYYY-MM-DD format"
            });
        }
    }

    let query = `
      SELECT e.*, u.full_name as organizer_name
      FROM events e
      JOIN users u ON e.organizer_id = u.user_id
      WHERE e.start_time > now()
    `;

    const values = [];

    if (location) {
      values.push(location);
      query += ` AND e.location = $${values.length}`;
    }

    if (type) {
      values.push(type);
      query += ` AND e.event_type = $${values.length}`;
    }

    if (date) {
      values.push(date);
      query += ` AND DATE(e.start_time) = $${values.length}`;
    }

    query += ` ORDER BY e.start_time ASC`;

    const result = await pool.query(query, values);
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
  try {
    const userId = req.user.sub;
    const { title, description,category, eventType, virtualLink, location, startTime, endTime, maxAttendees, registrationDeadline, waitlist } = req.body;
    if (!title || !description || !startTime) return res.status(400).json({ message: "Please fill all required fields" });
    if (eventType === "Online" && !virtualLink) return res.status(400).json({ message: "Virtual link is required for online events" });
    const bannerUrl = req.file ? req.file.path : null;

    const result = await pool.query(
      `INSERT INTO events (
        organizer_id,
        title,
        description,
        category,
        event_type,
        location,
        virtual_link,
        start_time,
        end_time,
        banner_url,
        max_attendees,
        waitlist_enabled,
        registration_deadline
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING event_id`,
      [
        userId,
        title,
        description,
        category,
        eventType,
        eventType === "InPerson" ? location : null,
        eventType === "Online" ? virtualLink : null,
        startTime,
        endTime,
        bannerUrl,
        maxAttendees ? Number(maxAttendees) : null,
        Boolean(waitlist),
        registrationDeadline,
       
      ]
    );
    const eventId = result.rows[0].event_id;

    console.log("Event created with ID:", eventId);

    res.status(201).json({ message: "Event created successfully", eventId });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Error creating event" });
  }
};
exports.registerForEvent = async (req, res) => {
  const userId = req.user.sub;
  const eventId = req.params.id;

  const { name, email, mobile_number, company_name, job_title } = req.body;

  
  if (!name || !email || !mobile_number) {
    return res.status(400).json({
      message: "Name, email, and mobile number are required",
    });
  }

  try {
    const check = await pool.query(
      `SELECT 1 FROM event_registrations 
       WHERE event_id=$1 AND user_id=$2`,
      [eventId, userId]
    );

    if (check.rowCount > 0) {
      return res.status(400).json({
        message: "You are already registered"
      });
    }
     const countRes = await pool.query(
      `SELECT COUNT(*) 
       FROM event_registrations 
       WHERE event_id=$1`,
      [eventId]
    );
    const eventRes = await pool.query(
      `SELECT max_attendees, waitlist_enabled 
       FROM events 
       WHERE event_id=$1`,
      [eventId]
    );
    const total = Number(countRes.rows[0].count);
    const { max_attendees, waitlist_enabled } = eventRes.rows[0];

    if (max_attendees && total >= max_attendees) {
      if (!waitlist_enabled) {
        return res.status(400).json({
          message: "Event is full"
        });
      }

      return res.status(200).json({
        message: "Event full, added to waitlist"
      });
    }
    await pool.query(
      `INSERT INTO event_registrations
       (event_id,user_id,name,email,mobile_number,company_name,job_title)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [eventId, userId, name, email, mobile_number, company_name, job_title]
    );

    res.status(201).json({
      message: "Registered successfully"
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};
exports.unregisterFromEvent = async (req, res) => {
    const eventId = req.params.id;
    const userId = req.user.sub; // from requireAuth

    try {
        
        const registration = await pool.query(
            "SELECT * FROM event_registrations WHERE event_id = $1 AND user_id = $2",
            [eventId, userId]
        );

        if (registration.rowCount === 0) {
            return res.status(400).json({ message: "You are not registered for this event" });
        }
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
        const event = await pool.query(
            "SELECT 1 FROM events WHERE event_id = $1",
            [eventId]
        );

        if (event.rowCount === 0) {
            return res.status(404).json({ message: "Event not found" });
        }

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
        const event = await pool.query(
            "SELECT 1 FROM events WHERE event_id = $1",
            [eventId]
        );

        if (event.rowCount === 0) {
            return res.status(404).json({ message: "Event not found" });
        }

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
