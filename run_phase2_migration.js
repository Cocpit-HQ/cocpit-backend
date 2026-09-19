const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

async function run() {
  try {
    console.log("Starting Phase 2 moderation schema migration...");
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS appeal_tokens (
          token_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          action_id UUID NOT NULL REFERENCES moderation_actions(action_id) ON DELETE CASCADE,
          user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
          token_string VARCHAR(64) NOT NULL UNIQUE,
          expires_at TIMESTAMPTZ NOT NULL,
          is_used BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log("Created appeal_tokens table.");

    console.log("Migration completed successfully.");
  } catch (err) {
    console.error("Migration failed:", err);
  } finally {
    await pool.end();
  }
}
run();
