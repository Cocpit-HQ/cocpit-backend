const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const isUatExplicit = process.env.RUN_UAT === 'true';

let poolConfig;
if (isUatExplicit && (process.env.UAT_DATABASE_URL || process.env.UAT_DB_NAME)) {
  poolConfig = process.env.UAT_DATABASE_URL
    ? { connectionString: process.env.UAT_DATABASE_URL }
    : {
        host: process.env.UAT_DB_HOST || process.env.DB_HOST || 'localhost',
        port: process.env.UAT_DB_PORT ? Number(process.env.UAT_DB_PORT) : 5432,
        user: process.env.UAT_DB_USER || process.env.DB_USER,
        password: process.env.UAT_DB_PASSWORD || process.env.DB_PASSWORD,
        database: process.env.UAT_DB_NAME || 'cocpit_backend_uat',
      };
} else if (process.env.DATABASE_URL && process.env.DATABASE_URL.trim().length > 0) {
  poolConfig = { connectionString: process.env.DATABASE_URL };
} else {
  poolConfig = {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  };
}

const pool = new Pool({
  ...poolConfig,
  connectionTimeoutMillis: 10000,
});

async function runMigration() {
  console.log('====================================================');
  console.log('|  UAT Migration Runner v1.9.0                     |');
  console.log('====================================================');
  console.log(
    'Target: ',
    poolConfig.connectionString
      ? poolConfig.connectionString.replace(/:[^:@]+@/, ':***@')
      : `${poolConfig.user}@${poolConfig.host}:${poolConfig.port}/${poolConfig.database}`
  );
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

    const allPassed =
      foundColumns.length === 3 &&
      indexRes.rowCount > 0 &&
      hasOrgIdCol &&
      foundExpIndexes.length === 2 &&
      jobIdxRes.rowCount > 0 &&
      saveIdxRes.rowCount > 0 &&
      actIdxRes.rowCount > 0;

    if (allPassed) {
      console.log('\nVerification PASS: All v1.9.0 columns, tables, and recommendation indexes verified successfully.');
    } else {
      console.error('\nVerification FAIL: One or more v1.9.0 columns or indexes missing.');
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
