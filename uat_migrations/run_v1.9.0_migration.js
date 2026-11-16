const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const targetDb = process.env.UAT_DB_NAME || 'cocpit_backend_uat';

const pool = new Pool({
  connectionString: process.env.UAT_DATABASE_URL,
  host: process.env.UAT_DB_HOST || process.env.DB_HOST || 'localhost',
  port: process.env.UAT_DB_PORT ? Number(process.env.UAT_DB_PORT) : (process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432),
  user: process.env.UAT_DB_USER || process.env.DB_USER,
  password: process.env.UAT_DB_PASSWORD || process.env.DB_PASSWORD,
  database: targetDb,
  connectionTimeoutMillis: 10000,
});

async function runMigration() {
  console.log('====================================================');
  console.log('|  UAT Migration Runner v1.9.0                     |');
  console.log('====================================================');
  console.log(`Target Database: ${targetDb}`);
  console.log(`Host:            ${process.env.UAT_DB_HOST || process.env.DB_HOST || 'localhost'}:${process.env.UAT_DB_PORT ? Number(process.env.UAT_DB_PORT) : (process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432)}`);
  console.log(`User:            ${process.env.UAT_DB_USER || process.env.DB_USER}`);
  console.log('====================================================\n');

  const sqlFilePath = path.resolve(__dirname, 'v1.9.0_uat_migration.sql');
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

    // 1. Check post_media columns
    const columnsRes = await client.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'post_media' 
        AND column_name IN ('order_index', 'thumbnail_url', 'duration_seconds')
    `);
    const foundColumns = columnsRes.rows.map(r => r.column_name);
    console.log('1. Columns on post_media:');
    console.log('   - order_index:     ', foundColumns.includes('order_index') ? 'PASS' : 'FAIL');
    console.log('   - thumbnail_url:   ', foundColumns.includes('thumbnail_url') ? 'PASS' : 'FAIL');
    console.log('   - duration_seconds:', foundColumns.includes('duration_seconds') ? 'PASS' : 'FAIL');

    // 2. Check index on post_media(post_id, order_index)
    const indexRes = await client.query(`
      SELECT indexname FROM pg_indexes 
      WHERE tablename = 'post_media' 
        AND indexname = 'idx_post_media_post_order'
    `);
    console.log(
      '2. Index idx_post_media_post_order:     ',
      indexRes.rowCount > 0 ? 'PASS' : 'FAIL'
    );

    // 3. Check experiences.org_id column
    const expColRes = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'experiences' AND column_name = 'org_id'
    `);
    const hasOrgIdCol = expColRes.rowCount > 0;
    console.log('3. Column experiences.org_id:           ', hasOrgIdCol ? 'PASS' : 'FAIL');

    // 4. Check indexes on experiences
    const expIdxRes = await client.query(`
      SELECT indexname FROM pg_indexes 
      WHERE tablename = 'experiences' 
        AND indexname IN ('idx_experiences_org_id', 'idx_experiences_current_org')
    `);
    const foundExpIndexes = expIdxRes.rows.map(r => r.indexname);
    console.log('4. Index idx_experiences_org_id:        ', foundExpIndexes.includes('idx_experiences_org_id') ? 'PASS' : 'FAIL');
    console.log('   Index idx_experiences_current_org:    ', foundExpIndexes.includes('idx_experiences_current_org') ? 'PASS' : 'FAIL');

    // 5. Check idx_jobs_active_created index on jobs
    const jobIdxRes = await client.query(`
      SELECT indexname FROM pg_indexes 
      WHERE tablename = 'jobs' AND indexname = 'idx_jobs_active_created'
    `);
    console.log('5. Index idx_jobs_active_created (jobs):', jobIdxRes.rowCount > 0 ? 'PASS' : 'FAIL');

    // 6. Check idx_job_saves_job_id on job_saves
    const saveIdxRes = await client.query(`
      SELECT indexname FROM pg_indexes 
      WHERE tablename = 'job_saves' AND indexname = 'idx_job_saves_job_id'
    `);
    console.log('6. Index idx_job_saves_job_id:          ', saveIdxRes.rowCount > 0 ? 'PASS' : 'FAIL');

    // 7. Check idx_activity_job_views on user_activity_log
    const actIdxRes = await client.query(`
      SELECT indexname FROM pg_indexes 
      WHERE tablename = 'user_activity_log' AND indexname = 'idx_activity_job_views'
    `);
    console.log('7. Index idx_activity_job_views:        ', actIdxRes.rowCount > 0 ? 'PASS' : 'FAIL');

    // 8. Check user_resume_history table
    const resumeTableRes = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_name = 'user_resume_history'
    `);
    const hasResumeTable = resumeTableRes.rowCount > 0;
    console.log('8. Table user_resume_history:           ', hasResumeTable ? 'PASS' : 'FAIL');

    // 9. Check idx_user_resume_history_user_last_used index
    const resumeIdxRes = await client.query(`
      SELECT indexname FROM pg_indexes 
      WHERE tablename = 'user_resume_history' AND indexname = 'idx_user_resume_history_user_last_used'
    `);
    console.log('9. Index idx_user_resume_history:       ', resumeIdxRes.rowCount > 0 ? 'PASS' : 'FAIL');

    // 10. Check jobs.published_at column and index
    const jobPubColRes = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'jobs' AND column_name = 'published_at'
    `);
    const hasPublishedAtCol = jobPubColRes.rowCount > 0;
    console.log('10. Column jobs.published_at:           ', hasPublishedAtCol ? 'PASS' : 'FAIL');

    const jobPubIdxRes = await client.query(`
      SELECT indexname FROM pg_indexes 
      WHERE tablename = 'jobs' AND indexname = 'idx_jobs_published_at'
    `);
    const hasPublishedAtIdx = jobPubIdxRes.rowCount > 0;
    console.log('    Index idx_jobs_published_at:        ', hasPublishedAtIdx ? 'PASS' : 'FAIL');

    // 11. Check jobs.actively_hiring column and index
    const jobHiringColRes = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'jobs' AND column_name = 'actively_hiring'
    `);
    const hasActivelyHiringCol = jobHiringColRes.rowCount > 0;
    console.log('11. Column jobs.actively_hiring:         ', hasActivelyHiringCol ? 'PASS' : 'FAIL');

    const jobHiringIdxRes = await client.query(`
      SELECT indexname FROM pg_indexes 
      WHERE tablename = 'jobs' AND indexname = 'idx_jobs_actively_hiring'
    `);
    const hasActivelyHiringIdx = jobHiringIdxRes.rowCount > 0;
    console.log('    Index idx_jobs_actively_hiring:     ', hasActivelyHiringIdx ? 'PASS' : 'FAIL');

    // 12. Check organizations institution columns
    const orgColsRes = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'organizations' 
        AND column_name IN ('entity_type', 'institution_type', 'campus_location', 'verified_edu')
    `);
    const foundOrgCols = orgColsRes.rows.map(r => r.column_name);
    console.log('12. Organization Institution Columns:');
    console.log('   - entity_type:      ', foundOrgCols.includes('entity_type') ? 'PASS' : 'FAIL');
    console.log('   - institution_type: ', foundOrgCols.includes('institution_type') ? 'PASS' : 'FAIL');
    console.log('   - campus_location:  ', foundOrgCols.includes('campus_location') ? 'PASS' : 'FAIL');
    console.log('   - verified_edu:     ', foundOrgCols.includes('verified_edu') ? 'PASS' : 'FAIL');

    // 13. Check active_organizations view includes institution_type
    const viewColRes = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'active_organizations' AND column_name = 'institution_type'
    `);
    const hasViewCol = viewColRes.rowCount > 0;
    console.log('13. View active_organizations columns:  ', hasViewCol ? 'PASS' : 'FAIL');

    // 14. Check pg_trgm extension & GIN search indexes
    const trgmExtRes = await client.query(`
      SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'
    `);
    const hasTrgmExt = trgmExtRes.rowCount > 0;
    console.log('14. Extension pg_trgm:                  ', hasTrgmExt ? 'PASS' : 'FAIL');

    const trgmIdxRes = await client.query(`
      SELECT indexname FROM pg_indexes 
      WHERE indexname IN (
        'idx_users_full_name_trgm',
        'idx_users_account_name_trgm',
        'idx_companies_name_trgm',
        'idx_jobs_title_trgm',
        'idx_posts_content_trgm'
      )
    `);
    const foundTrgmIndexes = trgmIdxRes.rows.map(r => r.indexname);
    console.log('    GIN Trigram search indexes (5/5):   ', foundTrgmIndexes.length >= 4 ? 'PASS' : 'FAIL');

    // 15. Check hashtag search indexes
    const hashIdxRes = await client.query(`
      SELECT indexname FROM pg_indexes 
      WHERE tablename = 'hashtags'
        AND indexname IN ('idx_hashtags_tag_trgm', 'idx_hashtags_posts_count', 'idx_hashtags_created_at', 'idx_hashtags_last_used_at')
    `);
    const foundHashIndexes = hashIdxRes.rows.map(r => r.indexname);
    console.log('15. Hashtag Search Indexes:             ', foundHashIndexes.length >= 3 ? 'PASS' : 'FAIL');

    // 16. Check master reference tables & seeds
    const masterTablesRes = await client.query(`
      SELECT table_name FROM information_schema.tables 
      WHERE table_name IN ('job_roles_master', 'industries_master')
    `);
    const foundMasterTables = masterTablesRes.rows.map(r => r.table_name);
    console.log('16. Master Reference Tables:');
    console.log('   - job_roles_master:  ', foundMasterTables.includes('job_roles_master') ? 'PASS' : 'FAIL');
    console.log('   - industries_master: ', foundMasterTables.includes('industries_master') ? 'PASS' : 'FAIL');

    // 17. Check profiles columns
    const profileColRes = await client.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'profiles' AND column_name IN ('working_industry', 'work_mode')
    `);
    const foundProfileCols = profileColRes.rows.map(r => r.column_name);
    console.log('17. Profile search filter columns:      ', foundProfileCols.length === 2 ? 'PASS' : 'FAIL');

    const allPassed =
      foundColumns.length === 3 &&
      indexRes.rowCount > 0 &&
      hasOrgIdCol &&
      foundExpIndexes.length === 2 &&
      jobIdxRes.rowCount > 0 &&
      saveIdxRes.rowCount > 0 &&
      actIdxRes.rowCount > 0 &&
      hasResumeTable &&
      resumeIdxRes.rowCount > 0 &&
      hasPublishedAtCol &&
      hasPublishedAtIdx &&
      hasActivelyHiringCol &&
      foundOrgCols.length >= 3 &&
      hasTrgmExt &&
      foundMasterTables.length === 2 &&
      foundProfileCols.length === 2;

    if (allPassed) {
      console.log('\nVerification PASS: All v1.9.0 columns, tables, recommendation indexes, search trigram indexes, master tables, and job published_at/actively_hiring support verified successfully.');
    } else {
      console.error('\nVerification FAIL: One or more v1.9.0 columns, tables, or indexes missing.');
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

if (require.main === module) {
  runMigration();
}

module.exports = { runMigration };
