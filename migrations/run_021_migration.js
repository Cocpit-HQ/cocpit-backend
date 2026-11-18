require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const pool = require('../src/core/db/pool');
const fs = require('fs');
const path = require('path');

async function run() {
  try {
    const sqlPath = path.join(__dirname, '021_add_org_headline_desc_trgm_indexes.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    console.log('--- Applying Migration 021: Trigram indexes on organizations headline & description ---');
    await pool.query(sql);
    console.log('✅ Migration 021 applied successfully.');

    const idxRes = await pool.query(`
      SELECT indexname 
      FROM pg_indexes 
      WHERE tablename = 'organizations' 
        AND indexname IN ('idx_organizations_headline_trgm', 'idx_organizations_description_trgm');
    `);
    console.log('✅ Verified indexes created:', idxRes.rows.map(r => r.indexname));

    process.exit(0);
  } catch (err) {
    console.error('❌ Migration 021 failed:', err.message);
    process.exit(1);
  }
}

run();
