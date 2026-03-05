require('dotenv').config();
const pool = require('./src/core/db/pool');
const fs = require('fs');
const path = require('path');

async function runMigration() {
    const client = await pool.connect();
    try {
        const sqlPath = path.join(__dirname, 'migrations', 'phase1_org_abstraction.sql');
        const sql = fs.readFileSync(sqlPath, 'utf8');

        console.log('Running migration: phase1_org_abstraction.sql');
        await client.query(sql);
        console.log('✅ Migration successful');
    } catch (err) {
        console.error('❌ Migration failed:', err);
    } finally {
        client.release();
        process.exit();
    }
}

runMigration();
