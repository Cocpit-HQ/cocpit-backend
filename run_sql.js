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
    console.log("Starting migration...");
    
    // 1. Set default for expires_at
    await pool.query(`
      ALTER TABLE job_offers ALTER COLUMN expires_at SET DEFAULT (now() + INTERVAL '30 days');
    `);
    console.log("Set default expires_at on job_offers.");

    // 2. Backfill existing offers
    await pool.query(`
      UPDATE job_offers SET expires_at = created_at + INTERVAL '30 days' WHERE expires_at IS NULL;
    `);
    console.log("Backfilled existing NULL expires_at values.");

    // 3. Create Trigger Function
    await pool.query(`
      CREATE OR REPLACE FUNCTION update_offer_expiry_on_job_close()
      RETURNS TRIGGER AS $$
      BEGIN
          IF NEW.status = 'CLOSED' AND (OLD.status IS DISTINCT FROM 'CLOSED') THEN
              UPDATE job_offers
              SET expires_at = LEAST(expires_at, NOW() + INTERVAL '10 days')
              WHERE job_id = NEW.job_id AND status = 'pending';
          END IF;
          RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    console.log("Created/replaced trigger function update_offer_expiry_on_job_close.");

    // 4. Create Trigger
    await pool.query(`
      DROP TRIGGER IF EXISTS trg_update_offer_expiry_on_job_close ON jobs;
      CREATE TRIGGER trg_update_offer_expiry_on_job_close
      AFTER UPDATE ON jobs
      FOR EACH ROW
      EXECUTE FUNCTION update_offer_expiry_on_job_close();
    `);
    console.log("Created trigger trg_update_offer_expiry_on_job_close.");

    console.log("Migration completed successfully.");
  } catch (err) {
    console.error("Migration failed:", err);
  } finally {
    await pool.end();
  }
}
run();
