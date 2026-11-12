require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const pool = require('../src/core/db/pool');
const fs = require('fs');
const path = require('path');

async function run() {
  try {
    const sqlPath = path.join(__dirname, '017_create_user_resume_history.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    console.log('--- Applying Migration 017: user_resume_history ---');
    await pool.query(sql);
    console.log('✅ Migration 017 applied successfully.');

    const res = await pool.query('SELECT COUNT(*) FROM user_resume_history');
    console.log('✅ Total records in user_resume_history:', res.rows[0].count);
    process.exit(0);
  } catch (err) {
    console.error('❌ Migration 017 failed:', err.message);
    process.exit(1);
  }
}

run();
