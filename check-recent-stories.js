const { Pool } = require('pg');

const pool = new Pool({
    host: '192.168.1.13',
    user: 'harshada',
    password: 'cocpit@4713',
    database: 'cocpit_backend',
    port: 5432,
});

async function findRecentJobStory() {
    try {
        const res = await pool.query(`
            SELECT story_id, media_url, story_metadata, created_at, expires_at 
            FROM stories 
            ORDER BY created_at DESC 
            LIMIT 5
        `);
        console.log("Recent Stories:");
        res.rows.forEach(story => {
            console.log(`ID: ${story.story_id}`);
            console.log(`Media URL: ${story.media_url}`);
            console.log(`Metadata: ${JSON.stringify(story.story_metadata, null, 2)}`);
            console.log(`Created At: ${story.created_at}`);
            console.log("-------------------");
        });
    } catch (err) {
        console.error(err);
    } finally {
        await pool.end();
    }
}

findRecentJobStory();
