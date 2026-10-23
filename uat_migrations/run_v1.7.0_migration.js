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
  console.log('|  UAT Migration Runner v1.7.0                     |');
  console.log('====================================================');
  console.log('Target: ', poolConfig.connectionString ? poolConfig.connectionString.replace(/:[^:@]+@/, ':***@') : `${poolConfig.user}@${poolConfig.host}:${poolConfig.port}/${poolConfig.database}`);
  console.log('====================================================\n');

  const sqlFilePath = path.resolve(__dirname, 'v1.7.0_uat_migration.sql');
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
    const permRes = await client.query(`
      SELECT permission_key, label, ui_type, sort_order
      FROM organization_permission_keys
      WHERE permission_key = 'MANAGE_COMPANY_DETAILS'
    `);

    if (permRes.rowCount > 0 && permRes.rows[0].sort_order > 0) {
      console.log('Verification PASS: MANAGE_COMPANY_DETAILS promoted to dynamic key:');
      console.log(permRes.rows[0]);
    } else {
      console.error('Verification FAIL: Unexpected permission state:', permRes.rows);
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
