const pool = require("../db/pool");
const { getConversationRoom } = require("../utils/socketRooms");

module.exports.registerChatHandlers = (io, socket) => {
  const userId = socket.userId;

  // Join Conversation with Security Check
  socket.on("joinConversation", async (payload) => {
    try {
      const conversationId =
        typeof payload === "string"
          ? payload
          : payload?.conversationId;

      if (!conversationId) return;

      // Optional but strongly recommended UUID validation
      const uuidRegex =
        /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

      if (!uuidRegex.test(conversationId)) {
        socket.emit("error", { message: "Invalid conversation ID" });
        return;
      }

      const result = await pool.query(
        `
      SELECT 1 
      FROM conversation_participants 
      WHERE conversation_id = $1 AND user_id = $2
      `,
        [conversationId, userId]
      );

      if (result.rowCount > 0) {
        const room = getConversationRoom(conversationId);
        socket.join(room);

      } else {
        socket.emit("error", { message: "Unauthorized access to conversation" });
      }
    } catch (err) {
      console.error("Error joining conversation:", err);
    }
  });


  // Typing Indicator
  socket.on("typing", ({ conversationId }) => {
    // We assume client already joined successfully, but we could double check room membership
    // io.to() handles it fine.
    const room = getConversationRoom(conversationId);

    // Broadcast to others in the room
    socket.to(room).emit("isTyping", {
      senderId: userId,
      conversationId,
    });
  });

  // Stop Typing Indicator
  socket.on("stopTyping", ({ conversationId }) => {
    const room = getConversationRoom(conversationId);
    socket.to(room).emit("stoppedTyping", {
      conversationId,
    });
  });
};
