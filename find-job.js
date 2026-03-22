require('dotenv').config();
const pool = require("./src/core/db/pool");

async function test() {
    try {
        const res = await pool.query("SELECT job_id, title FROM jobs WHERE is_active = TRUE LIMIT 1;");
        if (res.rowCount > 0) {
            console.log("JOB_IDS_FOUND");
            console.log(JSON.stringify(res.rows[0]));
        } else {
            console.log("No active jobs found.");
        }
    } catch (err) {
        console.error(err);
    } finally {
        process.exit();
    }
}

test();
