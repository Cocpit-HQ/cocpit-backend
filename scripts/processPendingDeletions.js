/**
 * processPendingDeletions.js
 * ─────────────────────────
 * Standalone worker script: permanently deletes accounts whose 14-day recovery
 * window has expired. Should be run daily by Windows Task Scheduler (or OS cron).
 *
 * Usage:
 *   node scripts/processPendingDeletions.js
 *
 * Task Scheduler setup (Windows):
 *   Program:  node
 *   Args:     C:\path\to\cocpit-backend\scripts\processPendingDeletions.js
 *   Trigger:  Daily at 02:00 AM
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const pool = require('../src/core/db/pool');

// Optional: Redis lock to guard against concurrent runs (e.g., double-fire from Task Scheduler)
let redisClient;
try {
    redisClient = require('../src/core/db/redis');
} catch {
    redisClient = null;
}

const LOCK_KEY = 'deletion_job_lock';
const LOCK_TTL = 60 * 5; // 5 minutes — longer than the script should ever take

async function acquireLock() {
    if (!redisClient?.isOpen) return true; // If Redis is unavailable, proceed without locking
    const acquired = await redisClient.set(LOCK_KEY, '1', { NX: true, EX: LOCK_TTL });
    return acquired === 'OK';
}

async function releaseLock() {
    if (!redisClient?.isOpen) return;
    await redisClient.del(LOCK_KEY);
}

async function run() {
    console.log(`[${new Date().toISOString()}] Starting pending deletion job...`);

    const locked = await acquireLock();
    if (!locked) {
        console.log('Another instance is already running. Exiting.');
        process.exit(0);
    }

    let client;
    let processed = 0;
    let failed = 0;

    try {
        // Fetch all accounts whose deletion window has passed
        const result = await pool.query(`
            SELECT user_id, email, full_name
            FROM users
            WHERE deletion_execute_at IS NOT NULL
              AND deletion_execute_at <= NOW()
        `);

        console.log(`Found ${result.rows.length} account(s) to permanently delete.`);

        for (const user of result.rows) {
            client = await pool.connect();
            try {
                await client.query('BEGIN');

                // Hard delete — ON DELETE CASCADE handles all related data:
                // profiles, posts, comments, connections, notifications,
                // refresh_tokens, account_restoration_tokens, etc.
                await client.query('DELETE FROM users WHERE user_id = $1', [user.user_id]);

                await client.query('COMMIT');
                console.log(`✅ Deleted: ${user.user_id} (${user.email})`);
                processed++;
            } catch (err) {
                await client.query('ROLLBACK');
                console.error(`❌ Failed to delete ${user.user_id} (${user.email}):`, err.message);
                failed++;
            } finally {
                client.release();
                client = null;
            }
        }
    } catch (err) {
        console.error('Fatal error during deletion job:', err);
    } finally {
        await releaseLock();
        console.log(`\nJob complete. Processed: ${processed}, Failed: ${failed}`);
        process.exit(failed > 0 ? 1 : 0);
    }
}

run();
