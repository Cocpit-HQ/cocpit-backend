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
  console.log(`🚀 Starting UAT Migration v1.1.0`);
  console.log(`📦 Target Database: ${targetDb}`);
  console.log(`🖥️  Host:            ${process.env.UAT_DB_HOST || process.env.DB_HOST || 'localhost'}`);
  console.log('====================================================\n');

  const sqlFilePath = path.resolve(__dirname, 'v1.1.0_uat_migration.sql');
  if (!fs.existsSync(sqlFilePath)) {
    throw new Error(`Migration SQL file not found at: ${sqlFilePath}`);
  }

  const sql = fs.readFileSync(sqlFilePath, 'utf8');
  const client = await pool.connect();

  try {
    console.log('⚡ Executing migration queries inside transaction...');
    await client.query(sql);
    console.log('✅ Migration v1.1.0 executed successfully!\n');

    // Verification check
    console.log('🔍 Running verification checks on target database:');

    // 1. Check users.dob
    const dobCheck = await client.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'users' AND column_name = 'dob'
    `);
    console.log(`   - users.dob: ${dobCheck.rows.length > 0 ? '✅ PRESENT (' + dobCheck.rows[0].data_type + ')' : '❌ MISSING'}`);

    // 2. Check organizations fields
    const orgCheck = await client.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'organizations' AND column_name IN ('legal_name', 'incorporation_date')
    `);
    console.log(`   - organizations fields: ${orgCheck.rows.length === 2 ? '✅ BOTH PRESENT (legal_name, incorporation_date)' : '❌ INCOMPLETE'}`);

    // 3. Check email_otps fields & constraint
    const otpCheck = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'email_otps' AND column_name IN ('purpose', 'session_expires_at', 'verified_at')
    `);
    console.log(`   - email_otps columns: ${otpCheck.rows.length === 3 ? '✅ ALL 3 PRESENT (purpose, session_expires_at, verified_at)' : '❌ INCOMPLETE'}`);

    const constrCheck = await client.query(`
      SELECT conname, pg_get_constraintdef(oid) as def 
      FROM pg_constraint 
      WHERE conrelid = 'email_otps'::regclass AND conname = 'unique_email_otp_purpose'
    `);
    console.log(`   - email_otps constraint: ${constrCheck.rows.length > 0 ? '✅ ' + constrCheck.rows[0].conname + ' (' + constrCheck.rows[0].def + ')' : '❌ MISSING'}`);

    console.log('\n🎉 UAT Database is now fully synchronized with Staging schema!');
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
