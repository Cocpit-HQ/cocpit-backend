const pool = require("../db/pool");
const { logAudit } = require("../services/audit.service");

exports.getEvents = async (req, res) => {
  const {
    q, // General search
    title,
    location,
    type, // event_type
    category,
    date,
    startDate,
    endDate,
    organizer,
    cursor,
    userId: filterUserId, // Explicitly allow filtering by a specific user ID (e.g. for "My Events" search)
    limit = 10
  } = req.query;

  try {
    const userId = req.user ? req.user.sub : null;
    const values = [];

    // Base Query - Selecting events and resolving saved status properly
    let query = `
      SELECT e.*, u.full_name as organizer_name,
      (SELECT COUNT(*)::int FROM event_registrations er WHERE er.event_id = e.event_id) AS registered_count,
      CASE 
        WHEN es.event_id IS NOT NULL THEN true
        ELSE false
      END AS "isSaved"
      FROM events e
      JOIN users u ON e.organizer_id = u.user_id
      LEFT JOIN event_saves es 
        ON es.event_id = e.event_id AND es.user_id = $1
      WHERE 1=1
    `;

    values.push(userId); // $1 is always userId (can be null)

    /* ---------------------------------------------------------
       🔍 Search & Filtering (Granular Pattern)
    --------------------------------------------------------- */

    // 0. Filter by specific Organizer ID (e.g. for "My Events" search)
    if (filterUserId) {
      values.push(filterUserId);
      query += ` AND e.organizer_id = $${values.length}`;
    }

    // 1. General Search (q) - Searches multiple fields
    if (q) {
      values.push(`%${q}%`);
      const idx = values.length;
      query += ` AND (e.title ILIKE $${idx} OR e.description ILIKE $${idx} OR e.location ILIKE $${idx} OR u.full_name ILIKE $${idx})`;
    }

    // 2. Specific Title Filter
    if (title) {
      values.push(`%${title}%`);
      query += ` AND e.title ILIKE $${values.length}`;
    }

    // 3. Location Filter
    if (location) {
      values.push(`%${location}%`);
      query += ` AND e.location ILIKE $${values.length}`;
    }

    // 4. Category Filter
    if (category) {
      values.push(`%${category}%`);
      query += ` AND e.category ILIKE $${values.length}`;
    }

    // 5. Organizer Filter (Name)
    if (organizer) {
      values.push(`%${organizer}%`);
      query += ` AND u.full_name ILIKE $${values.length}`;
    }

    // 6. Event Type (Online/InPerson)
    if (type) {
      values.push(type);
      query += ` AND e.event_type = $${values.length}`;
    }

    // 7. Dates
    // Specific Date (YYYY-MM-DD)
    if (date) {
      values.push(date);
      query += ` AND DATE(e.start_time) = $${values.length}`;
    }

    // Date Range (Start)
    if (startDate) {
      values.push(startDate);
      query += ` AND e.start_time >= $${values.length}`;
    }

    // Date Range (End)
    if (endDate) {
      values.push(endDate);
      query += ` AND e.start_time <= $${values.length}`;
    }

    /* ---------------------------------------------------------
       📄 Pagination (Cursor-based)
    --------------------------------------------------------- */
    if (cursor) {
      try {
        const decoded = Buffer.from(cursor, 'base64').toString('ascii');
        const [cursorTime, cursorId] = decoded.split('_');

        if (cursorTime && cursorId) {
          values.push(cursorTime);
          const timeIdx = values.length;
          values.push(cursorId);
          const idIdx = values.length;

          // (start_time > cursTime) OR (start_time = cursTime AND event_id > cursId)
          query += ` AND (e.start_time > $${timeIdx} OR (e.start_time = $${timeIdx} AND e.event_id > $${idIdx}))`;
        }
      } catch (e) {
        // Ignore invalid cursor
      }
    }

    query += ` ORDER BY e.start_time ASC, e.event_id ASC`;

    // Limit + 1 for hasMore check
    const limitNum = parseInt(limit) || 10;
    values.push(limitNum + 1);
    query += ` LIMIT $${values.length}`;

    const result = await pool.query(query, values);

    const items = result.rows;
    let nextCursor = null;
    let hasMore = false;

    if (items.length > limitNum) {
      hasMore = true;
      items.pop();
      const lastItem = items[items.length - 1];
      const rawCursor = `${lastItem.start_time.toISOString()}_${lastItem.event_id}`;
      nextCursor = Buffer.from(rawCursor).toString('base64');
    }

    res.json({
      items,
      nextCursor,
      hasMore
    });

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
    const { title, description, category, eventType, virtualLink, location, startTime, endTime, maxAttendees, registrationDeadline, waitlist } = req.body;
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

    // Audit Log logic for events
    // Assuming personal events for now as no company_id is present
    // If company events are supported later, we can add company_id check

    res.status(201).json({ message: "Event created successfully", eventId });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Error creating event" });
  }
};
exports.registerForEvent = async (req, res) => {
  const userId = req.user.sub;
  const eventId = req.params.id;

  let { name, email, mobile_number, company_name, job_title } = req.body;

  if (mobile_number) {
    // Sanitize: remove non-digits
    mobile_number = mobile_number.replace(/\D/g, '');
    // If starting with 0 and length is 11, remove leading 0
    if (mobile_number.length === 11 && mobile_number.startsWith('0')) {
      mobile_number = mobile_number.substring(1);
    }
  }

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
            SELECT e.*, u.full_name AS organizer_name,
            (SELECT COUNT(*)::int FROM event_registrations er WHERE er.event_id = e.event_id) AS registered_count,
            CASE 
    WHEN es.event_id IS NOT NULL THEN true
    ELSE false
  END AS "isSaved"
            FROM event_registrations er
            JOIN events e ON er.event_id = e.event_id
            JOIN users u ON e.organizer_id = u.user_id
            LEFT JOIN event_saves es 
  ON es.event_id = e.event_id
   AND es.user_id = $1          -- IMPORTANT
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
        SELECT 
  e.*,
  u.full_name AS organizer_name,
  (SELECT COUNT(*)::int FROM event_registrations er WHERE er.event_id = e.event_id) AS registered_count,
  CASE 
    WHEN es.event_id IS NOT NULL THEN true
    ELSE false
  END AS "isSaved"
FROM events e
JOIN users u 
  ON e.organizer_id = u.user_id
LEFT JOIN event_saves es 
  ON es.event_id = e.event_id
 AND es.user_id = $1          -- IMPORTANT
WHERE e.organizer_id = $1
ORDER BY e.start_time ASC;

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
            SELECT e.*, u.full_name AS organizer_name,
            (SELECT COUNT(*)::int FROM event_registrations er WHERE er.event_id = e.event_id) AS registered_count
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

exports.updateEvent = async (req, res) => {
  const userId = req.user.sub;
  const eventId = req.params.id;
  const { title, description, category, eventType, virtualLink, location, startTime, endTime, maxAttendees, registrationDeadline, waitlist } = req.body;
  const bannerUrl = req.file ? req.file.path : undefined; // Only update if file provided

  try {
    // Check ownership
    const eventCheck = await pool.query("SELECT organizer_id, banner_url FROM events WHERE event_id = $1", [eventId]);
    if (eventCheck.rowCount === 0) return res.status(404).json({ message: "Event not found" });
    if (eventCheck.rows[0].organizer_id !== userId) return res.status(403).json({ message: "Not authorized to update this event" });

    const currentBanner = eventCheck.rows[0].banner_url;

    // Construct Update Query dynamically
    const updates = [];
    const values = [];
    let idx = 1;

    const addUpdate = (col, val) => {
      updates.push(`${col} = $${idx}`);
      values.push(val);
      idx++;
    };

    if (title) addUpdate('title', title);
    if (description) addUpdate('description', description);
    if (category) addUpdate('category', category);
    if (eventType) {
      addUpdate('event_type', eventType);
      if (eventType === 'Online') {
        addUpdate('virtual_link', virtualLink);
        addUpdate('location', null);
      } else {
        addUpdate('virtual_link', null);
        addUpdate('location', location);
      }
    }
    if (startTime) addUpdate('start_time', startTime);
    if (endTime) addUpdate('end_time', endTime);
    if (maxAttendees) addUpdate('max_attendees', Number(maxAttendees));
    if (registrationDeadline) addUpdate('registration_deadline', registrationDeadline);
    if (waitlist !== undefined) addUpdate('waitlist_enabled', Boolean(waitlist));
    if (bannerUrl) addUpdate('banner_url', bannerUrl);

    if (updates.length === 0) return res.json({ message: "No changes provided" });

    values.push(eventId);
    const query = `UPDATE events SET ${updates.join(', ')} WHERE event_id = $${idx} RETURNING *`;

    const result = await pool.query(query, values);

    res.json({ message: "Event updated successfully", event: result.rows[0] });

  } catch (err) {
    console.error("Update event error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

exports.deleteEvent = async (req, res) => {
  const userId = req.user.sub;
  const eventId = req.params.id;

  try {
    // Check ownership
    const eventCheck = await pool.query("SELECT organizer_id FROM events WHERE event_id = $1", [eventId]);
    if (eventCheck.rowCount === 0) return res.status(404).json({ message: "Event not found" });
    if (eventCheck.rows[0].organizer_id !== userId) return res.status(403).json({ message: "Not authorized to delete this event" });

    // Delete (Assuming cascade for related tables or manual cleanup if needed)
    // We should probably delete registrations and saves first if no cascade
    await pool.query("DELETE FROM event_registrations WHERE event_id = $1", [eventId]);
    await pool.query("DELETE FROM event_saves WHERE event_id = $1", [eventId]);

    await pool.query("DELETE FROM events WHERE event_id = $1", [eventId]);

    res.json({ message: "Event deleted successfully" });
  } catch (err) {
    console.error("Delete event error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};
