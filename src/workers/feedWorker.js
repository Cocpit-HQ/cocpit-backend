/**
 * feedWorker.js
 * COCPIT Feed Engine — Background Worker
 *
 * Sprint Task: Day 4 — Task B9 (B9.1 – B9.5)
 * Owner: Dev B
 * AI-Assisted: Yes (Antigravity)
 * Contracts read: contracts/redis-key-registry.md (FROZEN)
 * Last reviewed: 2026-05-27
 *
 * Responsibilities (runs every FEED_WORKER_INTERVAL_MS, default 5 min):
 *   B9.2 — Refresh exploration pool (feed:explore:pool Redis sorted set)
 *   B9.3 — Drain analytics event queue (feed:events:queue → feed_events DB table)
 *   B9.4 — Feed sessions: expire via Redis TTL (1800s) + per-read expiry check in
 *           feedSession.service.getSession(). No additional DB sweep required —
 *           there is no DB-backed feed session table.
 *
 * Configuration:
 *   FEED_WORKER_INTERVAL_MS  — Interval in ms between worker cycles. Default: 300000 (5 min).
 *
 * Wired into server startup via src/server.js.
 */

'use strict';

const { refreshExplorationPool } = require('../modules/feed/exploration/explorationPool');
const { processEventQueue }      = require('../modules/feed/analytics/feedAnalytics.service');
const pool                       = require('../core/db/pool');

// ─── Configuration ─────────────────────────────────────────────────────────────
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

let intervalId = null;

// ─── Worker Cycle ──────────────────────────────────────────────────────────────

/**
 * runFeedWorkerCycle
 *
 * Executes one full worker cycle. Each task is wrapped in its own try/catch so
 * a failure in one task never prevents the others from running.
 *
 * @returns {Promise<void>}
 */
async function runFeedWorkerCycle() {
  if (process.env.DEBUG_FEED === 'true') {
    console.log('[feedWorker] Cycle starting...');
  }

  // ── B9.2: Refresh exploration pool ──────────────────────────────────────────
  // Repopulates feed:explore:pool Redis sorted set from:
  //   - Global trending posts (last 7 days, high engagement)
  //   - New creator content (account < 30 days old)
  // TTL: 300s — per redis-key-registry.md (FROZEN)
  try {
    await refreshExplorationPool(pool);
    if (process.env.DEBUG_FEED === 'true') {
      console.log('[feedWorker] B9.2 ✓ Exploration pool refreshed');
    }
  } catch (err) {
    console.error('[feedWorker] B9.2 ✗ refreshExplorationPool failed:', err.message);
    // Non-fatal — feed continues serving from existing pool or returns [] on Redis miss
  }

  // ── B9.3: Process analytics event queue ─────────────────────────────────────
  // Drains up to 50 events from feed:events:queue (Redis List) and batch-inserts
  // them into the feed_events DB table. Complements the direct DB write in trackEvent().
  try {
    const processed = await processEventQueue(pool);
    if (processed > 0) {
      console.log(`[feedWorker] B9.3 ✓ processEventQueue: ${processed} event(s) written to DB`);
    } else if (process.env.DEBUG_FEED === 'true') {
      console.log('[feedWorker] B9.3 ✓ processEventQueue: queue empty');
    }
  } catch (err) {
    console.error('[feedWorker] B9.3 ✗ processEventQueue failed:', err.message);
    // Non-fatal — events remain in queue and will be retried next cycle
  }

  // ── B9.4: Session expiry ────────────────────────────────────────────────────
  // Feed sessions (feed:session:{userId}) expire automatically via Redis TTL of
  // 1800s. feedSession.service.getSession() also validates expires_at on every
  // read and cleans up stale sessions at that point. No DB-backed session table
  // exists, so no additional sweep is required here.
  if (process.env.DEBUG_FEED === 'true') {
    console.log('[feedWorker] B9.4 ✓ Session expiry: handled by Redis TTL (1800s) + on-read validation');
    console.log('[feedWorker] Cycle complete');
  }
}

// ─── Start / Stop ──────────────────────────────────────────────────────────────

/**
 * startFeedWorker
 *
 * Starts the feed background worker. Runs one cycle immediately on startup,
 * then repeats every FEED_WORKER_INTERVAL_MS milliseconds.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
function startFeedWorker() {
  if (intervalId) {
    console.warn('[feedWorker] Already running — ignoring duplicate startFeedWorker() call');
    return;
  }

  const intervalMs = parseInt(process.env.FEED_WORKER_INTERVAL_MS, 10);
  const resolvedInterval = (Number.isFinite(intervalMs) && intervalMs > 0)
    ? intervalMs
    : DEFAULT_INTERVAL_MS;

  console.log(`[feedWorker] Starting — interval: ${resolvedInterval}ms (${resolvedInterval / 1000}s)`);

  // Run one cycle immediately on startup (after a brief delay to allow DB + Redis to connect)
  setTimeout(runFeedWorkerCycle, 5000);

  // Schedule recurring cycles
  intervalId = setInterval(runFeedWorkerCycle, resolvedInterval);
}

/**
 * stopFeedWorker
 *
 * Stops the recurring worker. Used for graceful shutdown and testing.
 */
function stopFeedWorker() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('[feedWorker] Stopped');
  }
}

// ─── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  startFeedWorker,
  stopFeedWorker,
  runFeedWorkerCycle,   // exported for unit tests
};
