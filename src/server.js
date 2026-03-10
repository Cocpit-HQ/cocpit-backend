require("dotenv").config();
require("newrelic");
const express = require("express");

// Server Entry Point
const app = require("./app");
const http = require("http");
const { initSocket } = require("./utils/socket");
const { startSessionTimeoutWorker } = require("./workers/sessionTimeoutWorker");
const { processJobExpirations } = require("./workers/jobExpiryWorker");
const { processEventOutbox } = require("./workers/eventOutboxWorker");
const { processStoryExpirations } = require("./workers/storyExpiryWorker");
const server = http.createServer(app);

const PORT = process.env.PORT || 5000;

if (process.env.NEW_RELIC_LICENSE_KEY) {
  console.log("✅ New Relic monitoring connected");
} else {
  console.log("❌ New Relic license key missing");
}

// Redundant app.set("trust proxy", true) removed to prevent overwriting app.js settings
initSocket(server);
startSessionTimeoutWorker();

// Start simple job expiry worker (Every 15 minutes)
setInterval(() => {
  processJobExpirations();
}, 15 * 60 * 1000);

// Start story expiry & cleanup worker (Every 15 minutes)
setInterval(() => {
  processStoryExpirations();
}, 15 * 60 * 1000);

// Start Event Outbox Processor (Every 5 seconds)
setInterval(() => {
  processEventOutbox();
}, 5 * 1000);

server.listen(PORT, '0.0.0.0', () => {
  console.log('Server running on port ' + PORT);
});

console.log("CICD Deployment Successful - Version 1.0.1");