const { Pool } = require('pg');

const pool = new Pool({
    host: '192.168.1.13',
    user: 'harshada',
    password: 'cocpit@4713',
    database: 'cocpit_backend',
    port: 5432,
});

async function inspectLatestJobStory() {
    try {
        const res = await pool.query(`
            SELECT story_id, media_url, story_metadata, created_at 
            FROM stories 
            WHERE media_url = 'job-structured-data'
            ORDER BY created_at DESC 
            LIMIT 1
        `);
        if (res.rowCount === 0) {
            console.log("No job stories found.");
            return;
        }
        const story = res.rows[0];
        console.log("--- LATEST JOB STORY ---");
        console.log(`ID: ${story.story_id}`);
        console.log(`Media URL: ${story.media_url}`);
        console.log("Metadata (Full Object):");
        console.dir(story.story_metadata, { depth: null });
        console.log(`Created At: ${story.created_at}`);
    } catch (err) {
        console.error(err);
    } finally {
        await pool.end();
    }
}

inspectLatestJobStory();
