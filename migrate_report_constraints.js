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
    console.log("Starting constraint migration...");
    
    // Drop the old unique constraint
    await pool.query(`ALTER TABLE reports DROP CONSTRAINT IF EXISTS reports_reporter_id_target_type_target_id_key;`);
    
    // Create new partial unique indexes to correctly handle reporter_org_id
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS reports_unique_user 
      ON reports (reporter_id, target_type, target_id) 
      WHERE reporter_org_id IS NULL;
    `);

    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS reports_unique_org 
      ON reports (reporter_id, target_type, target_id, reporter_org_id) 
      WHERE reporter_org_id IS NOT NULL;
    `);
    
    console.log("Successfully updated unique constraints on reports table.");
  } catch (err) {
    console.error("Migration failed:", err);
  } finally {
    await pool.end();
  }
}

run();
