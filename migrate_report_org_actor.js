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
    console.log("Starting reports table schema migration...");
    
    await pool.query(`
      ALTER TABLE reports 
      ADD COLUMN IF NOT EXISTS reporter_org_id UUID REFERENCES organizations(org_id) ON DELETE CASCADE;
    `);
    
    console.log("Successfully added reporter_org_id to reports table.");
  } catch (err) {
    console.error("Migration failed:", err);
  } finally {
    await pool.end();
  }
}

run();
