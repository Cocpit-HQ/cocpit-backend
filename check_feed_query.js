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
  const query = `
    SELECT p.post_id, p.post_type, p.created_at, p.author_id, p.author_org_id
    FROM posts p
    LEFT JOIN organizations comp ON p.author_org_id = comp.org_id
    WHERE (
        (p.visibility = 'public' AND (p.is_broadcast IS FALSE OR p.is_broadcast IS NULL))
    )
    AND (p.is_removed IS FALSE OR p.is_removed IS NULL)
    AND p.is_active = TRUE
    AND (p.author_org_id IS NULL OR (comp.is_deleted = FALSE AND comp.is_deactivated = FALSE))
    AND p.is_community_article IS NOT TRUE
    AND p.post_type = 'article'
    ORDER BY p.created_at DESC
    LIMIT 10
  `;
  
  const res = await pool.query(query);
  console.log("Articles returned by feed query:");
  console.log(res.rows);
  
  process.exit(0);
}

run();
