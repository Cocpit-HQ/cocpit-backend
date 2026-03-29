const pool = require("../core/db/pool");
const redisClient = require("../core/db/redis");

/**
 * Increment the user's affinity score for the specified hashtags.
 * Handles the Redis ZSET storage, and defers a database UPSERT.
 * 
 * @param {string} userId UUID of the user
 * @param {number} weight Point weight (e.g. +1 like, +2 comment, +3 post, +5 skill)
 * @param {Array<string>} [tags] Optional array of clean tags (no #). Used for skills.
 * @param {string} [postId] Optional postId. Will fetch tags associated with post if 'tags' is omitted.
 * @param {number} [retryCount=0] Internal retry mechanism state
 */
const incrementUserHashtagScore = async (userId, weight, tags = null, postId = null, retryCount = 0) => {
    if (!userId || weight === 0) return;

    try {
        let finalTags = tags || [];

        // 1. Resolve tags via Post ID if not provided directly
        if (finalTags.length === 0 && postId) {
            const { rows } = await pool.query(`
                SELECT h.tag, h.hashtag_id
                FROM post_hashtags ph
                JOIN hashtags h ON h.hashtag_id = ph.hashtag_id
                WHERE ph.post_id = $1
            `, [postId]);

            finalTags = rows;
        } else if (finalTags.length > 0) {
            // If provided as strings, map them or lookup IDs if needed for DB.
            // For DB UPSERT, we need hashtag_ids. 
            const { rows } = await pool.query(`
                SELECT tag, hashtag_id FROM hashtags WHERE tag = ANY($1)
            `, [finalTags]);
            finalTags = rows;
        }

        if (finalTags.length === 0) return; // No tags to increment

        // 2. Perform Ops
        for (const tg of finalTags) {
            const { tag, hashtag_id } = tg;
            
            // A. Fast Redis ZSET update
            if (redisClient.isOpen) {
                const zsetKey = `user:${userId}:interests`;
                await redisClient.zIncrBy(zsetKey, weight, tag);
                
                // Keep the ZSET constrained to top 100 to prevent explosion (Score bounded memory)
                // Removes everything starting from lowest rank up to the 100th-from-top.
                // Syntax: start 0, end -101 (meaning rank up to the element before the top 100).
                await redisClient.zRemRangeByRank(zsetKey, 0, -101);
            }

            // B. Permanent Datastore UPSERT
            await pool.query(`
                INSERT INTO user_hashtag_scores (user_id, hashtag_id, score, last_updated)
                VALUES ($1, $2, $3, NOW())
                ON CONFLICT (user_id, hashtag_id)
                DO UPDATE SET score = user_hashtag_scores.score + EXCLUDED.score, last_updated = NOW()
            `, [userId, hashtag_id, weight]);
        }

    } catch (err) {
        if (retryCount === 0) {
            console.warn(`[Recommendation] Failed to increment score. Scheduling 1 retry.`, err.message);
            // Non-blocking 5 second retry loop
            setTimeout(() => {
                incrementUserHashtagScore(userId, weight, tags, postId, 1).catch(() => {
                    console.error(`[Recommendation] Score increment fully failed for User ${userId}.`);
                });
            }, 5000);
        } else {
            throw err;
        }
    }
};

module.exports = {
    incrementUserHashtagScore
};
