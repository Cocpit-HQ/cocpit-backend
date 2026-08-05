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
    console.log("Starting deletion schema migration...");
    
    // 1. Create deletion_batches table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS deletion_batches (
        batch_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        created_by UUID REFERENCES users(user_id) ON DELETE SET NULL,
        type VARCHAR(50) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now()
      );
    `);
    console.log("Created deletion_batches table.");

    // 2. Add columns to users
    await pool.query(`
      ALTER TABLE users 
      ADD COLUMN IF NOT EXISTS deletion_batch_id UUID;
      
      ALTER TABLE users DROP CONSTRAINT IF EXISTS fk_user_deletion_batch;
      ALTER TABLE users ADD CONSTRAINT fk_user_deletion_batch FOREIGN KEY (deletion_batch_id) REFERENCES deletion_batches(batch_id) ON DELETE SET NULL;
    `);
    console.log("Updated users table.");

    // 3. Add columns to organizations
    await pool.query(`
      ALTER TABLE organizations 
      ADD COLUMN IF NOT EXISTS deletion_scheduled_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS deletion_execute_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS deletion_batch_id UUID;
      
      ALTER TABLE organizations DROP CONSTRAINT IF EXISTS fk_org_deletion_batch;
      ALTER TABLE organizations ADD CONSTRAINT fk_org_deletion_batch FOREIGN KEY (deletion_batch_id) REFERENCES deletion_batches(batch_id) ON DELETE SET NULL;
    `);
    console.log("Updated organizations table.");

    // 4. Create organization_restoration_tokens table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS organization_restoration_tokens (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id UUID REFERENCES organizations(org_id) ON DELETE CASCADE,
        token_hash VARCHAR(255) NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT now()
      );
    `);
    console.log("Created organization_restoration_tokens table.");

    // 5. Create active_organizations view
    await pool.query(`
      CREATE OR REPLACE VIEW active_organizations AS
      SELECT * FROM organizations 
      WHERE deletion_execute_at IS NULL AND is_deleted = FALSE;
    `);
    console.log("Created active_organizations view.");

    console.log("Migration completed successfully.");
  } catch (err) {
    console.error("Migration failed:", err);
  } finally {
    await pool.end();
  }
}
run();
