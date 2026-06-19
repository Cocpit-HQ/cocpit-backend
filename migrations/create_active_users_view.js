require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const pool = require('../src/core/db/pool');

(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE OR REPLACE VIEW active_users AS 
      SELECT * FROM users 
      WHERE deletion_execute_at IS NULL
    `);

    await client.query('COMMIT');
    console.log('✅ Migration complete: active_users view created.');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('❌ Migration failed:', e.message);
    process.exit(1);
  } finally {
    client.release();
    process.exit(0);
  }
})();
