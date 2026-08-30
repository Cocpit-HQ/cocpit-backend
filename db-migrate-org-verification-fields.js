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
    console.log("Starting organization verification fields migration...");

    await pool.query(`
      ALTER TABLE organization_verifications 
      ADD COLUMN IF NOT EXISTS legal_name VARCHAR(255),
      ADD COLUMN IF NOT EXISTS incorporation_date DATE;
    `);
    
    console.log("Added legal_name and incorporation_date to organization_verifications.");

  } catch (error) {
    console.error("Migration failed:", error);
    process.exit(1);
  } finally {
    pool.end();
  }
}

run();
