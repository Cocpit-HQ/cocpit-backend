const QRCode = require("qrcode");
const eventRepo = require("./event.repository");

const generateTicketId = (eventName) => {
  const prefix = eventName
    ? eventName.replace(/[^a-zA-Z0-9]/g, '').substring(0, 6).toUpperCase()
    : "TICKET";

  return `${prefix}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
};

const generateTicketQrCode = async ({ ticketId, eventId, userId }) => {
  const qrData = {
    ticketId,
    eventId,
    userId,
    type: "EVENT_TICKET",
  };

  return QRCode.toDataURL(JSON.stringify(qrData));
};

const createTicket = async (user, event) => {
  const userId = user.id || user.user_id;
  const eventId = event.id || event.event_id;

  // Prevent duplicate registration
  const existing = await eventRepo.getTicket(eventId, userId);
  if (existing) {
    throw new Error("User already registered for this event");
  }

  const ticketId = generateTicketId(event.title);
  const qrCode = await generateTicketQrCode({ ticketId, eventId, userId });

  const startDate = new Date(event.start_time);

  const dateFormatted = startDate.toLocaleDateString('en-US', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

  const timeFormatted = startDate.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });

  // Save ticket
  await eventRepo.insertTicket(ticketId, eventId, userId);

  return {
    ticketId,
    eventId,
    userId,
    name: user.name,
    email: user.email,
    mobile: user.mobile_number || user.mobile,

    eventName: event.title,
    date: dateFormatted,
    time: timeFormatted,
    location: event.event_type === "Online"
      ? "Online Event"
      : event.location || "TBA",

    organizerName: event.organizer_name || "Event Organizer",
    organizerEmail: event.organizer_email || "",

    qrCode,
    createdAt: new Date(),
  };
};

const getTicketPayload = async (user, event) => {
  const userId = user.id || user.user_id;
  const eventId = event.id || event.event_id;

  const existing = await eventRepo.getTicket(eventId, userId);
  if (!existing) return null;

  const ticketId = existing.ticket_id;
  const qrCode = await generateTicketQrCode({ ticketId, eventId, userId });

  const startDate = new Date(event.start_time);

  const dateFormatted = startDate.toLocaleDateString('en-US', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

  const timeFormatted = startDate.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });

  return {
    ticketId,
    eventId,
    userId,
    name: user.name || user.full_name,
    email: user.email,
    mobile: user.mobile_number || user.mobile || "",
    eventName: event.title,
    date: dateFormatted,
    time: timeFormatted,
    location: event.event_type === "Online"
      ? "Online Event"
      : event.location || "TBA",
    organizerName: event.organizer_name || "Event Organizer",
    organizerEmail: event.organizer_email || "",
    qrCode,
    createdAt: existing.created_at,
    status: existing.status,
    checkedInAt: existing.checked_in_at,
  };
};

module.exports = { createTicket, getTicketPayload };
