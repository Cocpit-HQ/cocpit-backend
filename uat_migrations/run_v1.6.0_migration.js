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
  connectionTimeoutMillis: 5000,
});

async function runMigration() {
  console.log('====================================================');
  console.log('|  UAT Migration Runner v1.6.0                     |');
  console.log('====================================================');
  console.log('Target Database:', targetDb);
  console.log('Host:           ', process.env.UAT_DB_HOST || process.env.DB_HOST || 'localhost');
  console.log('====================================================\n');

  const sqlFilePath = path.resolve(__dirname, 'v1.6.0_uat_migration.sql');
  if (!fs.existsSync(sqlFilePath)) {
    throw new Error('Migration SQL file not found at: ' + sqlFilePath);
  }

  const sql = fs.readFileSync(sqlFilePath, 'utf8');
  const client = await pool.connect();

  try {
    console.log('Executing migration SQL...\n');

    // Split into individual statements by COMMIT; boundary and run each
    const blocks = sql.split(/;\s*\n\s*\n/);
    await client.query(sql);
    console.log('Migration SQL executed successfully!\n');

    // ------------------------------------------------------------------
    // Verification checks
    // ------------------------------------------------------------------
    console.log('Running verification checks on target database...\n');

    // 1. organizations location columns
    const orgLocCols = await client.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'organizations'
        AND column_name IN ('location_formatted', 'location_lat', 'location_lng', 'location_place_id')
    `);
    console.log('1. organizations location columns (' + orgLocCols.rows.length + '/4 present):',
      orgLocCols.rows.length === 4 ? 'PASS' : 'FAIL');

    // 2. organizations location coords index
    const locIdx = await client.query(`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'organizations' AND indexname = 'idx_organizations_location_coords'
    `);
    console.log('2. idx_organizations_location_coords index:',
      locIdx.rows.length > 0 ? 'PASS' : 'FAIL');

    // 3. organizations.headline length
    const headlineCol = await client.query(`
      SELECT character_maximum_length
      FROM information_schema.columns
      WHERE table_name = 'organizations' AND column_name = 'headline'
    `);
    const headlineLen = headlineCol.rows[0]?.character_maximum_length;
    console.log('3. organizations.headline VARCHAR(' + headlineLen + '):',
      headlineLen === 255 ? 'PASS' : 'FAIL (expected 255, got ' + headlineLen + ')');

    // 4. Views recreated
    const views = await client.query(`
      SELECT table_name FROM information_schema.views
      WHERE table_schema = 'public'
        AND table_name IN ('active_organizations', 'active_post_comments', 'active_post_likes', 'active_comment_likes', 'organization_display_profiles')
    `);
    console.log('4. Required views recreated (' + views.rows.length + '/5):',
      views.rows.length === 5 ? 'PASS' : 'FAIL (got: ' + views.rows.map(r => r.table_name).join(', ') + ')');

    // 5. users.mobile_format constraint
    const usersMobileConstr = await client.query(`
      SELECT pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE conrelid = 'users'::regclass AND conname = 'mobile_format'
    `);
    const usersMobileDef = usersMobileConstr.rows[0]?.def || '';
    const usersOk = usersMobileDef.includes('7,15');
    console.log('5. users.mobile_format (7-15 digit nullable):', usersOk ? 'PASS' : 'FAIL (def: ' + usersMobileDef + ')');

    // 6. event_registrations.mobile_format constraint
    const evMobileConstr = await client.query(`
      SELECT pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE conrelid = 'event_registrations'::regclass AND conname = 'mobile_format'
    `);
    const evMobileDef = evMobileConstr.rows[0]?.def || '';
    const evOk = evMobileDef.includes('7,15');
    console.log('6. event_registrations.mobile_format (7-15 digit nullable):', evOk ? 'PASS' : 'FAIL (def: ' + evMobileDef + ')');

    // 7. user_search_history.org_id column
    const searchOrgId = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'user_search_history' AND column_name = 'org_id'
    `);
    console.log('7. user_search_history.org_id column:', searchOrgId.rows.length > 0 ? 'PASS' : 'FAIL');

    // 8. Actor-aware unique index
    const actorIdx = await client.query(`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'user_search_history' AND indexname = 'uq_user_search_history_actor_query'
    `);
    console.log('8. uq_user_search_history_actor_query index:', actorIdx.rows.length > 0 ? 'PASS' : 'FAIL');

    // 9. Actor lookup index
    const actorLookupIdx = await client.query(`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'user_search_history' AND indexname = 'idx_user_search_history_actor_created'
    `);
    console.log('9. idx_user_search_history_actor_created index:', actorLookupIdx.rows.length > 0 ? 'PASS' : 'FAIL');

    // 10. Legacy index removed
    const legacyIdx = await client.query(
      `SELECT indexname FROM pg_indexes
      WHERE tablename = 'user_search_history' AND indexname = 'uq_user_search_history_user_query'`
    );
    console.log('10. Legacy uq_user_search_history_user_query index dropped:', legacyIdx.rows.length === 0 ? 'PASS' : 'FAIL (still exists)');

    // 11. Teams module feature flags
    const flags = await client.query(
      `SELECT flag_key, is_enabled FROM feature_flags WHERE flag_key IN ('enableTeamsModule', 'enableTeams', 'teams')`
    );
    console.log('11. Teams feature flags (' + flags.rows.length + '/3 present):',
      flags.rows.length === 3 ? 'PASS' : 'FAIL (present: ' + flags.rows.map(r => r.flag_key).join(', ') + ')');

    console.log('\nUAT Database v1.6.0 migration complete!');

  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

runMigration().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
