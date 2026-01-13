// This file is kept for backward compatibility with src/server.js import
// It delegates logic to src/sockets/index.js

const { initSocket } = require("../sockets/index");

module.exports.initSocket = initSocket;

// getIO is removed as it's deprecated. Controllers should use SocketService.
