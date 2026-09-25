const path = require('path');
require("dotenv").config({ path: path.resolve(__dirname, '../.env') });
require("newrelic");
const express = require("express");

// Server Entry Point
const app = require("./app");

// Health check endpoint for Gateway
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'main-api' });
});

const http = require("http");
const { initSocket } = require("./utils/socket");
const { processJobExpirations } = require("./workers/jobExpiryWorker");
const { processEventOutbox } = require("./workers/eventOutboxWorker");
const { processStoryExpirations } = require("./workers/storyExpiryWorker");
const { sweepActivityLogs, runDailyDecay } = require("./workers/intentEngine");
const { startFeedWorker } = require("./workers/feedWorker");
const { processAnalyticsAggregations } = require("./workers/analytics.cron");
const { processProfileNudges } = require("./workers/profileNudge.cron");
const { processUnreadMessagesNudges } = require("./workers/unreadMessages.cron");
const { processOfferExpiryNudges } = require("./workers/jobOfferExpiry.cron");
const server = http.createServer(app);

// Configure high timeouts (10 minutes) for streaming large video uploads to Cloudinary
server.timeout = 600000;
server.headersTimeout = 601000;
server.requestTimeout = 600000;

const PORT = process.env.PORT || 5000;

if (process.env.NEW_RELIC_LICENSE_KEY) {
  console.log("✅ New Relic monitoring connected");
} else {
  console.log("❌ New Relic license key missing");
}

// Redundant app.set("trust proxy", true) removed to prevent overwriting app.js settings
// Initialize Socket.IO (backgrounded to avoid hanging on Redis connect)
initSocket(server);

// Initialize Redis Subscriber and Feature Flags
require('./core/cache/redisSubscriber');
require('./modules/config/featureFlags.service').initFlagsFromRedis();

// startSessionTimeoutWorker();

// Start simple job expiry worker (Every 15 minutes)
setInterval(() => {
  processJobExpirations();
}, 15 * 60 * 1000);

// Start story expiry & cleanup worker (Every 15 minutes)
setInterval(() => {
  processStoryExpirations();
}, 15 * 60 * 1000);

// Start Intent Layer Sweep (Every 5 minutes)
setInterval(() => {
  sweepActivityLogs();
}, 5 * 60 * 1000);

// Start Intent Layer Daily Decay (Every 24 hours)
setInterval(() => {
  runDailyDecay();
}, 24 * 60 * 60 * 1000);

// Start Profile Incomplete Nudge Worker (Every 1 day)
processProfileNudges(); // Run immediately on boot
setInterval(() => {
  processProfileNudges();
}, 24 * 60 * 60 * 1000);

// Start Unread Messages Nudge Worker (Every 1 day)
processUnreadMessagesNudges(); // Run immediately on boot
setInterval(() => {
  processUnreadMessagesNudges();
}, 24 * 60 * 60 * 1000);

// Start Job Offer Expiry Worker (Every 1 day)
processOfferExpiryNudges(); // Run immediately on boot
setInterval(() => {
  processOfferExpiryNudges();
}, 24 * 60 * 60 * 1000);

// Analytics Aggregation Cron — runs every 10 seconds
const ANALYTICS_CRON_INTERVAL = 60 * 60 * 1000; // 1 hour
// const ANALYTICS_CRON_INTERVAL = 10 * 1000; // 10 seconds

processAnalyticsAggregations(); // run once immediately on startup
setInterval(() => {
  processAnalyticsAggregations().catch(err => console.error("[AnalyticsCron] Error:", err));
}, ANALYTICS_CRON_INTERVAL);

// B9.5 — Feed background worker (exploration pool refresh + analytics queue drain)
// Interval configurable via FEED_WORKER_INTERVAL_MS (default: 5 minutes)
startFeedWorker();

// B9.6 — AI Analysis background worker
const { startWorker: startAiAnalysisWorker } = require("./workers/applicationAnalysisWorker");
startAiAnalysisWorker().catch(e => console.error("AI Worker crashed:", e));


// Event Outbox Processor disabled

server.listen(PORT, () => {
  console.log('[Main API] Server running on port ' + PORT);
});

console.log("CICD Deployment Successful - Version 1.0.1");

// Graceful Shutdown
const pool = require('./core/db/pool');
const gracefulShutdown = () => {
  console.log('\n[Main API] Shutting down gracefully...');
  server.close(async () => {
    console.log('[Main API] Closed out remaining HTTP connections.');
    try {
      if (pool) {
        if (pool.stopHealthCheck) pool.stopHealthCheck();
        await pool.end();
        console.log('[Main API] Database pool closed.');
      }
    } catch (err) {
      console.error('[Main API] Error closing DB pool:', err);
    }
    process.exit(0);
  });
};

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
// Trigger nodemon restart
