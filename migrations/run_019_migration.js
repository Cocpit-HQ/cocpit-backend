require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const pool = require('../src/core/db/pool');
const fs = require('fs');
const path = require('path');

async function run() {
  try {
    const sqlPath = path.join(__dirname, '019_add_hashtag_search_indexes.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    console.log('--- Applying Migration 019: Hashtag Search GIN and Sorting Indexes ---');
    console.log(sql);
    await pool.query(sql);
    console.log('✅ Migration 019 applied successfully.');

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
        'idx_hashtags_tag_trgm',
        'idx_hashtags_posts_count',
        'idx_hashtags_usage_count',
        'idx_hashtags_created_at',
        'idx_hashtags_last_used_at'
      )
      ORDER BY t.relname, c.relname;
    `;
    const res = await pool.query(checkQuery);
    console.log('📊 Verified Hashtag Search Indexes in PostgreSQL:');
    console.table(res.rows);

    process.exit(0);
  } catch (err) {
    console.error('❌ Migration 019 failed:', err.message);
    process.exit(1);
  }
}

run();

