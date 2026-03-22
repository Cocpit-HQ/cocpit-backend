require('dotenv').config();
const pool = require("./src/core/db/pool");

async function test() {
    try {
        const res = await pool.query("SELECT * FROM jobs WHERE is_active = TRUE LIMIT 1;");
        console.log("FULL_JOB_DATA");
        console.log(JSON.stringify(res.rows[0]));
    } catch (err) {
        console.error(err);
    } finally {
        process.exit();
    }
}

test();
