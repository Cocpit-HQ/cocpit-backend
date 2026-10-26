const pool = require("../core/db/pool");
const { deleteObjectsFromR2 } = require("../core/infrastructure/r2.client");

/**
 * Story Expiry Worker
 * -------------------
 * Runs periodically (every 15 minutes) to:
 * 1. Find stories whose `expires_at` has passed
 * 2. Delete their R2 storage assets
 * 3. Hard-delete them from PostgreSQL (CASCADE removes views/reactions/comments)
 */
const processStoryExpirations = async () => {
    let client;
    try {
        try {
            client = await pool.connect();
            // Handle connection drops/reset while client is in use
            client.once('error', (err) => {
                console.error("[StoryExpiryWorker] Unexpected client error:", err.message);
            });
        } catch (connectionError) {
            console.warn("[StoryExpiryWorker] Database connection unavailable. Skipping sweep:", connectionError.message);
            return;
        }

        // 1. Find expired stories with their public_ids/keys
        const expiredRes = await client.query(`
            SELECT story_id, cld_public_id, media_type
            FROM stories
            WHERE expires_at <= NOW()
            LIMIT 100
        `);

        if (expiredRes.rowCount === 0) return;

        console.log(`[StoryExpiryWorker] Found ${expiredRes.rowCount} expired stories.`);

        // 2. Batch delete assets from R2
        const r2Keys = expiredRes.rows.map(r => r.cld_public_id).filter(Boolean);
        if (r2Keys.length > 0) {
            try {
                await deleteObjectsFromR2(r2Keys);
                console.log(`[StoryExpiryWorker] Deleted ${r2Keys.length} assets from R2.`);
            } catch (r2Err) {
                console.error("[StoryExpiryWorker] R2 deletion error:", r2Err.message);
            }
        }

        // 3. Hard-delete from DB (CASCADE handles views/reactions/comments)
        const storyIds = expiredRes.rows.map(r => r.story_id);
        await client.query(
            `DELETE FROM stories WHERE story_id = ANY($1)`,
            [storyIds]
        );

        console.log(`[StoryExpiryWorker] Deleted ${storyIds.length} expired stories from DB.`);

    } catch (err) {
        console.error("[StoryExpiryWorker] Error:", err);
    } finally {
        if (client) client.release();
    }
};

module.exports = { processStoryExpirations };
