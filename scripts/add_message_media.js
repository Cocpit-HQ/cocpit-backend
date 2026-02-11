require("dotenv").config({ path: require('path').resolve(__dirname, '../.env') });
const pool = require("../src/db/pool");

async function runMigration() {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        console.log("Creating message_media table...");
        await client.query(`
      CREATE TABLE IF NOT EXISTS message_media (
        media_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        message_id UUID REFERENCES messages(message_id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        media_type TEXT CHECK (media_type IN ('image', 'video')) DEFAULT 'image',
        created_at TIMESTAMPTZ DEFAULT now()
      );
    `);

        console.log("Migration completed successfully.");
        await client.query("COMMIT");
    } catch (err) {
        console.error("Migration failed:", err);
        await client.query("ROLLBACK");
    } finally {
        client.release();
        process.exit();
    }
}

runMigration();
