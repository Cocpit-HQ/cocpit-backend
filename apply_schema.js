const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
});

async function run() {
    try {
        await client.connect();
        console.log('Connected to database');

        // 1. Drop existing unique constraint if it exists (it depends on the column)
        console.log('Dropping dependent constraints...');
        await client.query('ALTER TABLE profile_views DROP CONSTRAINT IF EXISTS unique_daily_profile_view;');

        // 2. Drop the generated column
        console.log('Dropping generated view_date column...');
        await client.query('ALTER TABLE profile_views DROP COLUMN IF EXISTS view_date;');

        // 3. Add view_date as a normal column with DEFAULT CURRENT_DATE
        console.log('Adding view_date as standard column...');
        await client.query('ALTER TABLE profile_views ADD COLUMN view_date DATE DEFAULT CURRENT_DATE;');

        // 4. Populate view_date for existing records
        console.log('Initializing view_date from viewed_at...');
        await client.query('UPDATE profile_views SET view_date = viewed_at::DATE WHERE view_date IS NULL;');

        // 5. Clean up duplicates to avoid constraint violation (after conversion)
        console.log('Cleaning up duplicate view records...');
        const cleanupResult = await client.query(`
            DELETE FROM profile_views p1 
            USING profile_views p2 
            WHERE p1.view_id < p2.view_id 
              AND p1.viewer_id = p2.viewer_id 
              AND p1.profile_owner_id = p2.profile_owner_id 
              AND p1.profile_type = p2.profile_type 
              AND p1.view_date = p2.view_date;
        `);
        console.log(`Cleaned up ${cleanupResult.rowCount} duplicate records.`);

        // 6. Add unique constraint back
        console.log('Adding unique constraint unique_daily_profile_view...');
        await client.query(`
            ALTER TABLE profile_views 
            ADD CONSTRAINT unique_daily_profile_view 
            UNIQUE (viewer_id, profile_owner_id, profile_type, view_date);
        `);
        console.log('Unique constraint added successfully.');

    } catch (err) {
        console.error('Error fixing schema:', err);
        process.exit(1);
    } finally {
        await client.end();
    }
}

run();
