const pool = require("../core/db/pool");
const cloudinary = require("../core/infrastructure/cloudinary.client");
const { r2Client, hasR2, bucketName } = require("../core/infrastructure/r2.client");
const { DeleteObjectsCommand } = require("@aws-sdk/client-s3");

/**
 * Story Expiry Worker
 * -------------------
 * Runs periodically (every 15 minutes) to:
 * 1. Find stories whose `expires_at` has passed
 * 2. Delete their storage assets (Cloudflare R2 or legacy Cloudinary)
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

        // 1. Find expired stories with their public_ids / keys
        const expiredRes = await client.query(`
            SELECT story_id, cld_public_id, media_type
            FROM stories
            WHERE expires_at <= NOW()
            LIMIT 100
        `);

        if (expiredRes.rowCount === 0) return;

        console.log(`[StoryExpiryWorker] Found ${expiredRes.rowCount} expired stories.`);

        // 2. Batch delete assets (Separate R2 keys from legacy Cloudinary IDs)
        const r2Keys = [];
        const cldImageIds = [];
        const cldVideoIds = [];

        for (const story of expiredRes.rows) {
            if (!story.cld_public_id) continue;
            // If the public_id is an R2 key (e.g. starts with stories/) or we have R2 enabled
            if (story.cld_public_id.startsWith("stories/") || hasR2) {
                r2Keys.push({ Key: story.cld_public_id });
            } else if (story.media_type === 'video') {
                cldVideoIds.push(story.cld_public_id);
            } else {
                cldImageIds.push(story.cld_public_id);
            }
        }

        // Delete from R2
        if (hasR2 && r2Client && r2Keys.length > 0) {
            try {
                await r2Client.send(new DeleteObjectsCommand({
                    Bucket: bucketName,
                    Delete: { Objects: r2Keys, Quiet: true }
                }));
                console.log(`[StoryExpiryWorker] Deleted ${r2Keys.length} assets from Cloudflare R2.`);
            } catch (r2Err) {
                console.error("[StoryExpiryWorker] Cloudflare R2 deletion error:", r2Err.message);
            }
        }

        // Fallback: Delete legacy Cloudinary assets
        if (cloudinary?.api && cldImageIds.length > 0) {
            try {
                await cloudinary.api.delete_resources(cldImageIds, { resource_type: 'image' });
                console.log(`[StoryExpiryWorker] Deleted ${cldImageIds.length} legacy image assets from Cloudinary.`);
            } catch (cldErr) {
                console.error("[StoryExpiryWorker] Cloudinary image deletion error:", cldErr.message);
            }
        }

        if (cloudinary?.api && cldVideoIds.length > 0) {
            try {
                await cloudinary.api.delete_resources(cldVideoIds, { resource_type: 'video' });
                console.log(`[StoryExpiryWorker] Deleted ${cldVideoIds.length} legacy video assets from Cloudinary.`);
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
