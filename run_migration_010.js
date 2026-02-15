require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('./src/db/pool');

async function runMigration() {
    const migrationFile = path.join(__dirname, 'migrations', '010_add_company_id_to_events.sql');
    const sql = fs.readFileSync(migrationFile, 'utf8');

    console.log('Running migration: 010_add_company_id_to_events.sql');

    try {
        await pool.query(sql);
        console.log('Migration successful');
    } catch (err) {
        if (err.code === '42701') {
            console.log('Column already exists, skipping.');
        } else {
            console.error('Migration failed:', err);
        }
    } finally {
        await pool.end();
    }
}

runMigration();
