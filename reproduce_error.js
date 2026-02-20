require('dotenv').config();
const pool = require('./src/db/pool');

async function testInsert() {
    const userId = (await pool.query("SELECT user_id FROM users LIMIT 1")).rows[0].user_id;
    const storyData = {
        title: "Test Video",
        media_url: "https://example.com/test.mp4",
        description: "Test Video",
        media_type: "video",
        public_id: "test_video",
        media_status: "processing",
        story_metadata: { layers: [] }
    };


    try {
        const result = await pool.query(
            `
            INSERT INTO stories (author_id, title, description, media_url, original_url, final_url, media_type, expires_at, media_status, render_status, cld_public_id, shared_post_id, story_metadata, author_company_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, now() + interval '24 hours', $8, $9, $10, $11, $12, $13)
            RETURNING story_id, created_at
            `,
            [
                userId,
                storyData.title,
                storyData.description,
                storyData.media_url,
                storyData.media_url,
                storyData.media_url,
                storyData.media_type,
                "processing",
                "rendering",
                storyData.public_id,


                null,
                storyData.story_metadata,
                null
            ]
        );
        console.log("Success:", result.rows[0]);
    } catch (e) {
        console.error("FAILED:", e.message);
        console.error(e);
    } finally {
        await pool.end();
    }
}

testInsert();
