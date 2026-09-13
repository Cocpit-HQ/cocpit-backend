require('dotenv').config();
const pool = require("./src/core/db/pool");
async function run() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS ticket_replies (
                reply_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                ticket_id UUID REFERENCES support_tickets(ticket_id) ON DELETE CASCADE,
                admin_id UUID,
                message TEXT NOT NULL,
                is_internal_note BOOLEAN DEFAULT false,
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
        `);
        console.log("Table created successfully");
    } catch(e) {
        console.error("Error:", e);
    } finally {
        process.exit();
    }
}
run();
