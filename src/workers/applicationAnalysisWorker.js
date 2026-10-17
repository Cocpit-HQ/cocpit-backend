"use strict";

const pool = require("../core/db/pool");
const { analyzeCandidate } = require("../services/candidateAnalysis.service");
const { sleep } = require("../core/ai/helpers");

const WORKER_POLL_INTERVAL_MS = parseInt(process.env.AI_WORKER_POLL_INTERVAL_MS || "5000", 10);
const MAX_QUEUE_RETRIES = parseInt(process.env.AI_WORKER_MAX_RETRIES || "3", 10);

/**
 * Picks the highest priority job from the queue that is PENDING.
 * Priority 3 (Manual), Priority 2 (Tier 1), Priority 1 (Tier 2).
 * Uses FOR UPDATE SKIP LOCKED to prevent concurrent workers from picking the same job.
 */
const pickJob = async (client) => {
  const res = await client.query(`
    SELECT queue_id, application_id, retry_count
    FROM ai_analysis_queue
    WHERE status = 'PENDING'
    ORDER BY priority DESC, created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  `);
  return res.rows[0];
};

/**
 * Reclaims jobs that have been stuck in 'PROCESSING' for over 10 minutes.
 * This recovers jobs from worker crashes.
 */
const reclaimStuckJobs = async () => {
  try {
    const res = await pool.query(`
      UPDATE ai_analysis_queue
      SET status = 'PENDING',
          retry_count = retry_count + 1,
          updated_at = NOW()
      WHERE status = 'PROCESSING'
        AND updated_at < NOW() - INTERVAL '10 minutes'
        AND retry_count < $1
    `, [MAX_QUEUE_RETRIES]);
    
    if (res.rowCount > 0) {
      console.log(`[AI Worker] ♻️ Reclaimed ${res.rowCount} stuck jobs (stuck in PROCESSING > 10m).`);
    }

    const failRes = await pool.query(`
      UPDATE ai_analysis_queue
      SET status = 'FAILED',
          error_message = 'Max retries reached after worker crash recovery',
          updated_at = NOW()
      WHERE status = 'PROCESSING'
        AND updated_at < NOW() - INTERVAL '10 minutes'
        AND retry_count >= $1
    `, [MAX_QUEUE_RETRIES]);
    
    if (failRes.rowCount > 0) {
      console.log(`[AI Worker] 💀 Failed ${failRes.rowCount} hopelessly stuck jobs.`);
    }
  } catch (err) {
    console.error("[AI Worker] Reaper failed:", err);
  }
};

/**
 * Processes a single job from the queue.
 */
const processNextJob = async () => {
  const client = await pool.connect();
  let queueId = null;

  try {
    await client.query("BEGIN");

    const job = await pickJob(client);
    if (!job) {
      await client.query("ROLLBACK");
      return false; // No jobs to process
    }

    queueId = job.queue_id;
    const applicationId = job.application_id;

    // Mark as PROCESSING
    await client.query(
      `UPDATE ai_analysis_queue SET status = 'PROCESSING', updated_at = NOW() WHERE queue_id = $1`,
      [queueId]
    );
    await client.query("COMMIT"); // Commit so other workers see it as PROCESSING

    console.log(`[AI Worker] Processing application_id: ${applicationId} (queue_id: ${queueId})`);

    try {
      // Execute the analysis
      await analyzeCandidate(applicationId);

      // Mark as COMPLETED
      await client.query(
        `UPDATE ai_analysis_queue SET status = 'COMPLETED', error_message = NULL, updated_at = NOW() WHERE queue_id = $1`,
        [queueId]
      );
      console.log(`[AI Worker] ✅ Completed application_id: ${applicationId}`);
    } catch (err) {
      console.error(`[AI Worker] ❌ Error processing application_id: ${applicationId}`, err.message);

      const newRetryCount = job.retry_count + 1;
      if (newRetryCount >= MAX_QUEUE_RETRIES) {
        // Mark as FAILED
        await client.query(
          `UPDATE ai_analysis_queue SET status = 'FAILED', error_message = $1, retry_count = $2, updated_at = NOW() WHERE queue_id = $3`,
          [err.message.substring(0, 500), newRetryCount, queueId]
        );
        console.log(`[AI Worker] 💀 Max retries reached. Marked as FAILED.`);
      } else {
        // Keep as PENDING with backoff (in a real system, you'd use a next_run_at timestamp for backoff)
        // For simplicity here, we just increment retry count and push it back to PENDING.
        await client.query(
          `UPDATE ai_analysis_queue SET status = 'PENDING', error_message = $1, retry_count = $2, updated_at = NOW() WHERE queue_id = $3`,
          [err.message.substring(0, 500), newRetryCount, queueId]
        );
        console.log(`[AI Worker] ⚠️ Retrying later. Attempt ${newRetryCount}/${MAX_QUEUE_RETRIES}`);
      }
    }
  } catch (err) {
    console.error("[AI Worker] Fatal error in job processor:", err);
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }

  return true; // Job was processed (successfully or not)
};

/**
 * Main worker loop.
 */
const startWorker = async () => {
  console.log(`[AI Worker] Started. Polling every ${WORKER_POLL_INTERVAL_MS}ms.`);
  let isRunning = true;

  process.on('SIGINT', () => { isRunning = false; console.log("[AI Worker] Shutting down..."); });
  process.on('SIGTERM', () => { isRunning = false; console.log("[AI Worker] Shutting down..."); });

  while (isRunning) {
    try {
      await reclaimStuckJobs();

      const processed = await processNextJob();
      if (!processed) {
        // If no jobs, sleep for the poll interval
        await sleep(WORKER_POLL_INTERVAL_MS);
      } else {
        // If a job was processed, sleep a tiny bit to avoid CPU thrashing but process the queue quickly
        await sleep(500);
      }
    } catch (err) {
      console.error("[AI Worker] Loop error:", err);
      await sleep(WORKER_POLL_INTERVAL_MS);
    }
  }
};

module.exports = {
  startWorker,
  processNextJob
};
