const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const pool = require("../src/db/pool");

async function run() {
    try {
        console.log("🚀 Starting Index Creation...");

        // 1. Feed Pagination Cursor (Public Feed)
        await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_posts_feed_cursor 
      ON posts (created_at DESC, post_id DESC) 
      WHERE visibility = 'public';
    `);
        console.log("✅ Created idx_posts_feed_cursor");

        // 2. Author Filter
        await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_posts_author_id 
      ON posts (author_id);
    `);
        console.log("✅ Created idx_posts_author_id");

        // 3. Post Media Join
        await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_post_media_post_id 
      ON post_media (post_id);
    `);
        console.log("✅ Created idx_post_media_post_id");

        // 4. Post Likes Count
        await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_post_likes_post_id 
      ON post_likes (post_id);
    `);
        console.log("✅ Created idx_post_likes_post_id");

        // 5. Post Comments Count
        await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_post_comments_post_id 
      ON post_comments (post_id);
    `);
        console.log("✅ Created idx_post_comments_post_id");

        // 6. Post Polls Join
        await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_post_polls_post_id 
      ON post_polls (post_id);
    `);
        console.log("✅ Created idx_post_polls_post_id");

        // 7. Shared Post Foreign Key
        await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_posts_shared_post_id 
      ON posts (shared_post_id);
    `);
        console.log("✅ Created idx_posts_shared_post_id");

        // 8. Poll Votes Aggregation (Total Votes)
        await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_poll_votes_poll_id
        ON poll_votes (poll_id);
    `);
        console.log("✅ Created idx_poll_votes_poll_id");

        // 9. Poll Options (For poll structure)
        await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_poll_options_poll_id
        ON poll_options (poll_id);
    `);
        console.log("✅ Created idx_poll_options_poll_id");


        console.log("🎉 All indexes verified/created!");
        process.exit(0);

    } catch (err) {
        console.error("❌ Error creating indexes:", err);
        process.exit(1);
    }
}

run();
