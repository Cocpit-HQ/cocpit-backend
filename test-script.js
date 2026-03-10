const { Pool } = require('pg');
const pool = new Pool({ host: '192.168.1.13', port: 5432, database: 'cocpit_backend', user: 'harshada', password: 'cocpit@4713' });

const query = `
SELECT 
  s.story_id, 
  s.media_url, 
  s.shared_post_id, 
  CASE 
      WHEN s.shared_post_id IS NULL THEN NULL
      WHEN (
          (sp.visibility = 'public' AND (sp_cat.name != 'Personal' OR sp_cat.name IS NULL))
          OR (sp.author_id = '3606d096-be60-4ce7-948c-e5eef42cbbd2') -- Mocking current user ID for test
      ) THEN
          json_build_object(
              'is_accessible', true,
              'post_id', sp.post_id,
              'content', sp.content,
              'author', json_build_object(
                  'user_id', sp_u.user_id,
                  'full_name', sp_u.full_name,
                  'avatar_url', sp_u.avatar_url
              ),
              'media', (SELECT json_agg(json_build_object('url', url, 'media_type', media_type)) FROM post_media WHERE post_id = sp.post_id)
          )
      ELSE 
          json_build_object('is_accessible', false, 'reason', 'unknown')
  END AS "sharedPost" 
FROM stories s 
LEFT JOIN posts sp ON s.shared_post_id = sp.post_id 
LEFT JOIN users sp_u ON sp.author_id = sp_u.user_id 
LEFT JOIN post_categories sp_cat ON sp.category_id = sp_cat.category_id 
ORDER BY s.created_at DESC 
LIMIT 1
`;

pool.query(query).then(res => {
    const row = res.rows[0];
    console.log('Story ID:', row.story_id);
    if (row.sharedPost) {
        console.log('sharedPost found!');
        const keys = Object.keys(row.sharedPost);
        const required = ['is_accessible', 'post_id', 'content', 'author', 'media'];
        const missing = required.filter(k => !keys.includes(k));
        if (missing.length === 0) {
            console.log('✅ ALL REQUIRED KEYS PRESENT');
            console.log('Author Name:', row.sharedPost.author.full_name);
            console.log('Media Count:', row.sharedPost.media.length);
        } else {
            console.log('❌ MISSING KEYS:', missing);
        }
    } else {
        console.log('❌ sharedPost NOT FOUND');
    }
    pool.end();
}).catch(e => console.error(e));
