const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const targetDb = process.env.UAT_DB_NAME || 'cocpit_backend_uat';

const pool = new Pool({
  host: process.env.UAT_DB_HOST || process.env.DB_HOST || 'localhost',
  port: process.env.UAT_DB_PORT ? Number(process.env.UAT_DB_PORT) : (process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432),
  user: process.env.UAT_DB_USER || process.env.DB_USER,
  password: process.env.UAT_DB_PASSWORD || process.env.DB_PASSWORD,
  database: targetDb,
  connectionTimeoutMillis: 10000,
});

async function runMigration() {
  console.log('====================================================');
  console.log('|  UAT Migration Runner v1.8.0                     |');
  console.log('====================================================');
  console.log(`Target Database: ${targetDb}`);
  console.log(`Host:            ${process.env.UAT_DB_HOST || process.env.DB_HOST || 'localhost'}:${process.env.UAT_DB_PORT ? Number(process.env.UAT_DB_PORT) : (process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432)}`);
  console.log(`User:            ${process.env.UAT_DB_USER || process.env.DB_USER}`);
  console.log('====================================================\n');

  const sqlFilePath = path.resolve(__dirname, 'v1.8.0_uat_migration.sql');
  if (!fs.existsSync(sqlFilePath)) {
    throw new Error('Migration SQL file not found at: ' + sqlFilePath);
  }

  const sql = fs.readFileSync(sqlFilePath, 'utf8');
  const client = await pool.connect();

  try {
    console.log('Executing migration SQL...\n');
    await client.query(sql);
    console.log('Migration SQL executed successfully!\n');

    console.log('Running verification checks on target database...\n');

    // 1. Check organization_notification_settings table
    const tableRes = await client.query(`
      SELECT table_name FROM information_schema.tables 
      WHERE table_name = 'organization_notification_settings'
    `);
    console.log(
      '1. Table organization_notification_settings:',
      tableRes.rowCount > 0 ? 'PASS' : 'FAIL'
    );

    // 2. Check organization_notification_settings index
    const indexRes = await client.query(`
      SELECT indexname FROM pg_indexes 
      WHERE tablename = 'organization_notification_settings' 
        AND indexname = 'idx_org_notification_settings_org_id'
    `);
    console.log(
      '2. Index idx_org_notification_settings_org_id:',
      indexRes.rowCount > 0 ? 'PASS' : 'FAIL'
    );

    // 3. Check organization_members.member_id column
    const memberColRes = await client.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'organization_members' AND column_name = 'member_id'
    `);
    console.log(
      '3. Column organization_members.member_id:',
      memberColRes.rowCount > 0 ? 'PASS' : 'FAIL'
    );

    // 4. Check organization_deactivation_history table
    const deactTableRes = await client.query(`
      SELECT table_name FROM information_schema.tables 
      WHERE table_name = 'organization_deactivation_history'
    `);
    console.log(
      '4. Table organization_deactivation_history:',
      deactTableRes.rowCount > 0 ? 'PASS' : 'FAIL'
    );

    // 5. Check organization_deactivation_history index
    const deactIndexRes = await client.query(`
      SELECT indexname FROM pg_indexes 
      WHERE tablename = 'organization_deactivation_history' 
        AND indexname = 'idx_org_deactivation_history_user_unrecovered'
    `);
    console.log(
      '5. Index idx_org_deactivation_history_user_unrecovered:',
      deactIndexRes.rowCount > 0 ? 'PASS' : 'FAIL'
    );

    // 6. Check user_post_feedback.org_id column
    const feedbackColRes = await client.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'user_post_feedback' AND column_name = 'org_id'
    `);
    console.log(
      '6. Column user_post_feedback.org_id:',
      feedbackColRes.rowCount > 0 ? 'PASS' : 'FAIL'
    );

    // 7. Check user_post_feedback org unique index
    const feedbackOrgIndexRes = await client.query(`
      SELECT indexname FROM pg_indexes 
      WHERE tablename = 'user_post_feedback' 
        AND indexname = 'idx_user_post_feedback_org'
    `);
    console.log(
      '7. Index idx_user_post_feedback_org:',
      feedbackOrgIndexRes.rowCount > 0 ? 'PASS' : 'FAIL'
    );

    const allPassed =
      tableRes.rowCount > 0 &&
      indexRes.rowCount > 0 &&
      memberColRes.rowCount > 0 &&
      deactTableRes.rowCount > 0 &&
      deactIndexRes.rowCount > 0 &&
      feedbackColRes.rowCount > 0 &&
      feedbackOrgIndexRes.rowCount > 0;

    if (allPassed) {
      console.log('\nVerification PASS: All v1.8.0 database objects verified successfully.');
    } else {
      console.error('\nVerification FAIL: One or more database objects missing.');
      process.exit(1);
    }
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

runMigration().catch((err) => {
  console.error('Fatal execution error:', err);
  process.exit(1);
});
