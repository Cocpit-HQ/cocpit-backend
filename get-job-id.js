require('dotenv').config();
const pool = require("./src/core/db/pool");

async function test() {
    try {
        const res = await pool.query("SELECT job_id FROM jobs WHERE is_active = TRUE LIMIT 1;");
        if (res.rows[0]) {
            console.log("ACTUAL_JOB_ID_IS");
            console.log(res.rows[0].job_id);
        }
    } catch (err) {
        console.error(err);
    } finally {
        process.exit();
    }
}

test();
