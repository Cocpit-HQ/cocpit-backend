const { Server } = require("socket.io");
const { createClient } = require("redis");
const { createAdapter } = require("@socket.io/redis-adapter");
const { verifyAccessToken } = require("../core/utils/jwt");
const { getUserRoom } = require("../core/utils/socketRooms");
const socketService = require("../core/infrastructure/socket.service");
const statusHandler = require("./status.handler");
const chatHandler = require("./chat.handler");
const storyHandler = require("./story.handler");
const postHandler = require("./post.handler");
const notificationHandler = require("./notification.handler");

module.exports.initSocket = async (httpServer) => {
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  // CORS Configuration
  const corsOptions = {
    origin: function (origin, callback) {
      if (!origin || 
          allowedOrigins.includes(origin) ||
          origin.match(/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/) ||
          origin.match(/^http:\/\/192\.168\.\d+\.\d+(:\d+)?$/) ||
          origin.match(/^https:\/\/.*\.ngrok-free\.(app|dev)$/) ||
          origin.match(/^https:\/\/.*\.loca\.lt$/) ||
          origin === "https://frontend.cocpit.in" ||
          origin === "https://uat.cocpit.in" ||
          origin === "https://staging.cocpit.in"  
      ) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: ["GET", "POST", "OPTIONS", "PUT", "DELETE"],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'x-actor-type',
      'x-actor-id',
      'x-company-id',
      'x-org-id',
    ],
    credentials: true,
  };

  const io = new Server(httpServer, {
    cors: corsOptions,
  });

  // Initialize Service immediately so other modules can use it
  socketService.init(io);

  // Redis Adapter Setup
  const redisUrl = process.env.REDIS_URL ||
    (process.env.REDIS_HOST ? `redis://${process.env.REDIS_HOST}:${process.env.REDIS_PORT || 6379}` : null);

  if (redisUrl) {
    try {
      const pubClient = createClient({ url: redisUrl });

      // Mandatory error handlers to prevent process crash
      pubClient.on("error", (err) => { /* Silently handled to prevent crashes */ });

      const subClient = pubClient.duplicate();
      subClient.on("error", (err) => { /* Silently handled to prevent crashes */ });

      await Promise.all([pubClient.connect(), subClient.connect()]);

      io.adapter(createAdapter(pubClient, subClient));
      console.log("✅ Redis adapter initialized for Socket.IO");
    } catch (err) {
      console.warn("⚠️ Redis unavailable for Socket.IO adapter. Falling back to in-memory.");
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
      
      // Check for suspended user
      const redisClient = require("../core/cache/redis");
      if (redisClient.status === 'ready' || redisClient.isOpen) {
        const isSuspended = await redisClient.get(`suspended_user:${decoded.sub}`);
        if (isSuspended) {
          return next(new Error("Authentication error: User account is suspended"));
        }
      }

      socket.userId = decoded.sub;
      socket.sessionId = decoded.sid;
      socket.roles = decoded.roles || [];
      socket.actorType = socket.handshake.auth?.actorType || socket.handshake.headers?.["x-actor-type"] || "USER";
      socket.actorId = socket.handshake.auth?.actorId || socket.handshake.headers?.["x-actor-id"] || null;
      socket.actorScope = socket.actorType === "ORGANIZATION" && socket.actorId ? `org:${socket.actorId}` : `user:${socket.userId}`;
      socket._actorRoom = null;
      next();
    } catch (err) {
      next(new Error("Authentication error: Invalid token"));
    }
  });

  // Initialized Service earlier

  // Connection Handler
  io.on("connection", (socket) => {
    const userId = socket.userId;

    // Auto-join personal room
    socket.join(getUserRoom(userId));

    if (socket.actorType === "ORGANIZATION" && socket.actorId) {
      notificationHandler.applyActorContextToRooms(socket, socket.actorType, socket.actorId);
    }

    // Handle Online Status
    statusHandler.handleConnection(socket);

    // Register Chat Events
    chatHandler.registerChatHandlers(io, socket);

    // Register Story Events
    storyHandler.registerStoryHandlers(io, socket);

    // Register Post Events
    postHandler.registerPostHandlers(io, socket);

    // Register Notification Events (Company rooms)
    notificationHandler.registerNotificationHandlers(io, socket);

    // Auto-join all company rooms for this user
    notificationHandler.autoJoinCompanyRooms(socket);

    socket.on("setActorContext", (payload) => {
      const actorType = payload?.actorType || "USER";
      const actorId = payload?.actorId || null;
      socket.actorType = actorType;
      socket.actorId = actorId;
      socket.actorScope = actorType === "ORGANIZATION" && actorId ? `org:${actorId}` : `user:${userId}`;
      notificationHandler.applyActorContextToRooms(socket, actorType, actorId);
    });

    // Handle Disconnect
    socket.on("disconnect", () => {
      statusHandler.handleDisconnect(socket);
    });
  });

  return io;
};
