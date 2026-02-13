require("dotenv").config();
const pool = require("../src/db/pool");

async function migrate() {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        console.log("Checking if recipient_company_id column exists...");
        const checkCol = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name='notifications' AND column_name='recipient_company_id';
    `);

        if (checkCol.rowCount === 0) {
            console.log("Adding recipient_company_id column...");
            await client.query(`
        ALTER TABLE notifications 
        ADD COLUMN recipient_company_id UUID REFERENCES companies(company_id) ON DELETE CASCADE;
      `);
        } else {
            console.log("recipient_company_id column already exists.");
        }

        console.log("Adding indexes...");
        // Check and add indexes
        await client.query(`
        CREATE INDEX IF NOT EXISTS idx_notifications_recipient_company ON notifications(recipient_company_id);
    `);

        await client.query(`
        CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, is_read);
    `);

        await client.query("COMMIT");
        console.log("Migration successful");
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Migration failed:", err);
    } finally {
        client.release();
        pool.end();
    }
}

migrate();
