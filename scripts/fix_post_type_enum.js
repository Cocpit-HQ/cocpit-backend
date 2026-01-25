const { Pool } = require('pg');
const dotenv = require('dotenv');
const path = require('path');

// Load environment variables from .env file
dotenv.config({ path: path.join(__dirname, '../.env') });

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

async function migrate() {
    const client = await pool.connect();
    try {
        console.log('Starting migration to add "text" to post_type enum...');

        // Check if 'text' already exists in the enum to avoid error
        const checkQuery = `
      SELECT 1 FROM pg_type t 
      JOIN pg_enum e ON t.oid = e.enumtypid  
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE t.typname = 'post_type' AND e.enumlabel = 'text';
    `;

        const checkRes = await client.query(checkQuery);

        if (checkRes.rowCount === 0) {
            await client.query("ALTER TYPE post_type ADD VALUE 'text';");
            console.log("✅ Added 'text' to post_type enum.");
        } else {
            console.log("ℹ️ 'text' already exists in post_type enum.");
        }

    } catch (err) {
        console.error('❌ Migration failed:', err);
    } finally {
        client.release();
        await pool.end();
    }
}

migrate();
