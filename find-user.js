require('dotenv').config();
const pool = require("./src/core/db/pool");

async function test() {
    try {
        const res = await pool.query("SELECT user_id, full_name FROM users LIMIT 1;");
        if (res.rowCount > 0) {
            console.log("USER_FOUND");
            console.log(JSON.stringify(res.rows[0]));
        } else {
            console.log("No users found.");
        }
    } catch (err) {
        console.error(err);
    } finally {
        process.exit();
    }
}

test();
