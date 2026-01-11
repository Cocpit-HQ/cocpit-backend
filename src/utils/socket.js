const { Server } = require("socket.io");
const { verifyAccessToken } = require("./jwt");

let io;
const onlineUsers = new Set();

module.exports.initSocket = (httpServer) => {
  io = new Server(httpServer, {
    cors: { origin: "*" },
  });

  // JWT AUTH FOR SOCKET (ACCESS TOKEN ONLY)
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("Authentication error"));

    try {
      // verifyAccessToken already knows the secret internally
      const decoded = await verifyAccessToken(token);

      socket.userId = decoded.sub;
      socket.sessionId = decoded.sid;
      socket.roles = decoded.roles || [];

      next();
    } catch (err) {
      console.error("Socket auth error:", err.message);
      next(new Error("Authentication error"));
    }
  });

  io.on("connection", (socket) => {
    const userId = socket.userId;
    console.log("User connected:", userId);

    // Personal room (notifications, presence)
    socket.join(`user_${userId}`);
    onlineUsers.add(userId);

    io.emit("userStatusChanged", {
      userId,
      status: "online",
    });

    // Conversation room (messages, typing, deletes)
    socket.on("joinConversation", (conversationId) => {
      socket.join(`conversation_${conversationId}`);
      console.log(`User ${userId} joined conversation ${conversationId}`);
    });

    //  Typing indicator
    socket.on("typing", ({ conversationId }) => {
      io.to(`conversation_${conversationId}`).emit("isTyping", {
        senderId: userId,
        conversationId,
      });
    });

    socket.on("stopTyping", ({ conversationId }) => {
      io.to(`conversation_${conversationId}`).emit("stoppedTyping", {
        conversationId,
      });
    });

    socket.on("disconnect", () => {
      onlineUsers.delete(userId);

      io.emit("userStatusChanged", {
        userId,
        status: "offline",
      });

      console.log("User disconnected:", userId);
    });
  });
};

module.exports.getIO = () => {
  if (!io) throw new Error("Socket.io not initialized");
  return io;
};



