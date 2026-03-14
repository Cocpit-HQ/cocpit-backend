/**
 * Event Controller (Thin)
 * Parses request, calls repository, sends response.
 */
const eventRepo = require("./event.repository");
const { logAudit } = require("../../core/infrastructure/audit.service");
const { checkOrgPermission } = require("../../core/utils/rbac");
const pool = require("../../core/db/pool");
const { notifyOrgFollowers } = require("../../services/notification.service");
const { hasActorPermission } = require("../../core/middlewares/actor-context.middleware");

const getRequestedOrganizationActorId = (req, fallbackOrgId = null) => {
    const actorOrgId = req.actor?.type === "ORGANIZATION" ? req.actor.orgId : null;

    if (actorOrgId && fallbackOrgId && actorOrgId !== fallbackOrgId) {
        const err = new Error("Active organization actor does not match requested organization");
        err.statusCode = 403;
        throw err;
    }

    return actorOrgId;
};

const hasAnyActorPermission = (actorPermissions, permissions) => {
    if (!permissions) return true;
    const list = Array.isArray(permissions) ? permissions : [permissions];
    return list.some((permission) => hasActorPermission(actorPermissions || [], permission));
};

const assertEventOrgPermission = async (req, orgId, permissions, queryable = pool) => {
    if (!orgId) return;

    if (req.actor?.type === "ORGANIZATION") {
        if (req.actor.orgId !== orgId) {
            const err = new Error("Active organization actor does not match requested organization");
            err.statusCode = 403;
            throw err;
        }
        if (!hasAnyActorPermission(req.actor.permissions, permissions)) {
            const err = new Error("Not authorized for this organization");
            err.statusCode = 403;
            throw err;
        }
        return;
    }

    const ok = await checkOrgPermission(queryable, orgId, req.user.sub, permissions);
    if (!ok) {
        const err = new Error("Not authorized for this organization");
        err.statusCode = 403;
        throw err;
    }
};

// ─── List Events (with filtering + cursor pagination) ───────────────────────────

