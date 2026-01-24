require("dotenv").config();
const pool = require("../db/pool");

async function migrate() {
    try {
        console.log("Starting migration...");
        await pool.query(`
      ALTER TABLE stories 
      ADD COLUMN IF NOT EXISTS media_status VARCHAR(20) DEFAULT 'ready',
      ADD COLUMN IF NOT EXISTS cld_public_id VARCHAR(255);
    `);
        console.log("Migration successful: Added media_status and cld_public_id to stories table.");
    } catch (err) {
        console.error("Migration failed:", err);
    } finally {
        // pool might not have end() if it's just exported from pg, 
        // but usually it does. If it hangs, CTRL+C is fine.
        // relying on process.exit()
        process.exit();
    }
}

migrate();
