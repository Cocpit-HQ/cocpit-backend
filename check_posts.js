const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgres://postgres:password@localhost:5432/cocpit' });
pool.query(`SELECT COUNT(*) FROM posts WHERE author_org_id = (SELECT org_id FROM organizations WHERE slug = 'nexsus-global-systems')`).then(res => console.log('count:', res.rows)).catch(console.error).finally(() => pool.end());
