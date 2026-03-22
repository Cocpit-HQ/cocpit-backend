require('dotenv').config();
const pool = require("./src/core/db/pool");

async function test() {
    try {
        const res = await pool.query("SELECT user_id FROM users LIMIT 1;");
        if (res.rows[0]) {
            console.log("ACTUAL_USER_ID_IS");
            console.log(res.rows[0].user_id);
        }
    } catch (err) {
        console.error(err);
    } finally {
        process.exit();
    }
}

test();
