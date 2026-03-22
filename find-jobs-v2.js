require('dotenv').config();
const pool = require("./src/core/db/pool");

async function test() {
    try {
        const res = await pool.query("SELECT job_id, title FROM jobs WHERE is_active = TRUE AND status = 'ACTIVE' LIMIT 5;");
        console.log("JOBS_LIST_START");
        res.rows.forEach(r => console.log(JSON.stringify(r)));
        console.log("JOBS_LIST_END");
    } catch (err) {
        console.error(err);
    } finally {
        process.exit();
    }
}

test();
