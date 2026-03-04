const { Server } = require("socket.io");
const { createClient } = require("redis");
const { createAdapter } = require("@socket.io/redis-adapter");
const { verifyAccessToken } = require("../core/utils/jwt");
const { getUserRoom } = require("../core/utils/socketRooms");
const socketService = require("../core/infrastructure/socket.service");
const statusHandler = require("./status.handler");
const chatHandler = require("./chat.handler");
const storyHandler = require("./story.handler");
const notificationHandler = require("./notification.handler");

module.exports.initSocket = async (httpServer) => {
  // CORS Configuration
  const corsOptions = {
    origin: function (origin, callback) {
      if (!origin ||
        origin.match(/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/) ||
        origin.match(/^http:\/\/192\.168\.\d+\.\d+(:\d+)?$/) ||
        origin === "https://frontend.cocpit.in") {
        callback(null, true);
      } else if (process.env.ALLOWED_ORIGINS && process.env.ALLOWED_ORIGINS.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: ["GET", "POST", "OPTIONS", "PUT", "DELETE"],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-company-id'],
    credentials: true,
  };

  const io = new Server(httpServer, {
    cors: corsOptions,
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

    // Auto-join personal room
    socket.join(getUserRoom(userId));

    // Handle Online Status
    statusHandler.handleConnection(socket);

    // Register Chat Events
    chatHandler.registerChatHandlers(io, socket);

    // Register Story Events
    storyHandler.registerStoryHandlers(io, socket);

    // Register Notification Events (Company rooms)
    notificationHandler.registerNotificationHandlers(io, socket);

    // Auto-join all company rooms for this user
    notificationHandler.autoJoinCompanyRooms(socket);

    // Handle Disconnect
    socket.on("disconnect", () => {
      statusHandler.handleDisconnect(socket);
    });
  });

  return io;
};
