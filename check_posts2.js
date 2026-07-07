const { Pool } = require('pg');
const pool = new Pool({
  user: 'harshada',
  password: 'cocpit@4713',
  host: '192.168.1.50',
  port: 5432,
  database: 'cocpit_backend'
});

pool.query(`
SELECT p.post_id, p.content, p.created_at, pm.media, p.shared_post_id
FROM posts p
LEFT JOIN (SELECT post_id, json_agg(json_build_object('type', type, 'url', url)) as media FROM post_media GROUP BY post_id) pm ON pm.post_id = p.post_id
WHERE author_org_id = (SELECT org_id FROM organizations WHERE slug = 'nexsus-global-systems')
ORDER BY p.created_at DESC
LIMIT 3
`).then(res => {
  console.log(JSON.stringify(res.rows, null, 2));
}).catch(console.error).finally(() => pool.end());
