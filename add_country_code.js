require('dotenv').config();
const pool = require('./src/core/db/pool');

async function main() {
  try {
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS country_code VARCHAR(10) DEFAULT \'+91\';');
    await pool.query('ALTER TABLE organizations ADD COLUMN IF NOT EXISTS country_code VARCHAR(10) DEFAULT \'+91\';');
    console.log('Columns added successfully');
  } catch (error) {
    console.error('Error adding columns:', error);
  } finally {
    pool.end();
  }
}

main();
