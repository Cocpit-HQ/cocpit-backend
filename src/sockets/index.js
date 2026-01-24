const { Server } = require("socket.io");
const { createClient } = require("redis");
const { createAdapter } = require("@socket.io/redis-adapter");
const { verifyAccessToken } = require("../utils/jwt");
const { getUserRoom } = require("../utils/socketRooms");
const socketService = require("../services/socket.service");
const statusHandler = require("./status.handler");
const chatHandler = require("./chat.handler");

module.exports.initSocket = async (httpServer) => {
  // CORS Configuration
  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim())
    : ["http://localhost:3000"];

  const io = new Server(httpServer, {
    cors: {
      origin: allowedOrigins,
      methods: ["GET", "POST"],
      credentials: true,
    },
  });

  // Redis Adapter Setup
  const redisUrl = process.env.REDIS_URL ||
    (process.env.REDIS_HOST ? `redis://${process.env.REDIS_HOST}:${process.env.REDIS_PORT || 6379}` : null);

  if (redisUrl) {
    try {
      const pubClient = createClient({ url: redisUrl });
      const subClient = pubClient.duplicate();

      await Promise.all([pubClient.connect(), subClient.connect()]);

      io.adapter(createAdapter(pubClient, subClient));
      console.log("✅ Redis adapter initialized for Socket.IO");
    } catch (err) {
      console.error("❌ Redis connection failed, falling back to in-memory adapter:", err.message);
      // We don't exit process, just fallback to default memory adapter
    }
  } else {
    console.log("⚠️ No REDIS_URL found, using in-memory adapter");
  }

  // Auth Middleware
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.split(" ")[1];

    if (!token) {
      return next(new Error("Authentication error: No token provided"));
    }

    try {
      const decoded = await verifyAccessToken(token);
      socket.userId = decoded.sub;
      socket.sessionId = decoded.sid;
      socket.roles = decoded.roles || [];
      next();
    } catch (err) {
      next(new Error("Authentication error: Invalid token"));
    }
  });

  // Initialize Service
  socketService.init(io);

  // Connection Handler
  io.on("connection", (socket) => {
    const userId = socket.userId;
    console.log(`User connected: ${userId} (Socket ID: ${socket.id})`);

    // Auto-join personal room
    socket.join(getUserRoom(userId));

    // Handle Online Status
    statusHandler.handleConnection(socket);

    // Register Chat Events
    chatHandler.registerChatHandlers(io, socket);

    // Handle Disconnect
    socket.on("disconnect", () => {
      console.log(`User disconnected: ${userId}`);
      statusHandler.handleDisconnect(socket);
    });
  });

  return io;
};
