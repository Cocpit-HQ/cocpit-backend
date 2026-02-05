require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../src/db/pool');

async function runMigration() {
    try {
        const sqlPath = path.join(__dirname, '../migrations/002_add_last_message.sql');
        const sql = fs.readFileSync(sqlPath, 'utf8');

        console.log('Running migration...');
        const result = await pool.query(sql);
        console.log('Migration successful:', result);
    } catch (err) {
        if (err.code === '42701') { // duplicate_column
            console.log('Columns already exist, skipping migration.');
        } else {
            console.error('Migration failed:', err);
        }
    } finally {
        pool.end();
    }
}

runMigration();
