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
    console.log("Starting document_type migration...");

    await pool.query(`
      ALTER TABLE user_verifications ADD COLUMN IF NOT EXISTS document_type VARCHAR(50);
    `);
    console.log("Added document_type to user_verifications.");

    await pool.query(`
      ALTER TABLE organization_verifications ADD COLUMN IF NOT EXISTS document_type VARCHAR(50);
    `);
    console.log("Added document_type to organization_verifications.");

  } catch (error) {
    console.error("Migration failed:", error);
    process.exit(1);
  } finally {
    pool.end();
  }
}

run();
