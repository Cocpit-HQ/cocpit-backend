/**
 * Event Controller (Thin)
 * Parses request, calls repository, sends response.
 */
const eventRepo = require("./event.repository");
const { logAudit } = require("../../core/infrastructure/audit.service");
const { checkOrgPermission } = require("../../core/utils/rbac");
const pool = require("../../core/db/pool");
const { notifyOrgFollowers } = require("../../services/notification.service");
const { logActivity, removeActivity } = require("../../core/services/activityLogger");
const QRCode = require("qrcode");
const { hasActorPermission } = require("../../core/middlewares/actor-context.middleware");


const getRequestedOrganizationActorId = (req, fallbackOrgId = null) => {
    // 1. Prefer Explicit Actor Header Context
    const actorOrgId = req.actor?.type === "ORGANIZATION" ? req.actor.orgId : null;

    if (actorOrgId) {
        if (fallbackOrgId && actorOrgId !== fallbackOrgId) {
            const err = new Error("Active organization actor does not match requested organization");
            err.statusCode = 403;
            throw err;
        }
        return actorOrgId;
    }

    // 2. Fallback to Passed companyId - but verify membership
    if (fallbackOrgId) {
        const userOrgs = req.userOrganizations || [];
        if (!userOrgs.includes(fallbackOrgId)) {
            const err = new Error("You do not have permission to act as this organization");
            err.statusCode = 403;
            throw err;
        }
        return fallbackOrgId;
    }

    return null;
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

function getEventStatus(event) {
    const now = new Date()

    const registrationDeadline = event.registration_deadline ? new Date(event.registration_deadline) : null
    const start = event.start_time ? new Date(event.start_time) : null
    const end = event.end_time ? new Date(event.end_time) : null

    if (end && now > end) return "expired"

    if (start && now >= start && (!end || now <= end)) return "live"

    if (registrationDeadline && now > registrationDeadline) return "registration_closed"

    return "upcoming"
}


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
      (SELECT COUNT(*)::int FROM attendance a WHERE a.event_id = e.event_id) AS checked_in_count,
      CASE WHEN es.event_id IS NOT NULL THEN true ELSE false END AS "isSaved"
      FROM events e LEFT JOIN active_users u ON e.organizer_id = u.user_id
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

        // Filter out expired events by default
        query += ` AND (e.end_time IS NULL OR e.end_time > NOW())`;

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

        const rawItems = await eventRepo.queryEvents(query, values);
        const items = rawItems.map(item => ({
            ...item,
            event_status: getEventStatus(item)
        }));

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
        
        const eventWithStatus = {
            ...event,
            event_status: getEventStatus(event)
        };
        res.json(eventWithStatus);
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
            startTime, endTime, maxAttendees, registrationDeadline, waitlist, companyId, organizerEmail } = req.body;

        if (!title || !description || !startTime) return res.status(400).json({ message: "Please fill all required fields" });
        if (eventType === "Online" && !virtualLink) return res.status(400).json({ message: "Virtual link is required for online events" });

        // Use companyId from body as fallback if no active organization actor header is present
        const requestedOrgId = getRequestedOrganizationActorId(req, companyId);
        
        let finalCompanyId = null;
        if (requestedOrgId && requestedOrgId !== "me") {
            await assertEventOrgPermission(req, requestedOrgId, ["CREATE_CONTENT", "MANAGE_COMPANY"]);
            finalCompanyId = requestedOrgId;
        }

        const bannerUrl = req.file ? req.file.path : null;
        const eventId = await eventRepo.createEvent({
            organizerId: userId, companyId: finalCompanyId, title, description, category, eventType,
            location, virtualLink, startTime, endTime, bannerUrl, maxAttendees, waitlist, registrationDeadline, organizerEmail
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
        
        // Fetch the ticket we just created to return it to the frontend
        const ticket = await eventRepo.getTicketByEventAndUser(eventId, userId);
        let ticketData = null;
        
        if (ticket) {
            const ticketId = `${ticket.event_id}_${ticket.user_id}`;
            const qrPayload = JSON.stringify({
                ticketId,
                eventId: ticket.event_id,
                userId: ticket.user_id,
            });
            const qrDataUrl = await QRCode.toDataURL(qrPayload, { width: 300, margin: 2 });
            
            ticketData = {
                ticketId,
                qrCode: qrDataUrl,
                eventName: ticket.event_title,
                name: ticket.name,
                email: ticket.email,
                mobile: ticket.mobile_number,
                date: ticket.start_time ? new Date(ticket.start_time).toLocaleDateString() : 'TBD',
                time: ticket.start_time ? new Date(ticket.start_time).toLocaleTimeString() : 'TBD',
                location: ticket.location,
                organizerName: ticket.organizer_name,
                organizerEmail: ticket.organizer_email,
                userId: ticket.user_id,
                eventId: ticket.event_id,
            };
        }

        res.status(201).json({ 
            message: "Registered successfully",
            ticket: ticketData
        });

        // 📝 Log Activity: Attend Event
        logActivity(userId, 'attend_event', 'event', eventId);
    } catch (error) {

        console.error(error);
        res.status(500).json({ message: "Server error" });
    }
};

