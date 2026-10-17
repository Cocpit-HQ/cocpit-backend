require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../core/db/pool');

const runMigration = async () => {
    const client = await pool.connect();
    try {
        console.log('Running migration: migration_expand_org_headline_255.sql ...');
        const sqlPath = path.join(__dirname, '../db/migration_expand_org_headline_255.sql');
        const sql = fs.readFileSync(sqlPath, 'utf8');

        await client.query(sql);
        console.log('✅ Migration succeeded: organizations.headline expanded to VARCHAR(255).');
    } catch (err) {
        console.error('❌ Migration failed:', err);
        process.exitCode = 1;
    } finally {
        client.release();
        await pool.end();
    }
};

runMigration();
