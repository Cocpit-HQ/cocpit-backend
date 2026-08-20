const { Pool } = require('pg');
const pool = new Pool({ user: 'harshada', host: '192.168.1.50', database: 'cocpit_backend', password: 'cocpit@4713', port: 5432 });
async function run() {
  const users = await pool.query("SELECT user_id, full_name, account_name FROM active_users WHERE full_name ILIKE '%Ankita%'");
  const user_id = users.rows[0]?.user_id;

  // Let's call the actual getMyPosts query. I will just query posts with getPostHydrationSelect inline!
  const query = `
        SELECT
            (
                SELECT sp_rep.post_id FROM posts sp_rep
                WHERE sp_rep.shared_post_id = p.shared_post_id 
                AND sp_rep.author_id = $1 AND sp_rep.author_org_id IS NULL
                AND sp_rep.is_active = TRUE
                AND (sp_rep.is_removed IS FALSE OR sp_rep.is_removed IS NULL)
                LIMIT 1
            ) AS test_repost_id,
            p.post_id,
            (
                SELECT json_build_object(
                    'post_id', sp.post_id,
                    'is_reposted', EXISTS(
                        SELECT 1 FROM posts sp_rep
                        WHERE sp_rep.shared_post_id = sp.post_id 
                        AND sp_rep.author_id = $1 AND sp_rep.author_org_id IS NULL
                        AND sp_rep.is_active = TRUE
                        AND (sp_rep.is_removed IS FALSE OR sp_rep.is_removed IS NULL)
                    )
                )
                FROM posts sp
                WHERE sp.post_id = p.shared_post_id
            ) AS shared_post
        FROM posts p
        WHERE p.author_id = $1 AND p.author_org_id IS NULL AND p.is_active = TRUE AND (p.is_removed IS FALSE OR p.is_removed IS NULL)
        ORDER BY p.created_at DESC
        LIMIT 5;
  `;
  const res = await pool.query(query, [user_id]);
  console.log(JSON.stringify(res.rows, null, 2));
  pool.end();
}
run();
