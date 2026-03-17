const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

async function main() {
  try {
    const users = await pool.query('SELECT user_id, full_name, account_name FROM users LIMIT 2');
    const orgs = await pool.query('SELECT org_id, name, slug FROM organizations LIMIT 2');
    console.log('USERS:', JSON.stringify(users.rows, null, 2));
    console.log('ORGS:', JSON.stringify(orgs.rows, null, 2));
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}

main();
