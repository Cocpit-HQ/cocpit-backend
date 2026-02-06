require('dotenv').config();
const pool = require("../src/db/pool");
const fs = require('fs');
const path = require('path');

async function runMigration() {
    console.log("🔧 Running migration: fix_shared_post_constraint.sql");

    const client = await pool.connect();
    try {
        const migrationSQL = fs.readFileSync(
            path.join(__dirname, '../migrations/fix_shared_post_constraint.sql'),
            'utf8'
        );

        await client.query(migrationSQL);
        console.log("✅ Migration completed successfully");
        console.log("   - Dropped old messages_shared_post_id_fkey constraint");
        console.log("   - Added new constraint with ON DELETE SET NULL");
    } catch (err) {
        console.error("❌ Migration failed:", err.message);
        throw err;
    } finally {
        client.release();
        process.exit(0);
    }
}

runMigration();
