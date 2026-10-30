const pool = require("../db/pool");
const { getUserRoom, getConversationRoom, getStoryRoom, getOrgRoom, getPostRoom } = require("../utils/socketRooms");
const { isNotificationAllowed, isOrgNotificationAllowed } = require("../utils/notificationPermission");

class SocketService {
  constructor() {
    this.io = null;
    this.typingStore = new Map(); // userId -> Map(conversationId -> { timeoutId, timestamp })
  }

  init(io) {
    this.io = io;
  }

  /**
   * Check if a user is currently typing in a conversation
   * @param {string} userId
   * @param {string} conversationId
   * @returns {boolean}
   */
  isUserTyping(userId, conversationId) {
    const userTypingMap = this.typingStore.get(userId);
    return userTypingMap ? userTypingMap.has(conversationId) : false;
  }

  /**
   * Set a user's typing status in a conversation
   * @param {string} userId
   * @param {string} conversationId
   * @param {boolean} isTyping
   */
  setTyping(userId, conversationId, isTyping) {
    if (isTyping) {
      if (!this.typingStore.has(userId)) {
        this.typingStore.set(userId, new Map());
      }
      const userTypingMap = this.typingStore.get(userId);
      const existing = userTypingMap.get(conversationId);
      if (existing && existing.timeoutId) {
        clearTimeout(existing.timeoutId);
      }

      const timeoutId = setTimeout(() => {
        this.setTyping(userId, conversationId, false);
        // Graceful fallback to notify clients when auto-timeout fires
        const payload = {
          conversationId,
          senderId: userId
        };
        this.notifyConversation(conversationId, "stoppedTyping", payload);
        this.notifyParticipants(conversationId, "stoppedTyping", payload, userId);
      }, 10000); // 10 seconds auto-timeout

      userTypingMap.set(conversationId, { timeoutId, timestamp: Date.now() });
    } else {
      const userTypingMap = this.typingStore.get(userId);
      if (userTypingMap) {
        const existing = userTypingMap.get(conversationId);
        if (existing && existing.timeoutId) {
          clearTimeout(existing.timeoutId);
        }
        userTypingMap.delete(conversationId);
        if (userTypingMap.size === 0) {
          this.typingStore.delete(userId);
        }
      }
    }
  }

  /**
   * Clear all active typing states and timeouts for a user (e.g. on disconnect)
   * @param {string} userId
   */
  clearUserTyping(userId) {
    const userTypingMap = this.typingStore.get(userId);
    if (userTypingMap) {
      for (const [conversationId, entry] of userTypingMap.entries()) {
        if (entry.timeoutId) {
          clearTimeout(entry.timeoutId);
        }
        // Notify conversation participants immediately
        const payload = {
          conversationId,
          senderId: userId
        };
        this.notifyConversation(conversationId, "stoppedTyping", payload);
        this.notifyParticipants(conversationId, "stoppedTyping", payload, userId);
      }
      this.typingStore.delete(userId);
    }
  }

  /**
   * Notify all participants in their personal user rooms
   * @param {string} conversationId
   * @param {string} event
   * @param {object} payload
   * @param {string} senderId
   */
  async notifyParticipants(conversationId, event, payload, senderId) {
    try {
      const participants = await pool.query(
        `SELECT user_id, org_id 
         FROM conversation_participants 
         WHERE conversation_id = $1 AND left_at IS NULL`,
        [conversationId]
      );

      for (const row of participants.rows) {
        if (row.user_id) {
          if (row.user_id !== senderId) {
            this.notifyUser(row.user_id, event, payload);
          }
        } else if (row.org_id) {
          const members = await pool.query(
            `SELECT user_id 
             FROM organization_members 
             WHERE org_id = $1 AND status = 'ACTIVE'`,
            [row.org_id]
          );
          for (const member of members.rows) {
            if (member.user_id !== senderId) {
              this.notifyUser(member.user_id, event, payload);
            }
          }
        }
      }
    } catch (err) {
      console.error("Error notifying participants:", err);
    }
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
  async notifyUser(userId, event, payload) {
    if (!this.io) {
      this._warnUninitialized();
      return;
    }
    if (event === "notification") {
      try {
        const allowed = await isNotificationAllowed(userId, payload?.type);
        if (!allowed) return;
      } catch (err) {
        console.error("notifyUser permission check error:", err);
      }
    }
    const room = getUserRoom(userId);
    this.io.to(room).emit(event, payload);
  }

  async notifyUserScoped(userId, event, payload, actorScope = null) {
    if (!this.io) {
      this._warnUninitialized();
      return;
    }
    if (event === "notification") {
      try {
        const allowed = await isNotificationAllowed(userId, payload?.type);
        if (!allowed) return;
      } catch (err) {
        console.error("notifyUserScoped permission check error:", err);
      }
    }

    const room = getUserRoom(userId);
    const sockets = this.io.sockets.adapter.rooms.get(room) || new Set();

    for (const socketId of sockets) {
      const socket = this.io.sockets.sockets.get(socketId);
      if (!socket) continue;

      if (actorScope && socket.actorScope && socket.actorScope !== actorScope) {
        continue;
      }

      socket.emit(event, payload);
    }
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
   * Forcefully disconnect all active socket connections for a given user.
   * Useful when an admin suspends a user.
   * @param {string} userId
   * @returns {Promise<number>} Number of disconnected sockets
   */
  async disconnectUser(userId) {
    if (!this.io) {
      this._warnUninitialized();
      return 0;
    }
    const userRoom = getUserRoom(userId);
    const sockets = await this.io.in(userRoom).fetchSockets();
    let disconnectedCount = 0;
    sockets.forEach((socket) => {
      // Notify the frontend client so they can clear tokens and redirect to login
      socket.emit('auth:suspended');
      
      // Give the event 500ms to reach the client before severing the connection
      setTimeout(() => {
        socket.disconnect(true);
      }, 500);
      
      disconnectedCount += 1;
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

  notifyConversationScoped(conversationId, event, payload, actorScope = null) {
    if (!this.io) {
      this._warnUninitialized();
      return;
    }

    const room = getConversationRoom(conversationId);
    const sockets = this.io.sockets.adapter.rooms.get(room) || new Set();

    for (const socketId of sockets) {
      const socket = this.io.sockets.sockets.get(socketId);
      if (!socket) continue;

      if (actorScope && socket.actorScope && socket.actorScope !== actorScope) {
        continue;
      }

      socket.emit(event, payload);
    }
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
   * Notify all viewers of a specific post
   * @param {string} postId
   * @param {string} event
   * @param {object} payload
   */
  notifyPost(postId, event, payload) {
    if (!this.io) {
      this._warnUninitialized();
      return;
    }
    const room = getPostRoom(postId);
    this.io.to(room).emit(event, payload);
  }

  /**
   * Notify all members of an organization (via organization room)
   * @param {string} orgId
   * @param {string} event
   * @param {object} payload
   */
  async notifyOrg(orgId, event, payload) {
    if (!this.io) {
      this._warnUninitialized();
      return;
    }
    if (event === "notification") {
      try {
        const allowed = await isOrgNotificationAllowed(orgId, payload?.type);
        if (!allowed) return;
      } catch (err) {
        console.error("notifyOrg permission check error:", err);
      }
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

  /**
   * Broadcast an event to all connected clients globally
   * @param {string} event
   * @param {object} payload
   */
  broadcastGlobal(event, payload) {
    if (!this.io) {
      this._warnUninitialized();
      return;
    }
    this.io.emit(event, payload);
  }
}

module.exports = new SocketService();
