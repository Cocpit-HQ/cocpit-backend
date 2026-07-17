require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

async function runMigration() {
    console.log('Connecting to database...');
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        console.log('1. Adding icon column to organization_key_offerings...');
        await client.query(`
            ALTER TABLE organization_key_offerings 
            ADD COLUMN IF NOT EXISTS icon VARCHAR(100);
        `);

        console.log('2. Migrating existing data...');
        const res = await client.query(`SELECT offering_id, content FROM organization_key_offerings WHERE content LIKE '%||%';`);
        console.log(`Found ${res.rowCount} rows to migrate.`);

        for (const row of res.rows) {
            const rawText = row.content;
            let icon = null;
            let text = rawText;

            if (rawText.includes("|||")) {
                const parts = rawText.split("|||");
                icon = parts[0];
                text = parts[1];
            } else if (rawText.includes("||")) {
                const parts = rawText.split("||");
                icon = parts[0];
                text = parts[1];
            }

            if (icon !== null) {
                await client.query(`
                    UPDATE organization_key_offerings 
                    SET icon = $1, content = $2 
                    WHERE offering_id = $3
                `, [icon, text, row.offering_id]);
            }
        }

        await client.query('COMMIT');
        console.log('Migration successful!');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Migration failed:', err);
    } finally {
        client.release();
        await pool.end();
    }
}

runMigration();
