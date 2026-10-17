const pool = require("../core/db/pool");
const cloudinary = require("../core/infrastructure/cloudinary.client");

/**
 * Story Expiry Worker
 * -------------------
 * Runs periodically (every 15 minutes) to:
 * 1. Find stories whose `expires_at` has passed
 * 2. Delete their Cloudinary assets (images/videos)
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
        } catch (connErr) {
            console.warn("[StoryExpiryWorker] Database connection unavailable. Skipping sweep.");
            return;
        }

        // 1. Find expired stories with their Cloudinary public_ids
        const expiredRes = await client.query(`
            SELECT story_id, cld_public_id, media_type
            FROM stories
            WHERE expires_at <= NOW()
            LIMIT 100
        `);

        if (expiredRes.rowCount === 0) return;

        console.log(`[StoryExpiryWorker] Found ${expiredRes.rowCount} expired stories.`);

        // 2. Batch delete from Cloudinary (group by resource type)
        const imageIds = [];
        const videoIds = [];
        for (const story of expiredRes.rows) {
            if (!story.cld_public_id) continue;
            if (story.media_type === 'video') {
                videoIds.push(story.cld_public_id);
            } else {
                imageIds.push(story.cld_public_id);
            }
        }

        if (imageIds.length > 0) {
            try {
                await cloudinary.api.delete_resources(imageIds, { resource_type: 'image' });
                console.log(`[StoryExpiryWorker] Deleted ${imageIds.length} image assets from Cloudinary.`);
            } catch (cldErr) {
                console.error("[StoryExpiryWorker] Cloudinary image deletion error:", cldErr.message);
            }
        }

        if (videoIds.length > 0) {
            try {
                await cloudinary.api.delete_resources(videoIds, { resource_type: 'video' });
                console.log(`[StoryExpiryWorker] Deleted ${videoIds.length} video assets from Cloudinary.`);
            } catch (cldErr) {
                console.error("[StoryExpiryWorker] Cloudinary video deletion error:", cldErr.message);
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
