const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

pool.query(`SELECT id, reporter_id, target_id, reporter_org_id, created_at FROM reports WHERE reporter_id = '3606d096-be60-4ce7-948c-e5eef42cbbd2'`)
  .then(res => { console.log(res.rows); process.exit(0); })
  .catch(console.error);
