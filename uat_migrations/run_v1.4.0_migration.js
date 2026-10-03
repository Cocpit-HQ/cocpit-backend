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
  console.log(`🚀 Starting UAT Migration v1.4.0`);
  console.log(`📦 Target Database: ${targetDb}`);
  console.log(`🖥️  Host:            ${process.env.UAT_DB_HOST || process.env.DB_HOST || 'localhost'}`);
  console.log('====================================================\n');

  const sqlFilePath = path.resolve(__dirname, 'v1.4.0_uat_migration.sql');
  if (!fs.existsSync(sqlFilePath)) {
    throw new Error(`Migration SQL file not found at: ${sqlFilePath}`);
  }

  const sql = fs.readFileSync(sqlFilePath, 'utf8');
  const client = await pool.connect();

  try {
    console.log('⚡ Executing migration queries inside transaction...');
    await client.query(sql);
    console.log('✅ Migration v1.4.0 executed successfully!\n');

    // Verification check
    console.log('🔍 Running verification checks on target database:');

    // 1. Check if index was dropped
    const indexCheck = await client.query(`
      SELECT indexname 
      FROM pg_indexes 
      WHERE tablename = 'experiences' AND indexname = 'idx_one_current_role_per_company'
    `);
    
    if (indexCheck.rows.length === 0) {
      console.log('   - idx_one_current_role_per_company: ✅ DROPPED');
    } else {
      console.log('   - idx_one_current_role_per_company: ❌ STILL EXISTS');
    }

    console.log('\n🎉 UAT Database migration complete!');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
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
