const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

const BATCH_SIZE = 500;
const THROTTLE_MS = 50; // Throttle to prevent DB IO freeze

const extractHashtags = (content) => {
    if (!content) return [];
    const matches = content.match(/#[a-zA-Z0-9_]+/g) || [];
    const tagSet = new Set();
    matches.forEach(m => {
        const clean = m.toLowerCase().substring(1);
        if (clean.length >= 2 && clean.length <= 30) {
            tagSet.add(clean);
        }
    });
    return Array.from(tagSet);
};

const delay = ms => new Promise(res => setTimeout(res, ms));

async function runBackfill() {
    console.log("Starting Hashtag Backfill...");
    const client = await pool.connect();

    try {
        // Fetch all viable posts containing a hashtag roughly
        const { rows: postRows } = await client.query(`
            SELECT post_id, content 
            FROM posts 
            WHERE content LIKE '%#%' AND is_removed IS NOT TRUE
        `);

        console.log(`Found ${postRows.length} potential posts to process. Executing in batches of ${BATCH_SIZE}.`);

        let processed = 0;
        let batchTags = {}; // local in-memory structure
        let bulkRelations = [];

        for (let i = 0; i < postRows.length; i++) {
            const post = postRows[i];
            const tags = extractHashtags(post.content);

            if (tags.length > 0) {
                tags.forEach(tag => {
                    batchTags[tag] = (batchTags[tag] || 0) + 1;
                    bulkRelations.push({ postId: post.post_id, tag });
                });
            }

            // Execute Batch boundary
            if ((i + 1) % BATCH_SIZE === 0 || i === postRows.length - 1) {
                await client.query("BEGIN");
                
                // 1. Bulk Upsert Hashtags
                const uniqueTags = Object.keys(batchTags);
                if (uniqueTags.length > 0) {
                    for (const t of uniqueTags) {
                        await client.query(`
                            INSERT INTO hashtags (tag, usage_count) 
                            VALUES ($1, $2)
                            ON CONFLICT (lower(tag)) 
                            DO UPDATE SET usage_count = hashtags.usage_count + EXCLUDED.usage_count
                        `, [t, batchTags[t]]);
                    }

                    // 2. Fetch hashtag IDs back efficiently
                    const idsRes = await client.query(`SELECT hashtag_id, tag FROM hashtags WHERE tag = ANY($1)`, [uniqueTags]);
                    const tagToIdMap = {};
                    idsRes.rows.forEach(r => { tagToIdMap[r.tag] = r.hashtag_id; });

                    // 3. Insert Relations
                    for (const rel of bulkRelations) {
                        const hId = tagToIdMap[rel.tag];
                        if (hId) {
                            await client.query(`
                                INSERT INTO post_hashtags (post_id, hashtag_id)
                                VALUES ($1, $2)
                                ON CONFLICT DO NOTHING
                            `, [rel.postId, hId]);
                        }
                    }
                }

                await client.query("COMMIT");
                
                processed += (i % BATCH_SIZE) || BATCH_SIZE;
                console.log(`Processed ${processed}/${postRows.length} posts...`);
                
                // Reset local batch memory
                batchTags = {};
                bulkRelations = [];

                // Throttle to alleviate connections
                await delay(THROTTLE_MS);
            }
        }
        console.log("Backfill complete successfully.");
    } catch (err) {
        console.error("Backfill failed:", err);
        await client.query("ROLLBACK");
    } finally {
        client.release();
        pool.end();
    }
}

// Ensure execution triggers
runBackfill();
