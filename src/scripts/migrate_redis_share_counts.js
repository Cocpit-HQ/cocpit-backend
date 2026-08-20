require('dotenv').config({ path: __dirname + '/../../.env' }); // Adjust .env path if needed
const pool = require('../core/db/pool');
const redisClient = require('../core/db/redis');

async function migrateShareCounts() {
    try {
        console.log('[Migration] Starting share counts migration to Redis...');
        
        // Wait for Redis to connect if it's not already
        if (!redisClient.isOpen) {
            await redisClient.connect();
        }

        // Query to get all post share counts
        const query = `
            SELECT entity_id, COUNT(*) as count 
            FROM shares 
            WHERE entity_type = 'post'
            GROUP BY entity_id
        `;
        
        const { rows } = await pool.query(query);
        console.log(`[Migration] Found ${rows.length} posts with shares in the database.`);

        if (rows.length === 0) {
            console.log('[Migration] No shares found. Exiting.');
            process.exit(0);
        }

        // Set all values
        for (const row of rows) {
            if (row.entity_id) {
                await redisClient.set(`post:${row.entity_id}:share_count`, parseInt(row.count, 10));
            }
        }

        console.log(`[Migration] Successfully wrote ${rows.length} share counts to Redis.`);

        console.log('[Migration] Migration complete.');
        process.exit(0);
    } catch (error) {
        console.error('[Migration] Error migrating share counts:', error);
        process.exit(1);
    }
}

migrateShareCounts();
