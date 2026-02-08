/**
 * Receiver script
 * Purpose: simulate a logged-in user (User B) listening to real-time events
 * IMPORTANT: Uses ACCESS TOKEN only
 */

require("dotenv").config();
const { io } = require("socket.io-client");

// 1. USE A REAL, NON-EXPIRED ACCESS TOKEN
// Must be the SAME token that works with protected REST APIs
const ACCESS_TOKEN = require('fs').readFileSync('token.txt', 'utf-8');
// 2. Backend base URL (NOT /api, NOT /socket.io)
const SOCKET_URL = process.env.SOCKET_URL || "http://localhost:5001";

// 3. Conversation ID you want to listen to
const CONVERSATION_ID = "58e4d998-e4c6-4f5b-a42d-16fc4f8e424b";

const socket = io(SOCKET_URL, {
  auth: {
    token: ACCESS_TOKEN, //  NO "Bearer "
  },
  // transports: ["websocket"], // Let it negotiate
  reconnection: true,
});

// ---------------- CONNECTION ----------------
socket.on("connect", () => {
  console.log(" Receiver connected");
  console.log(" Socket ID:", socket.id);

  // Join conversation room
  socket.emit("joinConversation", CONVERSATION_ID);
  console.log(" Joined conversation:", CONVERSATION_ID);

  // [TEST] Join Group
  socket.emit("joinGroup", { groupId: CONVERSATION_ID });
  console.log(" [Group] Joined group:", CONVERSATION_ID);
});

// ---------------- ERRORS ----------------
socket.on("connect_error", (err) => {
  console.error(" Socket connection error:", err.message);
});

socket.on("error", (err) => {
  console.error(" Server Error:", err);
});

// ---------------- REAL-TIME EVENTS ----------------
socket.on("new_message", (msg) => {
  console.log(" NEW MESSAGE RECEIVED:");
  console.log(msg);
});

socket.on("messageDeleted", (data) => {
  console.log("🗑 MESSAGE DELETED:");
  console.log(data);
});

socket.on("notification", (data) => {
  console.log(" NOTIFICATION:");
  console.log(data);
});

// Track typing users: { [groupId]: Map<userId, username> }
const groupTypingUsers = {};

socket.on("isTyping", (data) => {
  if (data.isGroup) {
    if (!groupTypingUsers[data.conversationId]) {
      groupTypingUsers[data.conversationId] = new Map();
    }
    groupTypingUsers[data.conversationId].set(data.senderId, data.username);

    const users = Array.from(groupTypingUsers[data.conversationId].values());
    console.log(`\n⌨️  [Group ${data.conversationId}] TYPING INDICATOR:`);
    if (users.length === 1) {
      console.log(`   ${users[0]} is typing...`);
    } else {
      console.log(`   ${users.join(", ")} are typing...`);
    }
  } else {
    console.log(" USER TYPING (Single Chat): someone is typing...");
  }
});

socket.on("stoppedTyping", (data) => {
  if (data.isGroup) {
    if (groupTypingUsers[data.conversationId]) {
      groupTypingUsers[data.conversationId].delete(data.senderId);

      const users = Array.from(groupTypingUsers[data.conversationId].values());
      if (users.length > 0) {
        console.log(`\n⌨️  [Group ${data.conversationId}] TYPING INDICATOR:`);
        if (users.length === 1) {
          console.log(`   ${users[0]} is typing...`);
        } else {
          console.log(`   ${users.join(", ")} are typing...`);
        }
      } else {
        console.log(`\n⌨️  [Group ${data.conversationId}] Typing stopped (list empty)`);
      }
    }
  }
});

socket.on("userStatusChanged", (data) => {
  console.log(" USER STATUS:");
  console.log(data);
});

// ---------------- DISCONNECT ----------------
socket.on("disconnect", (reason) => {
  console.log(" Disconnected:", reason);
});

