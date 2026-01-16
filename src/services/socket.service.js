const { getUserRoom, getConversationRoom } = require("../utils/socketRooms");

class SocketService {
  constructor() {
    this.io = null;
  }

  init(io) {
    this.io = io;
  }

  /**
   * Notify a specific user
   * @param {string} userId
   * @param {string} event
   * @param {object} payload
   */
  notifyUser(userId, event, payload) {
    if (!this.io) {
      console.warn("SocketService: io not initialized");
      return;
    }
    const room = getUserRoom(userId);
    this.io.to(room).emit(event, payload);
  }

  /**
   * Notify all participants in a conversation
   * @param {string} conversationId
   * @param {string} event
   * @param {object} payload
   */
  notifyConversation(conversationId, event, payload) {
    if (!this.io) {
      console.warn("SocketService: io not initialized");
      return;
    }
    const room = getConversationRoom(conversationId);
    this.io.to(room).emit(event, payload);
  }

  /**
   * Broadcast status change to a list of related users (friends/followers)
   * @param {string} userId - The user whose status changed
   * @param {string} status - 'online' or 'offline'
   * @param {Array<string>} relatedUserIds - List of user IDs to notify
   */
  broadcastStatus(userId, status, relatedUserIds) {
    if (!this.io) {
      console.warn("SocketService: io not initialized");
      return;
    }
    if (!relatedUserIds || relatedUserIds.length === 0) return;

    // We iterate and emit to each user's personal room
    // This scales better than global broadcast and ensures only relevant users get the update
    relatedUserIds.forEach((friendId) => {
      const room = getUserRoom(friendId);
      this.io.to(room).emit("userStatusChanged", {
        userId,
        status,
      });
    });
  }
  /**
   * Check if a user is online
   * @param {string} userId
   * @returns {boolean}
   */
  isUserOnline(userId) {
    if (!this.io) return false;
    const room = getUserRoom(userId);
    // io.sockets.adapter.rooms is a Map where key is room name and value is Set of socket IDs
    return this.io.sockets.adapter.rooms.has(room);
  }
}

module.exports = new SocketService();
