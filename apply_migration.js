const pool = require('./src/core/db/pool');
async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Add pinned_by_org_id column if not exists
    await client.query(`
      ALTER TABLE post_comments 
      ADD COLUMN IF NOT EXISTS pinned_by_org_id UUID REFERENCES organizations(org_id) ON DELETE SET NULL
    `);

    await client.query('COMMIT');
    console.log("Migration successful");
    process.exit(0);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error("Migration failed:", err);
    process.exit(1);
  } finally {
    client.release();
  }
}
run();
