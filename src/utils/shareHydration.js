const redisClient = require('../core/db/redis');
const pool = require('../core/db/pool');

/**
 * Hydrates external_share_count on a list of posts from Redis,
 * with a fallback to the PostgreSQL database if Redis fails or on a cache miss.
 * 
 * @param {Array} posts - Array of post objects from the database
 * @returns {Array} - The mutated posts array
 */
async function hydrateShareCounts(posts) {
    if (!posts || posts.length === 0) return posts;

    try {
        const postIds = [];
        // Extract all post IDs (main posts and shared posts)
        posts.forEach(p => {
            if (p.post_id) postIds.push(p.post_id);
            if (p.shared_post && p.shared_post.post_id) {
                postIds.push(p.shared_post.post_id);
            }
        });

        // Unique post IDs
        const uniquePostIds = [...new Set(postIds)];
        if (uniquePostIds.length === 0) return posts;

        const shareCountsMap = new Map();
        const missingPostIds = [];

        // 1. Try fetching from Redis
        if (redisClient.isOpen) {
            const keys = uniquePostIds.map(id => `post:${id}:share_count`);
            const redisResults = await redisClient.mGet(keys);
            
            uniquePostIds.forEach((id, index) => {
                const val = redisResults[index];
                if (val !== null) {
                    shareCountsMap.set(id, parseInt(val, 10) || 0);
                } else {
                    missingPostIds.push(id);
                }
            });
        } else {
            // Redis is down, all IDs are missing
            missingPostIds.push(...uniquePostIds);
        }

        // 2. Fallback to DB for missing IDs (Cache Miss or Redis Down)
        if (missingPostIds.length > 0) {
            const query = `
                SELECT entity_id, COUNT(*) as count 
                FROM shares 
                WHERE entity_type IN ('post', 'article') AND entity_id = ANY($1)
                GROUP BY entity_id
            `;
            const dbResult = await pool.query(query, [missingPostIds]);
            
            // Populate the map with DB results
            const dbCounts = new Map();
            dbResult.rows.forEach(row => {
                dbCounts.set(row.entity_id, parseInt(row.count, 10));
            });

            // Backfill Redis and update the map
            const setPromises = [];
            
            missingPostIds.forEach(id => {
                const count = dbCounts.get(id) || 0;
                shareCountsMap.set(id, count);
                if (redisClient.isOpen) {
                    setPromises.push(redisClient.set(`post:${id}:share_count`, count));
                }
            });

            if (setPromises.length > 0) {
                await Promise.allSettled(setPromises);
            }
        }

        // 3. Hydrate the original posts array
        posts.forEach(p => {
            if (p.post_id) {
                p.external_share_count = shareCountsMap.get(p.post_id) || 0;
            }
            if (p.shared_post && p.shared_post.post_id) {
                p.shared_post.external_share_count = shareCountsMap.get(p.shared_post.post_id) || 0;
            }
        });

        return posts;

    } catch (error) {
        console.error('[ShareHydration] Error hydrating share counts:', error.message);
        return posts; // Gracefully degrade by returning un-hydrated posts (which will have 0)
    }
}

module.exports = {
    hydrateShareCounts
};
