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
    await pool.query(`
      ALTER TABLE jobs ALTER COLUMN industry DROP NOT NULL;
    `);
    console.log("Table altered.");
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}
run();
