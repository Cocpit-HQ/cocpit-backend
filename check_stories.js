require('dotenv').config();
const pool = require('./src/db/pool');

async function check() {
    try {
        const res = await pool.query(`
            SELECT story_id, media_status, render_status, media_url, original_url, final_url 
            FROM stories 
            ORDER BY created_at DESC 
            LIMIT 5
        `);
        console.log(JSON.stringify(res.rows, null, 2));
    } catch (e) {
        console.error(e);
    } finally {
        await pool.end();
    }
}

check();
