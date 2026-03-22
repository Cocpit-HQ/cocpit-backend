require('dotenv').config();
const pool = require("./src/core/db/pool");

async function test() {
    try {
        const res = await pool.query("SELECT job_id, title, is_active, status FROM jobs WHERE job_id = '0256247c-f12a-4389-9b97-17240a8e959c';");
        console.log("Job Status:", JSON.stringify(res.rows[0]));
    } catch (err) {
        console.error(err);
    } finally {
        process.exit();
    }
}

test();
