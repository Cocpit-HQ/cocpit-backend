require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../core/db/pool');

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, 'migration_post_media_responsive_variants.sql'), 'utf8');
  try {
    await pool.query(sql);
    console.log('✅ Responsive media migration applied successfully.');

    const res = await pool.query(
      "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'post_media' AND column_name IN ('variants', 'hdr_metadata_status') ORDER BY column_name"
    );
    console.log('Verified columns in post_media:');
    console.table(res.rows);
  } finally {
    if (pool.stopHealthCheck) pool.stopHealthCheck();
    await pool.end();
    process.exit(0);
  }
}

main().catch((error) => {
  console.error('Responsive media migration failed:', error);
  process.exit(1);
});
