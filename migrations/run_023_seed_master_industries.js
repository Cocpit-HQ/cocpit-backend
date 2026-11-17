require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const pool = require('../src/core/db/pool');
const fs = require('fs');
const path = require('path');

async function run() {
  try {
    const sqlPath = path.join(__dirname, '023_seed_master_industries.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    const beforeRes = await pool.query('SELECT COUNT(*) FROM industries_master');
    const countBefore = parseInt(beforeRes.rows[0].count, 10);
    console.log(`--- Total industries in DB before seed: ${countBefore} ---`);

    console.log('--- Applying Migration 023: Seed master industries list (ignoring duplicates) ---');
    await pool.query(sql);

    const afterRes = await pool.query('SELECT COUNT(*) FROM industries_master');
    const countAfter = parseInt(afterRes.rows[0].count, 10);
    const addedCount = countAfter - countBefore;

    console.log(`✅ Migration 023 applied successfully.`);
    console.log(`✅ Newly added industries: ${addedCount}`);
    console.log(`✅ Total industries in DB now: ${countAfter}`);

    process.exit(0);
  } catch (err) {
    console.error('❌ Migration 023 failed:', err.message);
    process.exit(1);
  }
}

run();
