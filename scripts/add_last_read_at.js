const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const pool = require("../src/db/pool");

async function run() {
    try {
        console.log("🚀 Starting DB Migration...");

        // Add last_read_at column to conversation_participants
        await pool.query(`
            ALTER TABLE conversation_participants 
            ADD COLUMN IF NOT EXISTS last_read_at TIMESTAMPTZ DEFAULT NOW();
        `);
        console.log("✅ Added last_read_at column to conversation_participants");

        // Index for performance
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_participants_last_read_at 
            ON conversation_participants (last_read_at);
        `);
        console.log("✅ Created idx_participants_last_read_at");

        console.log("🎉 Migration complete!");
        process.exit(0);

    } catch (err) {
        console.error("❌ Error migrating DB:", err);
        process.exit(1);
    }
}

run();
