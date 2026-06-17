require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const pool = require('../src/core/db/pool');

(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS deletion_scheduled_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS deletion_execute_at   TIMESTAMPTZ
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS account_restoration_tokens (
        id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     UUID        NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        token_hash  TEXT        NOT NULL UNIQUE,
        expires_at  TIMESTAMPTZ NOT NULL,
        used_at     TIMESTAMPTZ,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query('COMMIT');
    console.log('✅ Migration complete.');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('❌ Migration failed:', e.message);
    process.exit(1);
  } finally {
    client.release();
    process.exit(0);
  }
})();
