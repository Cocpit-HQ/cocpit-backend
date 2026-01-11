// const { Server } = require("socket.io");

// let io;

// module.exports.initSocket = (httpServer) => {
//   io = new Server(httpServer, {
//     cors: {
//       origin: "*", // set frontend URL in production
//     },
//   });

//   io.on("connection", (socket) => {
//     console.log("User connected:", socket.id);

//     // Join personal room (userId)
//     socket.on("join", (userId) => {
//       socket.join(`user_${userId}`);
//     });

//     socket.on("disconnect", () => {
//       console.log("User disconnected:", socket.id);
//     });
//   });

//   return io;
// };

// module.exports.getIO = () => {
//   if (!io) throw new Error("Socket.io not initialized");
//   return io;
// };

const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");

let io;
const onlineUsers = new Set();

module.exports.initSocket = (httpServer) => {
  io = new Server(httpServer, {
    cors: { origin: "*" },
  });

  // 🔐 JWT AUTH FOR SOCKET
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("Authentication error"));

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.userId = decoded.sub;
      next();
    } catch {
      next(new Error("Authentication error"));
    }
  });

  io.on("connection", (socket) => {
    const userId = socket.userId;
    console.log("User connected:", userId);

    // ✅ Personal room (for notifications, presence)
    socket.join(`user_${userId}`);
    onlineUsers.add(userId);

    io.emit("userStatusChanged", {
      userId,
      status: "online",
    });

    // ✅ Conversation room (for messages, deletes, typing)
    socket.on("joinConversation", (conversationId) => {
      socket.join(`conversation_${conversationId}`);
      console.log(
        `User ${userId} joined conversation ${conversationId}`
      );
    });

    // ✍️ Typing indicator
    socket.on("typing", ({ receiverId, conversationId }) => {
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


