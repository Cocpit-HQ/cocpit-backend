const { getUserRoom, getConversationRoom, getStoryRoom, getOrgRoom } = require("../utils/socketRooms");

class SocketService {
  constructor() {
    this.io = null;
  }

  init(io) {
    this.io = io;
  }

  _warnUninitialized() {
    if (!this._hasWarned) {
      console.warn("SocketService: io not initialized. Some events may be dropped during startup.");
      this._hasWarned = true;
    }
  }

  /**
   * Notify a specific user
   * @param {string} userId
   * @param {string} event
   * @param {object} payload
   */
  notifyUser(userId, event, payload) {
    if (!this.io) {
      this._warnUninitialized();
      return;
    }
    const room = getUserRoom(userId);
    this.io.to(room).emit(event, payload);
  }

  /**
   * Disconnect sockets belonging to a specific user session.
   * @param {string} userId
   * @param {string} sessionId
   * @returns {Promise<number>} Number of disconnected sockets
   */
  async disconnectUserSession(userId, sessionId) {
    if (!this.io) {
      this._warnUninitialized();
      return 0;
    }

    const userRoom = getUserRoom(userId);
    const sockets = await this.io.in(userRoom).fetchSockets();
    let disconnectedCount = 0;

    sockets.forEach((socket) => {
      if (socket.sessionId === sessionId) {
        socket.disconnect(true);
        disconnectedCount += 1;
      }
    });

    return disconnectedCount;
  }

  /**
   * Force a user's sockets to leave a conversation room
   * @param {string} userId
   * @param {string} conversationId
   */
  leaveConversation(userId, conversationId) {
    if (!this.io) {
      this._warnUninitialized();
      return;
    }
    const userRoom = getUserRoom(userId);
    const conversationRoom = getConversationRoom(conversationId);
    // This forces all sockets in the user's personal room to leave the conversation room
    this.io.in(userRoom).socketsLeave(conversationRoom);
  }

  /**
   * Notify all participants in a conversation
   * @param {string} conversationId
   * @param {string} event
   * @param {object} payload
   */
  notifyConversation(conversationId, event, payload) {
    if (!this.io) {
      this._warnUninitialized();
      return;
    }
    const room = getConversationRoom(conversationId);
    this.io.to(room).emit(event, payload);
  }

  /**
   * Notify all viewers of a specific story
   * @param {string} storyId
   * @param {string} event
   * @param {object} payload
   */
  notifyStory(storyId, event, payload) {
    if (!this.io) {
      this._warnUninitialized();
      return;
    }
    const room = getStoryRoom(storyId);
    this.io.to(room).emit(event, payload);
  }

  /**
   * Notify all members of an organization (via organization room)
   * @param {string} orgId
   * @param {string} event
   * @param {object} payload
   */
  notifyOrg(orgId, event, payload) {
    if (!this.io) {
      this._warnUninitialized();
      return;
    }
    const room = getOrgRoom(orgId);
    this.io.to(room).emit(event, payload);
  }

  notifyCompany(companyId, event, payload) {
    return this.notifyOrg(companyId, event, payload);
  }

  /**
   * Broadcast status change to a list of related users (friends/followers)
   * @param {string} userId - The user whose status changed
   * @param {string} status - 'online' or 'offline'
   * @param {Array<string>} relatedUserIds - List of user IDs to notify
   */
  broadcastStatus(userId, status, relatedUserIds) {
    if (!this.io) {
      this._warnUninitialized();
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
    if (!this.io) {
      this._warnUninitialized();
      return false;
    }
    const room = getUserRoom(userId);
    // io.sockets.adapter.rooms is a Map where key is room name and value is Set of socket IDs
    return this.io.sockets.adapter.rooms.has(room);
  }
}

module.exports = new SocketService();
