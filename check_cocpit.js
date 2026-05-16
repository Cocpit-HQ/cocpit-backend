require("dotenv").config();
const pool = require("./src/core/db/pool");

async function checkCocpit() {
    try {
        const res = await pool.query("SELECT * FROM saved_folders WHERE name = 'cocpit' ORDER BY created_at DESC LIMIT 1;");
        console.log("Folder 'cocpit' data:", res.rows[0]);
        process.exit(0);
    } catch (err) {
        console.error("Error checking data:", err);
        process.exit(1);
    }
}

checkCocpit();
