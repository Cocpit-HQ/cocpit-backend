require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

async function main() {
    const client = await pool.connect();
    try {
        console.log('Adding label column to organization_key_offerings...');
        await client.query('ALTER TABLE organization_key_offerings ADD COLUMN IF NOT EXISTS label VARCHAR(50);');
        console.log('Migration successful!');
    } catch (e) {
        console.error('Migration failed:', e);
    } finally {
        client.release();
        await pool.end();
    }
}

main();
