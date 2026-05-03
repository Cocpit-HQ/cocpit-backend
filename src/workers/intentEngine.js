const pool = require("../core/db/pool");
const redisClient = require("../core/db/redis");

const WEIGHTS = {
  // Jobs
  apply_job: { job_seeker_score: 10 },
  view_job: { job_seeker_score: 2 },
  save_job: { job_seeker_score: 5 },
  share_job: { job_seeker_score: 3 },

  // Posts
  create_post: { creator_score: 8 },
  share_post: { creator_score: 4 },
  save_post: { creator_score: 4 },
  comment_post: { creator_score: 3 },
  like_post: { creator_score: 1 },
  view_post: { creator_score: 1 },

  // Events
  register_event: { event_score: 5 },
  view_event: { event_score: 2 },
};

/**
 * Helper to get the last processed timestamp (Redis -> DB -> Default)
 */
const getCursor = async (client) => {
    const cursorKey = "worker:intentEngine:last_processed_at";
    
    // 1. Try Redis
    if (redisClient.isOpen) {
        try {
            const val = await redisClient.get(cursorKey);
            if (val) return val;
        } catch (e) {
            console.warn("[IntentEngine] Redis get failed, trying DB...");
        }
    }

    // 2. Try DB
    try {
        const res = await client.query('SELECT value FROM system_checkpoints WHERE key = $1', [cursorKey]);
        if (res.rowCount > 0) return res.rows[0].value;
    } catch (e) {
        console.warn("[IntentEngine] DB cursor get failed.");
    }

    // 3. Fallback to 1 hour ago
    return new Date(Date.now() - 60 * 60 * 1000).toISOString();
};

/**
 * Helper to set the last processed timestamp (Redis & DB)
 */
const setCursor = async (client, value) => {
    const cursorKey = "worker:intentEngine:last_processed_at";

    // 1. Try Redis
    if (redisClient.isOpen) {
        try {
            await redisClient.set(cursorKey, value);
        } catch (e) {
            console.warn("[IntentEngine] Redis set failed.");
        }
    }

    // 2. Try DB
    try {
        await client.query(`
            INSERT INTO system_checkpoints (key, value, updated_at)
            VALUES ($1, $2, NOW())
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
        `, [cursorKey, value]);
    } catch (e) {
        console.warn("[IntentEngine] DB cursor set failed.");
    }
};

/**
 * Sweeps the user_activities for unprocessed actions.
 * Updates the user_intent_scores based on strict weights.
 */
const sweepActivityLogs = async () => {
    let client;
    try {
        client = await pool.connect();

        const lastProcessedAt = await getCursor(client);
        
        // Grab records created AFTER the last processed timestamp (Timezone safe comparison)
        const pendingRes = await client.query(`
            SELECT id, user_id, action, created_at 
            FROM user_activities 
            WHERE created_at > $1::timestamptz
            ORDER BY created_at ASC
            LIMIT 1000
        `, [lastProcessedAt]);

        if (pendingRes.rowCount > 0) {
            const userScoreUpdates = {};
            let maxTimestamp = lastProcessedAt;

            for (const row of pendingRes.rows) {
                // Keep track of the newest timestamp
                if (new Date(row.created_at) > new Date(maxTimestamp)) {
                    maxTimestamp = new Date(row.created_at).toISOString();
                }

                const weightMapping = WEIGHTS[row.action];
                
                if (weightMapping) {
                    if (!userScoreUpdates[row.user_id]) userScoreUpdates[row.user_id] = {};
                    
                    for (const [key, value] of Object.entries(weightMapping)) {
                        userScoreUpdates[row.user_id][key] = (userScoreUpdates[row.user_id][key] || 0) + value;
                    }
                }
            }

            // Perform UPSERTS
            for (const [userId, scoreUpdates] of Object.entries(userScoreUpdates)) {
                const incJob = scoreUpdates.job_seeker_score || 0;
                const incCre = scoreUpdates.creator_score || 0;
                const incEvt = scoreUpdates.event_score || 0;

                await client.query(`
                    INSERT INTO user_intent_scores (user_id, job_seeker_score, creator_score, event_score, updated_at)
                    VALUES ($1, $2, $3, $4, NOW())
                    ON CONFLICT (user_id) DO UPDATE SET 
                        job_seeker_score = user_intent_scores.job_seeker_score + EXCLUDED.job_seeker_score,
                        creator_score = user_intent_scores.creator_score + EXCLUDED.creator_score,
                        event_score = user_intent_scores.event_score + EXCLUDED.event_score,
                        updated_at = NOW()
                `, [userId, incJob, incCre, incEvt]);
            }

            // Save the highest timestamp
            await setCursor(client, maxTimestamp);
        }

    } catch (err) {
        console.error("[IntentEngine] Sweep failed:", err);
    } finally {
        if (client) client.release();
    }
};

/**
 * Runs a daily decay algorithm to slightly decay all intent scores.
 */
const runDailyDecay = async () => {
    try {
        console.log("[IntentEngine] Running daily decay (-5) on intent scores...");
        await pool.query(`
            UPDATE user_intent_scores
            SET 
                job_seeker_score = GREATEST(job_seeker_score - 1, 0),
                creator_score = GREATEST(creator_score - 1, 0),
                event_score = GREATEST(event_score - 1, 0),
                updated_at = NOW()
            WHERE job_seeker_score > 0 OR creator_score > 0 OR event_score > 0
        `);
    } catch (err) {
        console.error("[IntentEngine] Daily decay failed:", err);
    }
};

module.exports = {
    sweepActivityLogs,
    runDailyDecay
};
