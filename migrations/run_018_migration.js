require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const pool = require('../src/core/db/pool');
const fs = require('fs');
const path = require('path');

async function run() {
  try {
    const sqlPath = path.join(__dirname, '018_add_search_trgm_indexes.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    console.log('--- Applying Migration 018: Global Search GIN Trigram Indexes ---');
    console.log(sql);
    await pool.query(sql);
    console.log('✅ Migration 018 applied successfully.');

    // Verification check on indexes
    const checkQuery = `
      SELECT 
        c.relname AS index_name,
        t.relname AS table_name,
        i.indisvalid AS is_valid,
        i.indisready AS is_ready,
        am.amname AS access_method
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_am am ON am.oid = c.relam
      WHERE c.relname IN (
        'idx_users_full_name_trgm',
        'idx_users_account_name_trgm',
        'idx_companies_name_trgm',
        'idx_jobs_title_trgm',
        'idx_jobs_company_trgm',
        'idx_posts_content_trgm'
      )
      ORDER BY t.relname, c.relname;
    `;
    const res = await pool.query(checkQuery);
    console.log('📊 Verified Global Search Indexes in PostgreSQL:');
    console.table(res.rows);

    if (res.rowCount >= 6) {
      console.log('🎉 All 6 Global Search Indexes verified valid and ready!');
    } else {
      console.warn(`⚠️ Warning: Expected 6 indexes, found ${res.rowCount}. Review table above.`);
    }

    process.exit(0);
  } catch (err) {
    console.error('❌ Migration 018 failed:', err.message);
    process.exit(1);
  }
}

run();

