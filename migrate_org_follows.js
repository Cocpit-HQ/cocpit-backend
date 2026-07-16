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
    console.log("Starting migration to add organization follows tables...");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS organization_user_follows (
        org_id UUID REFERENCES organizations(org_id) ON DELETE CASCADE,
        user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (org_id, user_id)
      );

      CREATE INDEX IF NOT EXISTS idx_org_user_follows_org_id ON organization_user_follows(org_id);
    `);
    console.log("Created table organization_user_follows.");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS organization_org_follows (
        follower_org_id UUID REFERENCES organizations(org_id) ON DELETE CASCADE,
        following_org_id UUID REFERENCES organizations(org_id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (follower_org_id, following_org_id),
        CHECK (follower_org_id <> following_org_id)
      );

      CREATE INDEX IF NOT EXISTS idx_org_org_follows_follower ON organization_org_follows(follower_org_id);
    `);
    console.log("Created table organization_org_follows.");

    console.log("Migration completed successfully.");
  } catch (err) {
    console.error("Migration failed:", err);
  } finally {
    await pool.end();
  }
}

run();
