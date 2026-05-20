const pool = require("../core/db/pool");
const { getConversationRoom } = require("../core/utils/socketRooms");
const { markConversationAsRead } = require("../services/conversationRead.service");
const socketService = require("../core/infrastructure/socket.service");

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
      FROM conversation_participants cp
      WHERE cp.conversation_id = $1 AND cp.left_at IS NULL
      AND (
        cp.user_id = $2
        OR cp.org_id IN (SELECT org_id FROM organization_members WHERE user_id = $2)
      )
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
  socket.on("typing", async ({ conversationId }) => {
    if (!conversationId) return;
    
    // Track typing status in-memory
    socketService.setTyping(userId, conversationId, true);

    const room = getConversationRoom(conversationId);

    // Fetch sender name (Optimisation: Cache this in socket.user or via Redis)
    let username = "Someone";
    try {
      const userRes = await pool.query(
        "SELECT full_name FROM users WHERE user_id = $1",
        [userId]
      );
      if (userRes.rowCount > 0) {
        username = userRes.rows[0].full_name;
      }
    } catch (err) {
      console.error("Error fetching user for typing:", err);
    }

    // Broadcast to others in the room
    socket.to(room).emit("isTyping", {
      senderId: userId,
      conversationId,
      username: username
    });
  });

  // Stop Typing Indicator
  socket.on("stopTyping", ({ conversationId }) => {
    if (!conversationId) return;

    // Track typing status in-memory
    socketService.setTyping(userId, conversationId, false);

    const room = getConversationRoom(conversationId);
    socket.to(room).emit("stoppedTyping", {
      conversationId,
      senderId: userId,
    });
  });

  // Mark Conversation as Read (socket path)
  socket.on("markConversationRead", async (payload, callback) => {
    try {
      const conversationId = payload?.conversationId;
      let companyId = payload?.companyId || null;

      if (!conversationId) {
        if (typeof callback === "function") callback({ success: false, message: "conversationId is required" });
        return;
      }

      if (companyId) {
        const membershipCheck = await pool.query(
          `SELECT 1 FROM organization_members WHERE user_id = $1 AND org_id = $2 LIMIT 1`,
          [userId, companyId]
        );

        if (membershipCheck.rowCount === 0) {
          if (typeof callback === "function") callback({ success: false, message: "Invalid company context" });
          return;
        }
      } else {
        companyId = null;
      }

      const readResult = await markConversationAsRead({
        conversationId,
        userId,
        companyId,
      });

      if (typeof callback === "function") {
        callback({
          success: true,
          conversationId,
          readAt: readResult.readAt,
          readCount: readResult.readCount,
          messageIds: readResult.messageIds,
        });
      }
    } catch (err) {
      if (typeof callback === "function") {
        callback({
          success: false,
          message: err.message || "Failed to mark conversation as read",
        });
      } else {
        socket.emit("error", { message: err.message || "Failed to mark conversation as read" });
      }
    }
  });

  /* =====================================================
     GROUP CHAT SPECIFIC EVENTS
     ===================================================== */

  // Join Group (Alias for joinConversation but with explicit semantics)
  socket.on("joinGroup", async (payload) => {
    try {
      // payload can be a string (groupId) or object { groupId }
      const groupId = typeof payload === "string" ? payload : payload?.groupId;

      if (!groupId) return;

      // Validate UUID
      const uuidRegex =
        /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

      if (!uuidRegex.test(groupId)) {
        socket.emit("error", { message: "Invalid group ID" });
        return;
      }

      // Check membership
      // Reusing the same table (conversation_participants) as groups are conversations
      const result = await pool.query(
        `
        SELECT 1 
        FROM conversation_participants 
        WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL
        `,
        [groupId, userId]
      );

      if (result.rowCount > 0) {
        const room = getConversationRoom(groupId); // Reuse same room naming convention
        socket.join(room);
        // console.log(`User ${userId} joined group room: ${room}`);
      } else {
        socket.emit("error", { message: "Unauthorized access to group" });
      }
    } catch (err) {
      console.error("Error joining group:", err);
    }
  });

  // Group Typing Indicator
  socket.on("groupTyping", async ({ groupId }) => {
    if (!groupId) return;

    // Track group typing status in-memory
    socketService.setTyping(userId, groupId, true);

    const room = getConversationRoom(groupId);

    // Fetch sender name (Optimisation: Cache this in socket.user or via Redis)
    let username = "Someone";
    try {
      const userRes = await pool.query(
        "SELECT full_name FROM users WHERE user_id = $1",
        [userId]
      );
      if (userRes.rowCount > 0) {
        username = userRes.rows[0].full_name;
      }
    } catch (err) {
      console.error("Error fetching user for typing:", err);
    }

    socket.to(room).emit("isTyping", {
      senderId: userId,
      conversationId: groupId,
      isGroup: true,
      username: username
    });
  });

  // Stop Group Typing
  socket.on("stopGroupTyping", ({ groupId }) => {
    if (!groupId) return;

    // Track group typing status in-memory
    socketService.setTyping(userId, groupId, false);

    const room = getConversationRoom(groupId);
    socket.to(room).emit("stoppedTyping", {
      conversationId: groupId,
      isGroup: true,
      senderId: userId
    });
  });
};
