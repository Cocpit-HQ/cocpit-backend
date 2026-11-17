require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const pool = require('../src/core/db/pool');
const fs = require('fs');
const path = require('path');

async function run() {
  try {
    const sqlPath = path.join(__dirname, '022_purge_industry_subtypes.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    console.log('--- Applying Migration 022: Purge industry sub-types from schema ---');
    await pool.query(sql);
    console.log('✅ Migration 022 applied successfully.');

    // Verify columns dropped from industries_master
    const indRes = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'industries_master' 
        AND column_name IN ('parent_id', 'display_order');
    `);
    console.log('✅ Remaining subtype columns in industries_master (should be empty):', indRes.rows);

    // Verify columns dropped from organizations
    const orgRes = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'organizations' 
        AND column_name = 'industry_sub_type_id';
    `);
    console.log('✅ Remaining industry_sub_type_id in organizations (should be empty):', orgRes.rows);

    process.exit(0);
  } catch (err) {
    console.error('❌ Migration 022 failed:', err.message);
    process.exit(1);
  }
}

run();
