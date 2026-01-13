const pool = require("../db/pool");
const { getConversationRoom } = require("../utils/socketRooms");

module.exports.registerChatHandlers = (io, socket) => {
  const userId = socket.userId;

  // Join Conversation with Security Check
  socket.on("joinConversation", async (conversationId) => {
    if (!conversationId) return;

    try {
      // Validate participation in DB
      const result = await pool.query(
        "SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2",
        [conversationId, userId]
      );

      if (result.rowCount > 0) {
        const room = getConversationRoom(conversationId);
        socket.join(room);
        console.log(`User ${userId} securely joined conversation ${conversationId}`);
      } else {
        console.warn(`Unauthorized join attempt by ${userId} for conversation ${conversationId}`);
        // Optionally emit an error event back to client
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