exports.unregisterFromEvent = async (req, res) => {
    try {
        const isRegistered = await eventRepo.checkRegistration(req.params.id, req.user.sub);
        if (!isRegistered) return res.status(400).json({ message: "You are not registered for this event" });
        await eventRepo.unregisterUser(req.params.id, req.user.sub);
        res.json({ message: "Successfully unregistered from event" });

        // 📝 Remove Activity: Attend Event
        removeActivity(req.user.sub, 'attend_event', req.params.id);
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
        const rawEvents = await eventRepo.getMyRegisteredEvents(req.user.sub);
        const events = rawEvents.map(event => ({
            ...event,
            event_status: getEventStatus(event)
        }));
        res.json(events);
    } catch (err) {
        console.error("Get my registered events error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.getMyCreatedEvents = async (req, res) => {
    const userId = req.user.sub;

    try {
        const companyId = getRequestedOrganizationActorId(req, req.query.companyId || null);
        if (companyId) {
            await assertEventOrgPermission(req, companyId, ["VIEW_ANALYTICS", "CREATE_CONTENT", "MANAGE_COMPANY"]);
        }
        const rawEvents = await eventRepo.getMyCreatedEvents(userId, companyId);
        const events = rawEvents.map(event => ({
            ...event,
            event_status: getEventStatus(event)
        }));
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
        const rawEvents = await eventRepo.getMySavedEvents(req.user.sub);
        const events = rawEvents.map(event => ({
            ...event,
            event_status: getEventStatus(event)
        }));
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
        maxAttendees, registrationDeadline, waitlist, organizerEmail } = req.body;
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

        // Support changing organizer account (Post As)
        const companyId = req.body.companyId;
        if (companyId !== undefined) {
            const requestedOrgId = getRequestedOrganizationActorId(req, companyId);
            const finalOrgId = (requestedOrgId && requestedOrgId !== "me") ? requestedOrgId : null;

            if (finalOrgId) {
                await assertEventOrgPermission(req, finalOrgId, ["MANAGE_COMPANY", "CREATE_CONTENT"]);
            }
            add("org_id", finalOrgId);
        }

        if (organizerEmail !== undefined) add("organizer_email", organizerEmail);

        if (updates.length === 0) return res.json({ message: "No changes provided" });

        const updated = await eventRepo.updateEvent(eventId, updates, values);
        const updatedWithStatus = {
            ...updated,
            event_status: getEventStatus(updated)
        };
        res.json({ message: "Event updated successfully", event: updatedWithStatus });
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

// ─── Get Ticket ─────────────────────────────────────────────────────────────────

exports.getTicket = async (req, res) => {
    const userId = req.user.sub;
    const eventId = req.params.id;

    try {
        const ticket = await eventRepo.getTicketByEventAndUser(eventId, userId);
        if (!ticket) {
            return res.status(404).json({ message: "No ticket found. You may not be registered for this event." });
        }

        const startTime = new Date(ticket.start_time);
        const ticketId = `${ticket.event_id}_${ticket.user_id}`;
        const qrPayload = JSON.stringify({
            ticketId,
            eventId: ticket.event_id,
            userId: ticket.user_id,
        });
        const qrDataUrl = await QRCode.toDataURL(qrPayload, { width: 300, margin: 2 });

        res.json({
            ticketId,
            eventId: ticket.event_id,
            userId: ticket.user_id,
            name: ticket.name,
            email: ticket.email,
            mobile: ticket.mobile_number,
            eventName: ticket.event_title,
            date: startTime.toLocaleDateString(),
            time: startTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            location: ticket.event_type === 'Online' ? (ticket.virtual_link || 'Online') : (ticket.location || 'TBA'),
            organizerName: ticket.organizer_name || 'Unknown',
            organizerEmail: ticket.organizer_email || undefined,
            qrCode: qrDataUrl,
            createdAt: ticket.registered_at,
            status: 'confirmed',
            checkedInAt: null,
        });
    } catch (err) {
        console.error("Get ticket error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

// ─── Validate Ticket (Check-In) ─────────────────────────────────────────────────

exports.validateTicket = async (req, res) => {
    const routeEventId = req.params.id;
    const { ticketId, eventId: bodyEventId } = req.body;

    console.log("[ValidateTicket] Route eventId:", routeEventId);
    console.log("[ValidateTicket] Body ticketId:", ticketId, "bodyEventId:", bodyEventId);

    try {
        if (!ticketId) {
            return res.status(400).json({ message: "Ticket ID is required" });
        }

        // Extract userId from ticketId (format: "eventId_userId")
        // Both are UUIDs (no underscores), separated by a single underscore
        const underscoreIdx = ticketId.indexOf("_");
        let ticketEventId, ticketUserId;

        if (underscoreIdx > 0) {
            ticketEventId = ticketId.substring(0, underscoreIdx).toLowerCase();
            ticketUserId = ticketId.substring(underscoreIdx + 1).toLowerCase();
        } else {
            // Fallback: use bodyEventId and try ticketId as a standalone identifier
            ticketEventId = bodyEventId || routeEventId;
            ticketUserId = ticketId;
        }

        console.log("[ValidateTicket] Parsed ticketEventId:", ticketEventId, "ticketUserId:", ticketUserId);

        // Use bodyEventId if available and matches, otherwise use parsed ticketEventId
        const qrEventId = (bodyEventId || ticketEventId).toLowerCase();

        // Verify the ticket belongs to this event
        if (qrEventId !== routeEventId.toLowerCase()) {
            console.log("[ValidateTicket] MISMATCH: qrEventId:", qrEventId, "!== routeEventId:", routeEventId);
            
            // Fetch titles for both events to provide a clear error message
            let scannedEventTitle = "Unknown Event";
            let routeEventTitle = "Current Event";
            try {
                const [scannedRes, routeRes] = await Promise.all([
                    eventRepo.getEventById(qrEventId),
                    eventRepo.getEventById(routeEventId)
                ]);
                if (scannedRes) scannedEventTitle = scannedRes.title;
                if (routeRes) routeEventTitle = routeRes.title;
            } catch (e) { /* ignore */ }

            return res.status(400).json({ 
                message: `This ticket is for "${scannedEventTitle}". It cannot be used for "${routeEventTitle}".`,
                scannedEventTitle,
                routeEventTitle
            });
        }

        // Check if registration exists using the ROUTE event ID (authoritative)
        const isRegistered = await eventRepo.checkRegistration(routeEventId, ticketUserId);
        if (!isRegistered) {
            return res.status(404).json({ message: "No registration found for this ticket" });
        }

        // 1. Check if already marked in attendance table
        const attendanceRes = await pool.query(
            `SELECT checked_in_at FROM attendance WHERE event_id = $1 AND user_id = $2`,
            [routeEventId, ticketUserId]
        );

        if (attendanceRes.rows[0]?.checked_in_at) {
            return res.status(409).json({
                message: "This ticket has already been checked in. ❌",
                ticketId,
                checkedInAt: attendanceRes.rows[0].checked_in_at,
            });
        }

        // 2. Mark attendance (insert into attendance table)
        try {
            const insertResult = await pool.query(
                `INSERT INTO attendance (event_id, user_id, ticket_id)
                 VALUES ($1, $2, $3)
                 RETURNING checked_in_at`,
                [routeEventId, ticketUserId, ticketId]
            );

            res.json({
                message: "Entry Allowed ✅ Check-in successful!",
                user: ticketUserId,
                ticketId,
                checkedInAt: insertResult.rows[0].checked_in_at,
            });
        } catch (dbErr) {
            // Handle race condition / duplicate insert
            if (dbErr.code === "23505") {
                return res.status(409).json({
                    message: "This ticket has already been checked in. ❌",
                    ticketId,
                });
            }
            throw dbErr;
        }
    } catch (err) {
        console.error("Validate ticket error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

// ─── Get Participants (Registered + Attended) ────────────────────────────────────

exports.getEventParticipants = async (req, res) => {
    const userId = req.user.sub;
    const eventId = req.params.id;

    try {
        // Verify ownership / org permission
        const event = await eventRepo.getEventOwnership(eventId);
        if (!event) return res.status(404).json({ message: "Event not found" });

        let authorized = event.organizer_id === userId;
        if (!authorized && event.org_id) {
            try {
                await assertEventOrgPermission(req, event.org_id, ["VIEW_ANALYTICS", "MANAGE_COMPANY"]);
                authorized = true;
            } catch (_) { /* not authorized via org */ }
        }
        if (!authorized) return res.status(403).json({ message: "Not authorized to view participants" });

        const participants = await eventRepo.getEventParticipants(eventId);
        res.json(participants);
    } catch (err) {
        console.error("Get participants error:", err);
        res.status(500).json({ message: "Error fetching participants" });
    }
};
