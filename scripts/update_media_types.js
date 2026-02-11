require("dotenv").config({ path: require('path').resolve(__dirname, '../.env') });
const pool = require("../src/db/pool");

async function runMigration() {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        console.log("Updating message_media constraint...");
        // Drop existing check constraint and add new one
        await client.query(`
      ALTER TABLE message_media 
      DROP CONSTRAINT IF EXISTS message_media_media_type_check;
    `);

        await client.query(`
      ALTER TABLE message_media 
      ADD CONSTRAINT message_media_media_type_check 
      CHECK (media_type IN ('image', 'video', 'document'));
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
