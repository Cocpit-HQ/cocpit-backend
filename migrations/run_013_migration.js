require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const pool = require('../src/core/db/pool');
const fs = require('fs');
const path = require('path');

async function run() {
  try {
    const sqlPath = path.join(__dirname, '013_add_org_settings_analytics_feature_flags.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    console.log('--- Applying Migration 013 ---');
    console.log(sql);
    await pool.query(sql);
    console.log('✅ Migration applied successfully.');

    const res = await pool.query("SELECT flag_key, is_enabled, updated_at FROM feature_flags WHERE flag_key ILIKE '%org%' ORDER BY flag_key");
    console.log('✅ Organization flags in database:');
    console.table(res.rows);
    process.exit(0);
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  }
}

run();
