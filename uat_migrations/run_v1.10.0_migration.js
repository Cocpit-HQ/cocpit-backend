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
  console.log('|  UAT Migration Runner v1.10.0                    |');
  console.log('====================================================');
  console.log(`Target Database: ${targetDb}`);
  console.log(`Host:            ${process.env.UAT_DB_HOST || process.env.DB_HOST || 'localhost'}:${process.env.UAT_DB_PORT ? Number(process.env.UAT_DB_PORT) : (process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432)}`);
  console.log(`User:            ${process.env.UAT_DB_USER || process.env.DB_USER}`);
  console.log('====================================================\n');

  const sqlFilePath = path.resolve(__dirname, 'v1.10.0_uat_migration.sql');
  if (!fs.existsSync(sqlFilePath)) {
    throw new Error('Migration SQL file not found at: ' + sqlFilePath);
  }

  const sql = fs.readFileSync(sqlFilePath, 'utf8');
  const client = await pool.connect();

  try {
    console.log('Executing v1.10.0 migration SQL...\n');
    await client.query(sql);
    console.log('Migration SQL executed successfully!\n');

    console.log('Running verification checks on target database...\n');

    // 1. Check user_verifications lifecycle columns
    const userVerifRes = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'user_verifications' 
        AND column_name IN ('document_type', 'rejection_reason', 'notes')
    `);
    const foundUserVerifCols = userVerifRes.rows.map(r => r.column_name);
    console.log('1. Columns on user_verifications:');
    console.log('   - document_type:    ', foundUserVerifCols.includes('document_type') ? 'PASS' : 'FAIL');
    console.log('   - rejection_reason: ', foundUserVerifCols.includes('rejection_reason') ? 'PASS' : 'FAIL');
    console.log('   - notes:            ', foundUserVerifCols.includes('notes') ? 'PASS' : 'FAIL');

    // 2. Check organization_documents.status column
    const orgDocsRes = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'organization_documents' AND column_name = 'status'
    `);
    console.log('2. Column organization_documents.status: ', orgDocsRes.rowCount > 0 ? 'PASS' : 'FAIL');

    // 3. Check organizations.sector column & index
    const sectorColRes = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'organizations' AND column_name = 'sector'
    `);
    console.log('3. Column organizations.sector:          ', sectorColRes.rowCount > 0 ? 'PASS' : 'FAIL');

    const sectorIdxRes = await client.query(`
      SELECT indexname FROM pg_indexes 
      WHERE tablename = 'organizations' AND indexname = 'idx_organizations_sector'
    `);
    console.log('   Index idx_organizations_sector:       ', sectorIdxRes.rowCount > 0 ? 'PASS' : 'FAIL');

    // 4. Check trigram indexes on organizations headline & description
    const trgmIdxRes = await client.query(`
      SELECT indexname FROM pg_indexes 
      WHERE tablename = 'organizations' 
        AND indexname IN ('idx_organizations_headline_trgm', 'idx_organizations_description_trgm')
    `);
    const foundTrgmIdxs = trgmIdxRes.rows.map(r => r.indexname);
    console.log('4. Trigram indexes on organizations:');
    console.log('   - idx_organizations_headline_trgm:    ', foundTrgmIdxs.includes('idx_organizations_headline_trgm') ? 'PASS' : 'FAIL');
    console.log('   - idx_organizations_description_trgm: ', foundTrgmIdxs.includes('idx_organizations_description_trgm') ? 'PASS' : 'FAIL');

    // 5. Check purged columns
    const indPurgeRes = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'industries_master' 
        AND column_name IN ('parent_id', 'display_order')
    `);
    console.log('5. Purged subtype columns in industries_master:');
    console.log('   - (parent_id, display_order dropped): ', indPurgeRes.rowCount === 0 ? 'PASS' : 'FAIL');

    const orgPurgeRes = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'organizations' AND column_name = 'industry_sub_type_id'
    `);
    console.log('   - organizations.industry_sub_type_id dropped:', orgPurgeRes.rowCount === 0 ? 'PASS' : 'FAIL');

    // 6. Check views recreation
    const viewsRes = await client.query(`
      SELECT table_name 
      FROM information_schema.views 
      WHERE table_name IN (
        'active_organizations',
        'organization_display_profiles',
        'active_post_likes',
        'active_post_comments',
        'active_comment_likes'
      )
    `);
    const foundViews = viewsRes.rows.map(r => r.table_name);
    console.log('6. Recreated views:');
    console.log('   - active_organizations:          ', foundViews.includes('active_organizations') ? 'PASS' : 'FAIL');
    console.log('   - organization_display_profiles: ', foundViews.includes('organization_display_profiles') ? 'PASS' : 'FAIL');
    console.log('   - active_post_likes:             ', foundViews.includes('active_post_likes') ? 'PASS' : 'FAIL');
    console.log('   - active_post_comments:          ', foundViews.includes('active_post_comments') ? 'PASS' : 'FAIL');
    console.log('   - active_comment_likes:          ', foundViews.includes('active_comment_likes') ? 'PASS' : 'FAIL');

    // 7. Check industries count
    const indCountRes = await client.query('SELECT COUNT(*) FROM industries_master');
    console.log('7. Total industries in industries_master: ', indCountRes.rows[0].count);

    console.log('\n====================================================');
    console.log('  v1.10.0 UAT Migration Completed Successfully!     ');
    console.log('====================================================\n');
  } catch (error) {
    console.error('\n❌ Migration Failed:', error.message);
    if (error.detail) console.error('Detail:', error.detail);
    if (error.hint) console.error('Hint:', error.hint);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

runMigration();
