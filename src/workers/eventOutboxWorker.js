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
            console.log(`[EventOutboxWorker] Found ${pendingRes.rowCount} pending events.`);
            for (const event of pendingRes.rows) {
                try {
                    console.log(`[EventOutboxWorker] Processing event ${event.event_id} (${event.topic})...`);
                    let payload = event.payload;
                    if (typeof payload === 'string') {
                        payload = JSON.parse(payload);
                    }

                    if (event.topic === 'POST_CREATED' || event.topic === 'POST_UPDATED') {
                        await processHashtags(client, event.topic, payload.post_id);
                    }

                    await client.query(
                        `UPDATE event_outbox SET status = 'PROCESSED', processed_at = NOW() WHERE event_id = $1`,
                        [event.event_id]
                    );
                    console.log(`[EventOutboxWorker] Event ${event.event_id} PROCESSED.`);

                } catch (emitError) {
                    console.error(`[EventOutboxWorker] Failed to process event ${event.event_id}:`, emitError);
                    
                    const newRetryCount = (event.retry_count || 0) + 1;
                    if (newRetryCount >= 3) {
                        await client.query(
                            `UPDATE event_outbox SET status = 'FAILED', processed_at = NOW() WHERE event_id = $1`,
                            [event.event_id]
                        );
                    } else {
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
        console.error("[EventOutboxWorker] FATAL LOOP ERROR:", err);
        if (client) {
            try { await client.query("ROLLBACK"); } catch (e) { }
        }
    } finally {
        if (client) client.release();
    }
};

/**
 * Recalculates usage_count and posts_count for the given hashtag IDs based on actual post_hashtags rows.
 * Also updates last_used_at to the latest post creation time.
 */
const recalculateHashtagCounts = async (client, hashtagIds) => {
    if (!hashtagIds || hashtagIds.length === 0) return;
    
    await client.query(`
        UPDATE hashtags h
        SET usage_count = sub.cnt,
            posts_count = sub.cnt,
            last_used_at = sub.last_at
        FROM (
            SELECT 
                h2.hashtag_id, 
                COUNT(ph.post_id) as cnt, 
                MAX(p.created_at) as last_at
            FROM hashtags h2
            LEFT JOIN post_hashtags ph ON ph.hashtag_id = h2.hashtag_id
            LEFT JOIN posts p ON p.post_id = ph.post_id AND p.is_removed IS NOT TRUE
            WHERE h2.hashtag_id = ANY($1)
            GROUP BY h2.hashtag_id
        ) sub
        WHERE h.hashtag_id = sub.hashtag_id
    `, [hashtagIds]);
};

/**
 * Syncs Redis trending_hashtags sorted set scores with counts from the last 24 hours.
 */
const syncTrendingScores = async (client, hashtagIds) => {
    if (!hashtagIds || hashtagIds.length === 0 || !redisClient.isOpen) return;
    
    // Calculate 24h usage for these specific hashtags
    const res = await client.query(`
        SELECT h.tag, COUNT(ph.post_id)::int as usage_24h
        FROM hashtags h
        LEFT JOIN post_hashtags ph ON ph.hashtag_id = h.hashtag_id
        LEFT JOIN posts p ON p.post_id = ph.post_id 
            AND p.is_removed IS NOT TRUE 
            AND p.created_at > NOW() - INTERVAL '24 hours'
        WHERE h.hashtag_id = ANY($1)
        GROUP BY h.hashtag_id, h.tag
    `, [hashtagIds]);
    
    for (const row of res.rows) {
        if (row.usage_24h > 0) {
            await redisClient.zAdd("trending_hashtags", { score: row.usage_24h, value: row.tag });
        } else {
            // Remove if no usage in 24h
            await redisClient.zRem("trending_hashtags", row.tag);
        }
    }
};

/**
 * Extracts hashtags from a post and rebuilds its tag mapping.
 */
const processHashtags = async (client, topic, postId) => {
    if (!postId) {
        console.warn("[EventOutboxWorker] Skipping: No postId provided.");
        return;
    }

    // 1. Fetch Post Content and Author
    const postRes = await client.query(`SELECT content, author_id FROM posts WHERE post_id = $1 AND is_removed IS NOT TRUE`, [postId]);
    if (postRes.rowCount === 0) {
        console.warn(`[EventOutboxWorker] Skipping: Post ${postId} not found or removed.`);
        return;
    }
    
    const content = postRes.rows[0].content || "";
    const authorId = postRes.rows[0].author_id;

    // 2. Extract standardized hashtags
    // Regex: # followed by alphanumeric/underscore. Normalize to lowercase.
    const rawMatches = content.match(/#[a-zA-Z0-9_]+/g) || [];
    
    // Normalize: Remove #, to lowercase, dedup per post, enforce length rules
    const tagSet = new Set();
    rawMatches.forEach(tag => {
        const clean = tag.toLowerCase().slice(1);
        if (clean.length >= 2 && clean.length <= 30) {
            tagSet.add(clean);
        }
    });
    
    const uniqueTags = Array.from(tagSet);
    console.log(`[EventOutboxWorker] Standardized unique tags for ${postId}:`, uniqueTags);

    // 3. Collect old hashtag IDs before clearing (for count recalculation)
    const affectedHashtagIds = new Set();

    if (topic === 'POST_UPDATED') {
        const oldLinks = await client.query(
            `SELECT hashtag_id FROM post_hashtags WHERE post_id = $1`, [postId]
        );
        oldLinks.rows.forEach(r => affectedHashtagIds.add(r.hashtag_id));
        await client.query(`DELETE FROM post_hashtags WHERE post_id = $1`, [postId]);
    }

    if (uniqueTags.length === 0) {
        // Still recalculate counts for hashtags that lost a post
        if (affectedHashtagIds.size > 0) {
            const ids = Array.from(affectedHashtagIds);
            await recalculateHashtagCounts(client, ids);
            await syncTrendingScores(client, ids);
        }
        console.log(`[EventOutboxWorker] No valid hashtags found for post ${postId}.`);
        return;
    }

    // 4. Upsert Hashtags
    for (const tag of uniqueTags) {
        try {
            const hashtagRes = await client.query(`
                INSERT INTO hashtags (tag, usage_count, posts_count, last_used_at) 
                VALUES ($1, 0, 0, NOW())
                ON CONFLICT (lower(tag)) 
                DO UPDATE SET 
                    tag = EXCLUDED.tag,
                    last_used_at = GREATEST(hashtags.last_used_at, EXCLUDED.last_used_at)
                RETURNING hashtag_id
            `, [tag]);
            
            const hashtagId = hashtagRes.rows[0].hashtag_id;
            affectedHashtagIds.add(hashtagId);

            // Ensure Relationship is Bound
            await client.query(`
                INSERT INTO post_hashtags (post_id, hashtag_id)
                VALUES ($1, $2)
                ON CONFLICT (post_id, hashtag_id) DO NOTHING
            `, [postId, hashtagId]);
            
            console.log(`[EventOutboxWorker] Successfully linked post ${postId} to tag #${tag}`);

            // Invalidate feed cache
            if (redisClient.isOpen) {
                await redisClient.del(`feed:hashtag:${tag}`);
                if (topic === 'POST_CREATED') {
                    await redisClient.lPush(`feed:hashtag:${tag}`, postId);
                    await redisClient.lTrim(`feed:hashtag:${tag}`, 0, 99);
                }
            }
        } catch (tagErr) {
            console.error(`[EventOutboxWorker] Error processing tag #${tag} for post ${postId}:`, tagErr);
        }
    }

    // 5. Recalculate accurate counts for all affected hashtags
    const allIds = Array.from(affectedHashtagIds);
    await recalculateHashtagCounts(client, allIds);

    // 6. Sync Redis trending scores with real DB counts
    await syncTrendingScores(client, allIds);

    if (topic === 'POST_CREATED') {
        incrementUserHashtagScore(authorId, 3, uniqueTags, null).catch(console.error);
    }
};

module.exports = {
    processEventOutbox,
    processHashtags
};
