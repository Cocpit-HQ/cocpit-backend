const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});
pool.query(`SELECT conname FROM pg_constraint WHERE conrelid = 'reports'::regclass AND contype = 'u';`)
  .then(res => { console.log(res.rows); process.exit(0); })
  .catch(console.error);
