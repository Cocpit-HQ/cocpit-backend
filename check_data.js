require("dotenv").config();
const pool = require("./src/core/db/pool");

async function checkData() {
    try {
        const res = await pool.query("SELECT * FROM saved_folders WHERE name = 'myyy' ORDER BY created_at DESC LIMIT 1;");
        console.log("Folder 'myyy' data:", res.rows[0]);
        process.exit(0);
    } catch (err) {
        console.error("Error checking data:", err);
        process.exit(1);
    }
}

checkData();
