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
    console.log("Starting moderation schema migration...");
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS moderation_actions (
          action_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
          action_type VARCHAR(50) NOT NULL CHECK (action_type IN ('WARNING', 'SUSPENSION', 'BAN', 'CONTENT_REMOVAL', 'UNLIST')),
          reason TEXT NOT NULL,
          message TEXT,
          duration_days INT,
          is_active BOOLEAN DEFAULT TRUE,
          created_by UUID REFERENCES users(user_id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log("Created moderation_actions table.");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS moderation_appeals (
          appeal_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          action_id UUID NOT NULL REFERENCES moderation_actions(action_id) ON DELETE CASCADE,
          user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
          appeal_reason TEXT NOT NULL,
          status VARCHAR(20) DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
          reviewer_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
          reviewer_notes TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          reviewed_at TIMESTAMPTZ
      );
    `);
    console.log("Created moderation_appeals table.");

    console.log("Migration completed successfully.");
  } catch (err) {
    console.error("Migration failed:", err);
  } finally {
    await pool.end();
  }
}
run();
