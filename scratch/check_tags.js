require('dotenv').config();
const pool = require('../src/core/db/pool');

async function checkTags() {
    try {
        console.log("Checking recently created posts and their tags...");
        
        // 1. Get the latest post by Anushri
        const postQuery = `
            SELECT p.post_id, p.content, u.full_name 
            FROM posts p 
            JOIN users u ON p.author_id = u.user_id 
            WHERE u.full_name ILIKE '%Anushri%' 
            ORDER BY p.created_at DESC 
            LIMIT 1;
        `;
        const postRes = await pool.query(postQuery);
        
        if (postRes.rows.length === 0) {
            console.log("No posts found for Anushri.");
            process.exit(0);
        }
        
        const post = postRes.rows[0];
        console.log(`Found Post ID: ${post.post_id}`);
        console.log(`Content: ${post.content}`);
        
        // 2. Check tags for this post
        const tagsQuery = `
            SELECT pt.tagged_user_id, u.full_name, u.account_name
            FROM post_tags pt
            JOIN users u ON pt.tagged_user_id = u.user_id
            WHERE pt.post_id = $1 AND pt.is_active_tag = true;
        `;
        const tagsRes = await pool.query(tagsQuery, [post.post_id]);
        
        console.log(`Tags count: ${tagsRes.rows.length}`);
        tagsRes.rows.forEach(tag => {
            console.log(`- Tagged: ${tag.full_name} (@${tag.account_name}) [ID: ${tag.tagged_user_id}]`);
        });
        
    } catch (err) {
        console.error("Error checking tags:", err.message);
    } finally {
        process.exit(0);
    }
}

checkTags();
