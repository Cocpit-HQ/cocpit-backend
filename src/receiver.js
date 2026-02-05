/**
 * Receiver script
 * Purpose: simulate a logged-in user (User B) listening to real-time events
 * IMPORTANT: Uses ACCESS TOKEN only
 */

require("dotenv").config();
const { io } = require("socket.io-client");

// 1. USE A REAL, NON-EXPIRED ACCESS TOKEN
// Must be the SAME token that works with protected REST APIs
const ACCESS_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI1YmM1NjU4MS01NThlLTRjNmItYTBmMy0wMWYyNjM4YjNlZWYiLCJzaWQiOiIzMDg3NDZlMC1jNWM5LTQ1MmQtOWU2Zi04NzA0NzQ5Y2JjZTkiLCJyb2xlcyI6WyJBZG1pbiJdLCJpYXQiOjE3NjgxMjY4OTcsImV4cCI6MTc2ODEyNzc5N30.zGjl1ZsdR4QeEqVwC_ecPAcN79tkfevXStP5QUEC4tE"
// 2. Backend base URL (NOT /api, NOT /socket.io)
const SOCKET_URL = "http://192.168.1.6:5000";

// 3. Conversation ID you want to listen to
const CONVERSATION_ID = "58e4d998-e4c6-4f5b-a42d-16fc4f8e424b";

const socket = io(SOCKET_URL, {
  auth: {
    token: ACCESS_TOKEN, //  NO "Bearer "
  },
  transports: ["websocket"],
  reconnection: true,
});

// ---------------- CONNECTION ----------------
socket.on("connect", () => {
  console.log(" Receiver connected");
  console.log(" Socket ID:", socket.id);

  // Join conversation room
  socket.emit("joinConversation", CONVERSATION_ID);
  console.log(" Joined conversation:", CONVERSATION_ID);
});

// ---------------- ERRORS ----------------
socket.on("connect_error", (err) => {
  console.error(" Socket connection error:", err.message);
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

socket.on("isTyping", (data) => {
  console.log(" USER TYPING:");
  console.log(data);
});

socket.on("userStatusChanged", (data) => {
  console.log(" USER STATUS:");
  console.log(data);
});

// ---------------- DISCONNECT ----------------
socket.on("disconnect", (reason) => {
  console.log(" Disconnected:", reason);
});
