/**
 * Migration: Add organizer_name column to events table
 */
require("dotenv").config();
const pool = require("../src/core/db/pool");

async function run() {
    try {
        console.log("Adding organizer_name column to events table...");
        await pool.query("ALTER TABLE events ADD COLUMN IF NOT EXISTS organizer_name TEXT;");
        console.log("Migration successful!");
        process.exit(0);
    } catch (err) {
        console.error("Migration failed:", err);
        process.exit(1);
    }
}

run();
