const pool = require("../core/db/pool");
const redisClient = require("../core/db/redis");
const { incrementUserHashtagScore } = require("../services/recommendation.service");

/**
 * Worker to process the outbox pattern.
 * Handles Event Idempotency and Exponential Backoffs.
 */
const processEventOutbox = async () => {
    let client;
    try {
        try {
            client = await pool.connect();
            // Handle connection reset/errors while client is in use
            client.once('error', (err) => {
                console.error("[EventOutboxWorker] Unexpected client error:", err.message);
            });
        } catch (connErr) {
            console.warn("[EventOutboxWorker] Database connection unavailable. Skipping sweep.");
            return;
        }
        
        await client.query("BEGIN");

        const pendingRes = await client.query(`
            SELECT event_id, topic, payload, retry_count 
            FROM event_outbox
            WHERE status = 'PENDING' 
              AND (next_retry_at IS NULL OR next_retry_at <= NOW())
            ORDER BY created_at ASC
            LIMIT 50
            FOR UPDATE SKIP LOCKED
        `);

        if (pendingRes.rowCount > 0) {
            for (const event of pendingRes.rows) {
                try {
                    if (event.topic === 'POST_CREATED' || event.topic === 'POST_UPDATED') {
                        await processHashtags(client, event.topic, event.payload.post_id);
                    }

                    // Mark as processed
                    await client.query(
                        `UPDATE event_outbox SET status = 'PROCESSED', processed_at = NOW() WHERE event_id = $1`,
                        [event.event_id]
                    );

                } catch (emitError) {
                    console.error(`[EventOutboxWorker] Failed to process event ${event.event_id}:`, emitError);
                    
                    const newRetryCount = (event.retry_count || 0) + 1;
                    if (newRetryCount >= 3) {
                        await client.query(
                            `UPDATE event_outbox SET status = 'FAILED', processed_at = NOW() WHERE event_id = $1`,
                            [event.event_id]
                        );
                    } else {
                        // Exponential backoff: 2 mins, 4 mins, 8 mins
                        const delayMins = Math.pow(2, newRetryCount);
                        await client.query(
                            `UPDATE event_outbox SET retry_count = $1, next_retry_at = NOW() + interval '$2 minutes' WHERE event_id = $3`,
                            [newRetryCount, delayMins, event.event_id]
                        );
                    }
                }
            }
        }

        await client.query("COMMIT");
    } catch (err) {
        if (client) {
            try { await client.query("ROLLBACK"); } catch (e) { }
        }
    } finally {
        if (client) client.release();
    }
};

/**
 * Extracts hashtags from a post and rebuilds its tag mapping.
 */
const processHashtags = async (client, topic, postId) => {
    if (!postId) return;

    // 1. Fetch Post Content and Author
    const postRes = await client.query(`SELECT content, author_id FROM posts WHERE post_id = $1 AND is_removed IS NOT TRUE`, [postId]);
    if (postRes.rowCount === 0) return;
    
    const content = postRes.rows[0].content || "";
    const authorId = postRes.rows[0].author_id;

    // 2. Extract specific matches (# followed by alphanumeric)
    const rawMatches = content.match(/#[a-zA-Z0-9_]+/g) || [];
    
    // Normalize: Lowercase, remove #, filter length rules
    const tagSet = new Set();
    rawMatches.forEach(tag => {
        const clean = tag.toLowerCase().substring(1);
        if (clean.length >= 2 && clean.length <= 30) {
            tagSet.add(clean);
        }
    });
    
    const uniqueTags = Array.from(tagSet);

    // 3. Clear existing mappings (Rebuild Strategy for POST_UPDATED)
    if (topic === 'POST_UPDATED') {
        await client.query(`DELETE FROM post_hashtags WHERE post_id = $1`, [postId]);
    }

    if (uniqueTags.length === 0) return;

    // 4. Upsert Hashtags
    for (const tag of uniqueTags) {
        // Safe UPSERT (Increment count if it exists)
        const hashtagRes = await client.query(`
            INSERT INTO hashtags (tag, usage_count) 
            VALUES ($1, 1)
            ON CONFLICT (lower(tag)) 
            DO UPDATE SET usage_count = hashtags.usage_count + 1
            RETURNING hashtag_id
        `, [tag]);
        
        const hashtagId = hashtagRes.rows[0].hashtag_id;

        // Ensure Relationship is Bound
        await client.query(`
            INSERT INTO post_hashtags (post_id, hashtag_id)
            VALUES ($1, $2)
            ON CONFLICT (post_id, hashtag_id) DO NOTHING
        `, [postId, hashtagId]);

        // Redis cache invalidation & trending scoring
        if (redisClient.isOpen) {
            // Delete legacy feed cache so it rebuilds on next hit (for search)
            await redisClient.del(`feed:hashtag:${tag}`);
            
            // Discovery Cache: LPUSH current post to recent tag feed (top 100 recent)
            if (topic === 'POST_CREATED') {
                await redisClient.lPush(`feed:hashtag:${tag}`, postId);
                await redisClient.lTrim(`feed:hashtag:${tag}`, 0, 99);
            }
            
            // Add engagement-weighted trending score (default +1 for standard posts)
            await redisClient.zIncrBy("trending_hashtags", 1, tag);
        }
    }

    if (topic === 'POST_CREATED') {
        incrementUserHashtagScore(authorId, 3, uniqueTags, null).catch(console.error);
    }
};

module.exports = {
    processEventOutbox
};