exports.getEvents = async (req, res) => {
    const { q, title, location, type, category, date, startDate, endDate, organizer,
        cursor, userId: filterUserId, companyId: filterCompanyId, limit = 10 } = req.query;

    try {
        const userId = req.user ? req.user.sub : null;
        const filterOrgId = typeof filterCompanyId === "string" ? filterCompanyId : null;
        const values = [userId];

        let query = `SELECT e.*, COALESCE(c.name, u.full_name) as organizer_name,
      c.name as company_name, c.logo_url as company_logo,
      u.full_name as user_name, u.avatar_url as user_avatar,
      (SELECT COUNT(*)::int FROM event_registrations er WHERE er.event_id = e.event_id) AS registered_count,
      CASE WHEN es.event_id IS NOT NULL THEN true ELSE false END AS "isSaved"
      FROM events e LEFT JOIN users u ON e.organizer_id = u.user_id
      LEFT JOIN organizations c ON e.org_id = c.org_id
      LEFT JOIN event_saves es ON es.event_id = e.event_id AND es.user_id = $1
      WHERE 1=1`;

        if (filterOrgId && filterOrgId !== 'undefined') { values.push(filterOrgId); query += ` AND e.org_id = $${values.length}`; }
        else if (filterUserId && filterUserId !== 'undefined') { values.push(filterUserId); query += ` AND e.organizer_id = $${values.length}`; }
        if (q) { values.push(`%${q}%`); const idx = values.length; query += ` AND (e.title ILIKE $${idx} OR e.description ILIKE $${idx} OR e.location ILIKE $${idx} OR u.full_name ILIKE $${idx} OR c.name ILIKE $${idx})`; }
        if (title) { values.push(`%${title}%`); query += ` AND e.title ILIKE $${values.length}`; }
        if (location) { values.push(`%${location}%`); query += ` AND e.location ILIKE $${values.length}`; }
        if (category) { values.push(`%${category}%`); query += ` AND e.category ILIKE $${values.length}`; }
        if (organizer) { values.push(`%${organizer}%`); query += ` AND (u.full_name ILIKE $${values.length} OR c.name ILIKE $${values.length})`; }
        if (type) { values.push(type); query += ` AND e.event_type = $${values.length}`; }
        if (date) { values.push(date); query += ` AND DATE(e.start_time) = $${values.length}`; }
        if (startDate) { values.push(startDate); query += ` AND e.start_time >= $${values.length}`; }
        if (endDate) { values.push(endDate); query += ` AND e.start_time <= $${values.length}`; }

        if (cursor) {
            try {
                const decoded = Buffer.from(cursor, "base64").toString("ascii");
                const [cursorTime, cursorId] = decoded.split("_");
                if (cursorTime && cursorId) {
                    values.push(cursorTime); const timeIdx = values.length;
                    values.push(cursorId); const idIdx = values.length;
                    query += ` AND (e.start_time > $${timeIdx} OR (e.start_time = $${timeIdx} AND e.event_id > $${idIdx}))`;
                }
            } catch (e) { }
        }

        query += ` ORDER BY e.start_time ASC, e.event_id ASC`;
        const limitNum = parseInt(limit) || 10;
        values.push(limitNum + 1);
        query += ` LIMIT $${values.length}`;

        const items = await eventRepo.queryEvents(query, values);
        let nextCursor = null;
        let hasMore = false;

        if (items.length > limitNum) {
            hasMore = true;
            items.pop();
            const lastItem = items[items.length - 1];
            nextCursor = Buffer.from(`${lastItem.start_time.toISOString()}_${lastItem.event_id}`).toString("base64");
        }

        res.json({ items, nextCursor, hasMore });
    } catch (err) {
        console.error("Get events error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

// ─── Get Event By ID ────────────────────────────────────────────────────────────

exports.getEventById = async (req, res) => {
    try {
        const event = await eventRepo.getEventById(req.params.id.trim());
        if (!event) return res.status(404).json({ message: "Event not found" });
        res.json(event);
    } catch (err) {
        console.error("Get event by id error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

// ─── Create Event ───────────────────────────────────────────────────────────────

exports.createEvent = async (req, res) => {
    try {
        const userId = req.user.sub;
        const { title, description, category, eventType, virtualLink, location,
            startTime, endTime, maxAttendees, registrationDeadline, waitlist } = req.body;

        if (!title || !description || !startTime) return res.status(400).json({ message: "Please fill all required fields" });
        if (eventType === "Online" && !virtualLink) return res.status(400).json({ message: "Virtual link is required for online events" });

        const requestedOrgId = getRequestedOrganizationActorId(req);
        let finalCompanyId = null;
        if (requestedOrgId) {
            await assertEventOrgPermission(req, requestedOrgId, ["CREATE_CONTENT", "MANAGE_COMPANY"]);
            finalCompanyId = requestedOrgId;
        }

        const bannerUrl = req.file ? req.file.path : null;
        const eventId = await eventRepo.createEvent({
            organizerId: userId, companyId: finalCompanyId, title, description, category, eventType,
            location, virtualLink, startTime, endTime, bannerUrl, maxAttendees, waitlist, registrationDeadline,
        });

        if (finalCompanyId) {
            await logAudit(pool, { entityId: finalCompanyId, actorId: userId, action: "CREATE_EVENT", metadata: { eventId, title } });

            // Notify followers with 'events' preference enabled (fire-and-forget)
            notifyOrgFollowers(finalCompanyId, "events", {
                type: "organization_event",
                text: `New event: ${title}`,
                referenceId: eventId,
                metadata: { event_title: title, event_type: eventType || null },
            }).catch(err => console.error("Event notification error:", err));
        }

        res.status(201).json({ message: "Event created successfully", eventId });
    } catch (error) {
        console.error(error);
        res.status(error.statusCode || 500).json({ message: error.message || "Error creating event" });
    }
};

// ─── Registration ───────────────────────────────────────────────────────────────

exports.registerForEvent = async (req, res) => {
    const userId = req.user.sub;
    const eventId = req.params.id;
    let { name, email, mobile_number, company_name, job_title } = req.body;

    if (mobile_number) {
        mobile_number = mobile_number.replace(/\D/g, "");
        if (mobile_number.length === 11 && mobile_number.startsWith("0")) mobile_number = mobile_number.substring(1);
    }

    if (!name || !email || !mobile_number) return res.status(400).json({ message: "Name, email, and mobile number are required" });

    try {
        const alreadyRegistered = await eventRepo.checkRegistration(eventId, userId);
        if (alreadyRegistered) return res.status(400).json({ message: "You are already registered" });

        const total = await eventRepo.getRegistrationCount(eventId);
        const capacity = await eventRepo.getEventCapacity(eventId);

        if (capacity.max_attendees && total >= capacity.max_attendees) {
            if (!capacity.waitlist_enabled) return res.status(400).json({ message: "Event is full" });
            return res.status(200).json({ message: "Event full, added to waitlist" });
        }

        await eventRepo.registerUser(eventId, userId, { name, email, mobile_number, company_name, job_title });
        res.status(201).json({ message: "Registered successfully" });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Server error" });
    }
};

exports.unregisterFromEvent = async (req, res) => {
    try {
        const isRegistered = await eventRepo.checkRegistration(req.params.id, req.user.sub);
        if (!isRegistered) return res.status(400).json({ message: "You are not registered for this event" });
        await eventRepo.unregisterUser(req.params.id, req.user.sub);
        res.json({ message: "Successfully unregistered from event" });
    } catch (err) {
        console.error("Unregister error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.checkRegistrationStatus = async (req, res) => {
    try {
        const isRegistered = await eventRepo.checkRegistration(req.params.id, req.user.sub);
        res.json({ isRegistered });
    } catch (err) {
        console.error("Check registration status error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.getMyRegisteredEvents = async (req, res) => {
    try {
        const events = await eventRepo.getMyRegisteredEvents(req.user.sub);
        res.json(events);
    } catch (err) {
        console.error("Get my registered events error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.getMyCreatedEvents = async (req, res) => {
    const userId = req.user.sub;

    try {
        const requestedOrgId = getRequestedOrganizationActorId(req);
        if (requestedOrgId) {
            await assertEventOrgPermission(req, requestedOrgId, ["VIEW_ANALYTICS", "CREATE_CONTENT", "MANAGE_COMPANY"]);
        }
        const events = await eventRepo.getMyCreatedEvents(userId, requestedOrgId);
        res.json(events);
    } catch (err) {
        console.error("Get my created events error:", err);
        res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
    }
};

// ─── Saves ──────────────────────────────────────────────────────────────────────

exports.saveEvent = async (req, res) => {
    try {
        const exists = await eventRepo.eventExists(req.params.id);
        if (!exists) return res.status(404).json({ message: "Event not found" });
        await eventRepo.saveEvent(req.user.sub, req.params.id);
        res.status(201).json({ message: "Event saved successfully" });
    } catch (err) {
        console.error("Save event error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.unsaveEvent = async (req, res) => {
    try {
        const exists = await eventRepo.eventExists(req.params.id);
        if (!exists) return res.status(404).json({ message: "Event not found" });
        const removed = await eventRepo.unsaveEvent(req.user.sub, req.params.id);
        if (!removed) return res.status(400).json({ message: "Event was not saved" });
        res.json({ message: "Event removed from saved list" });
    } catch (err) {
        console.error("Unsave event error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.getMySavedEvents = async (req, res) => {
    try {
        const events = await eventRepo.getMySavedEvents(req.user.sub);
        res.json(events);
    } catch (err) {
        console.error("Get saved events error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

// ─── Update / Delete ────────────────────────────────────────────────────────────

exports.updateEvent = async (req, res) => {
    const userId = req.user.sub;
    const eventId = req.params.id;
    const { title, description, category, eventType, virtualLink, location, startTime, endTime,
        maxAttendees, registrationDeadline, waitlist } = req.body;
    const bannerUrl = req.file ? req.file.path : undefined;

    try {
        const event = await eventRepo.getEventOwnership(eventId);
        if (!event) return res.status(404).json({ message: "Event not found" });

        let authorized = event.organizer_id === userId;
        if (!authorized && event.org_id) {
            try {
                await assertEventOrgPermission(req, event.org_id, ["MANAGE_COMPANY", "CREATE_CONTENT"]);
                authorized = true;
            } catch (err) {
                return res.status(err.statusCode || 403).json({ message: err.message || "Not authorized to update this event" });
            }
        }
        if (!authorized) return res.status(403).json({ message: "Not authorized to update this event" });

        const updates = [];
        const values = [];
        let idx = 1;
        const add = (col, val) => { updates.push(`${col} = $${idx}`); values.push(val); idx++; };

        if (title) add("title", title);
        if (description) add("description", description);
        if (category) add("category", category);
        if (eventType) { add("event_type", eventType); if (eventType === "Online") { add("virtual_link", virtualLink); add("location", null); } else { add("virtual_link", null); add("location", location); } }
        if (startTime) add("start_time", startTime);
        if (endTime) add("end_time", endTime);
        if (maxAttendees) add("max_attendees", Number(maxAttendees));
        if (registrationDeadline) add("registration_deadline", registrationDeadline);
        if (waitlist !== undefined) add("waitlist_enabled", Boolean(waitlist));
        if (bannerUrl) add("banner_url", bannerUrl);

        if (updates.length === 0) return res.json({ message: "No changes provided" });

        const updated = await eventRepo.updateEvent(eventId, updates, values);
        res.json({ message: "Event updated successfully", event: updated });
    } catch (err) {
        console.error("Update event error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.deleteEvent = async (req, res) => {
    const userId = req.user.sub;
    const eventId = req.params.id;

    try {
        const event = await eventRepo.getEventOwnership(eventId);
        if (!event) return res.status(404).json({ message: "Event not found" });

        let authorized = event.organizer_id === userId;
        if (!authorized && event.org_id) {
            try {
                await assertEventOrgPermission(req, event.org_id, ["MANAGE_COMPANY", "CREATE_CONTENT"]);
                authorized = true;
            } catch (err) {
                return res.status(err.statusCode || 403).json({ message: err.message || "Not authorized to delete this event" });
            }
        }
        if (!authorized) return res.status(403).json({ message: "Not authorized to delete this event" });

        await eventRepo.deleteEvent(eventId);
        res.json({ message: "Event deleted successfully" });
    } catch (err) {
        console.error("Delete event error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};
