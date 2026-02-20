require("dotenv").config();
const pool = require("../src/db/pool");

async function migrate() {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        console.log("Adding render fields to stories table...");

        await client.query(`
            ALTER TABLE stories 
            ADD COLUMN IF NOT EXISTS final_url TEXT,
            ADD COLUMN IF NOT EXISTS render_status TEXT CHECK (render_status IN ('queued', 'processing', 'ready', 'failed'));
        `);

        // Note: Legacy stories will have NULL render_status and NULL final_url, 
        // which serves as the flag for "Legacy Client-Side Rendering".

        await client.query("COMMIT");
        console.log("Migration successful: Added final_url and render_status to stories.");
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Migration failed:", err);
    } finally {
        client.release();
        await pool.end();
    }
}

migrate();
