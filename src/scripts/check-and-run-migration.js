require('dotenv').config();
const pool = require('../core/db/pool');
const fs = require('fs');
const path = require('path');

async function main() {
  const client = await pool.connect();
  try {
    console.log("Checking current post_media columns...");
    const beforeCols = await client.query(`
      SELECT column_name, data_type, column_default, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'post_media'
      ORDER BY ordinal_position
    `);
    console.table(beforeCols.rows);

    const hasProcessingStatus = beforeCols.rows.some(r => r.column_name === 'processing_status');
    const hasFallbackUrl = beforeCols.rows.some(r => r.column_name === 'fallback_url');
    const hasAvifUrl = beforeCols.rows.some(r => r.column_name === 'avif_url');

    console.log(`Current state: processing_status=${hasProcessingStatus}, fallback_url=${hasFallbackUrl}, avif_url=${hasAvifUrl}`);

    if (!hasProcessingStatus || !hasFallbackUrl || !hasAvifUrl) {
      console.log("Applying migration add_post_media_processing_variants.sql...");
      const sqlPath = path.resolve(__dirname, '../../migrations/add_post_media_processing_variants.sql');
      const sql = fs.readFileSync(sqlPath, 'utf8');
      await client.query(sql);
      console.log("Migration executed successfully!");

      const afterCols = await client.query(`
        SELECT column_name, data_type, column_default, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'post_media'
        ORDER BY ordinal_position
      `);
      console.table(afterCols.rows);
    } else {
      console.log("Migration already applied.");
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error("Migration check failed:", err);
  process.exit(1);
});
