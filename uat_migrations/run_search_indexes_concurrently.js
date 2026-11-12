/**
 * Production Non-Transactional Runner for Concurrent Search Indexes
 * Targets: cocpit_backend
 * 
 * Safely creates GIN indexes concurrently outside of a transaction block.
 * Explicitly detects and cleans up any pre-existing INVALID indexes (indisvalid = false)
 * before attempting to build.
 */
const { Pool } = require('pg');
const path = require('path');
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

const INDEX_DEFINITIONS = [
  {
    name: 'idx_users_full_name_trgm',
    sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_full_name_trgm ON users USING GIN (full_name gin_trgm_ops);'
  },
  {
    name: 'idx_users_account_name_trgm',
    sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_account_name_trgm ON users USING GIN (account_name gin_trgm_ops);'
  },
  {
    name: 'idx_companies_name_trgm',
    sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_companies_name_trgm ON organizations USING GIN (name gin_trgm_ops);'
  },
  {
    name: 'idx_jobs_title_trgm',
    sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_jobs_title_trgm ON jobs USING GIN (title gin_trgm_ops);'
  },
  {
    name: 'idx_jobs_company_trgm',
    sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_jobs_company_trgm ON jobs USING GIN (company_name gin_trgm_ops);'
  },
  {
    name: 'idx_posts_content_trgm',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_content_trgm ON posts USING GIN (content gin_trgm_ops) 
          WHERE (is_removed IS FALSE OR is_removed IS NULL) AND is_active = TRUE AND visibility = 'public';`
  }
];

async function ensureIndexConcurrently(client, indexDef) {
  const { name, sql } = indexDef;
  console.log(`\nChecking status of index: ${name}...`);

  const checkRes = await client.query(`
    SELECT c.relname, i.indisvalid, i.indisready
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname = $1
  `, [name]);

  if (checkRes.rowCount > 0) {
    const { indisvalid, indisready } = checkRes.rows[0];
    if (indisvalid && indisready) {
      console.log(`✅ Index ${name} already exists and is VALID. Skipping.`);
      return;
    }
    console.warn(`⚠️ Index ${name} exists but is INVALID (indisvalid=${indisvalid}). Dropping concurrently before rebuilding...`);
    await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${name};`);
    console.log(`🗑️ Invalid index ${name} dropped.`);
  }

  console.log(`🔨 Building index ${name} CONCURRENTLY...`);
  await client.query(sql);
  console.log(`✅ Index ${name} built successfully.`);
}

async function run() {
  console.log('====================================================');
  console.log('|  COCPIT Concurrent Index Production Runner       |');
  console.log('====================================================');

  const client = await pool.connect();
  try {
    // 1. Ensure extension (must be created first)
    await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm;');
    console.log('✅ Extension pg_trgm verified.');

    // 2. Build each index sequentially outside of transaction
    for (const indexDef of INDEX_DEFINITIONS) {
      await ensureIndexConcurrently(client, indexDef);
    }

    console.log('\n====================================================');
    console.log('🎉 All search indexes successfully verified/built concurrently.');
    console.log('====================================================');
    process.exit(0);
  } catch (err) {
    console.error('❌ Concurrent index execution failed:', err);
    process.exit(1);
  } finally {
    client.release();
  }
}

run();

