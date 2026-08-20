const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

pool.query(`SELECT org_id, name FROM organizations WHERE org_id IN ('9278b733-99b1-4482-911e-95e66f07cd19', '3c28a0e7-8092-495b-82f0-e69390e6edb3')`)
  .then(res => { console.log(res.rows); process.exit(0); })
  .catch(console.error);
