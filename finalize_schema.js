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

        // 1. Check if view_date is a generated column
        const res = await client.query(`
            SELECT is_generated 
            FROM information_schema.columns 
            WHERE table_name = 'profile_views' AND column_name = 'view_date';
        `);

        if (res.rows.length > 0 && res.rows[0].is_generated === 'ALWAYS') {
            console.log('Converting view_date from generated to standard column...');
            await client.query('ALTER TABLE profile_views DROP COLUMN view_date CASCADE;');
            await client.query('ALTER TABLE profile_views ADD COLUMN view_date DATE DEFAULT CURRENT_DATE;');
        } else if (res.rows.length === 0) {
            console.log('Adding view_date column...');
            await client.query('ALTER TABLE profile_views ADD COLUMN view_date DATE DEFAULT CURRENT_DATE;');
        } else {
            console.log('view_date is already a standard column.');
        }

        // 2. Clear old constraints to ensure fresh unique_24hr_view
        console.log('Updating unique constraints...');
        await client.query('ALTER TABLE profile_views DROP CONSTRAINT IF EXISTS unique_daily_profile_view;');
        await client.query('ALTER TABLE profile_views DROP CONSTRAINT IF EXISTS unique_24hr_view;');
        
        // Populate any nulls before adding unique constraint
        await client.query('UPDATE profile_views SET view_date = COALESCE(view_date, CURRENT_DATE);');
        
        await client.query(`
            ALTER TABLE profile_views 
            ADD CONSTRAINT unique_24hr_view 
            UNIQUE (viewer_id, profile_owner_id, profile_type, view_date);
        `);

        // 3. Ensure performance index
        await client.query('CREATE INDEX IF NOT EXISTS idx_profile_views_owner ON profile_views(profile_owner_id, profile_type);');

        console.log('Database schema finalized successfully.');
    } catch (err) {
        console.error('Error finalizing schema:', err);
        process.exit(1);
    } finally {
        await client.end();
    }
}

run();
