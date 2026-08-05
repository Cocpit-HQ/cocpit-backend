const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../../.env") });
const fs = require("fs");
const pool = require("../core/db/pool");

async function runMigration() {
    console.log("[Migration] Running profile projects database migration...");
    const sqlPath = path.join(__dirname, "migration_profile_projects.sql");
    const sql = fs.readFileSync(sqlPath, "utf-8");
    try {
        await pool.query(sql);
        console.log("[Migration] Successfully created profile projects tables and indexes!");
        process.exit(0);
    } catch (err) {
        console.error("[Migration Error] Failed to execute migration:", err);
        process.exit(1);
    }
}

runMigration();
