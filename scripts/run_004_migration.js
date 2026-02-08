require('dotenv').config();
const pool = require("../src/db/pool");
const fs = require('fs');
const path = require('path');

async function runMigration() {
    console.log("🔧 Running migration: 004_add_message_reads.sql");

    const client = await pool.connect();
    try {
        const migrationSQL = fs.readFileSync(
            path.join(__dirname, '../migrations/004_add_message_reads.sql'),
            'utf8'
        );

        await client.query("BEGIN");
        await client.query(migrationSQL);
        await client.query("COMMIT");

        console.log("✅ Migration completed successfully");
        console.log("   - Created message_reads table");
        console.log("   - Created indices");
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("❌ Migration failed:", err.message);
        throw err;
    } finally {
        client.release();
        process.exit(0);
    }
}

runMigration();
