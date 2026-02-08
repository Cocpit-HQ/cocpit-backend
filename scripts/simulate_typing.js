require('dotenv').config();
const { signAccessToken } = require('../src/utils/jwt');
// Match receiver.js syntax
const Client = require("socket.io-client");

const userId = '3606d096-be60-4ce7-948c-e5eef42cbbd2'; // Ankita
const groupId = '58e4d998-e4c6-4f5b-a42d-16fc4f8e424b';

// Generate Token
const token = signAccessToken({
    sub: userId,
    sid: 'test-session-typing-' + Date.now(),
    roles: ['Student']
});

const socket = Client("http://localhost:5001", {
    auth: { token },
    reconnection: false
});

socket.on("connect_error", (err) => {
    console.error("[Sender] Connection Error:", err.message);
});

socket.on("connect", () => {
    console.log(`[Sender] Connected as ${userId}`);

    // Join Group
    socket.emit("joinGroup", { groupId });
    console.log(`[Sender] Joined group ${groupId}`);

    // Start Typing
    setTimeout(() => {
        console.log("[Sender] Sending groupTyping...");
        socket.emit("groupTyping", { groupId });
    }, 1000);

    // Stop Typing
    setTimeout(() => {
        console.log("[Sender] Sending stopGroupTyping...");
        socket.emit("stopGroupTyping", { groupId });
    }, 5000);

    // Disconnect
    setTimeout(() => {
        console.log("[Sender] Disconnecting...");
        socket.disconnect();
    }, 7000);
});

socket.on("error", (err) => {
    console.error("[Sender] Error:", err);
});
