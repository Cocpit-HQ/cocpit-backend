const { Pool } = require('pg');
require('dotenv').config({ path: 'C:\\Users\\user3\\Desktop\\cocpit\\cocpit-backend\\.env' });

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

async function runMigration() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Add columns to organizations table
    await client.query(`
      ALTER TABLE organizations 
      ADD COLUMN IF NOT EXISTS legal_name VARCHAR(255),
      ADD COLUMN IF NOT EXISTS incorporation_date DATE
    `);

    console.log("Migration successful: Added legal_name and incorporation_date to organizations table.");
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error("Migration failed:", error);
  } finally {
    client.release();
    pool.end();
  }
}

runMigration();
