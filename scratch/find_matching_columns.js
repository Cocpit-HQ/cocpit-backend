const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

async function run() {
  await client.connect();
  const res = await client.query(`
    SELECT table_name, column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND (
        column_name LIKE '%score%' OR
        column_name LIKE '%match%' OR
        column_name LIKE '%summary%' OR
        column_name LIKE '%strength%' OR
        column_name LIKE '%concern%' OR
        column_name LIKE '%recommend%' OR
        column_name LIKE '%note%' OR
        column_name LIKE '%review%'
      )
    ORDER BY table_name, column_name
  `);
  console.log(JSON.stringify(res.rows, null, 2));
  await client.end();
}

run().catch(console.error);
