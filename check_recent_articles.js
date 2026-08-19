require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

async function run() {
  const res = await pool.query(`
    SELECT post_id, post_type, is_community_article, status, visibility, is_active, created_at, category_id, is_removed
    FROM posts 
    WHERE post_type = 'article' 
    ORDER BY created_at DESC 
    LIMIT 5
  `);
  console.log("Recent articles:", res.rows);
  
  process.exit(0);
}

run();
