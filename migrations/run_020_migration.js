require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const pool = require('../src/core/db/pool');
const fs = require('fs');
const path = require('path');

async function run() {
  try {
    const sqlPath = path.join(__dirname, '020_add_actively_hiring_and_org_institutes.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    console.log('--- Applying Migration 020: actively_hiring and org institutes ---');
    await pool.query(sql);
    console.log('✅ Migration 020 applied successfully.');

    const rolesRes = await pool.query('SELECT COUNT(*) FROM job_roles_master');
    console.log('✅ Total records in job_roles_master:', rolesRes.rows[0].count);

    const indRes = await pool.query('SELECT COUNT(*) FROM industries_master');
    console.log('✅ Total records in industries_master:', indRes.rows[0].count);

    const colRes = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'jobs' AND column_name = 'actively_hiring'
    `);
    console.log('✅ jobs.actively_hiring column verified:', colRes.rows.length > 0);

    const viewColRes = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'active_organizations' AND column_name = 'campus_location'
    `);
    console.log('✅ active_organizations.campus_location verified:', viewColRes.rows.length > 0);

    process.exit(0);
  } catch (err) {
    console.error('❌ Migration 020 failed:', err.message);
    process.exit(1);
  }
}

run();

