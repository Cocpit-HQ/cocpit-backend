const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    user: process.env.DB_USER, host: process.env.DB_HOST, database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD, port: process.env.DB_PORT,
});

const userId = '41c52670-6649-49b7-831d-3c884e843718'; // Owner User
const companyId = '6438518f-9a33-4e02-bb7f-357b13dfc6ce'; // Test Company Inc.

async function test() {
    console.log('--- STARTING COMPANY STORY TEST ---');
    const client = await pool.connect();
    try {
        // 1. Create Story as Company
        console.log('1. Creating story as company...');
        const storyRes = await client.query(
            `INSERT INTO stories (author_id, author_company_id, title, media_url, media_type, expires_at)
             VALUES ($1, $2, $3, $4, $5, now() + interval '24 hours')
             RETURNING story_id`,
            [userId, companyId, 'Test Company Story', 'https://example.com/image.jpg', 'image']
        );
        const storyId = storyRes.rows[0].story_id;
        console.log(`   Story created: ${storyId}`);

        // 2. React to Story as Company
        console.log('2. Reacting to story as company...');
        await client.query(
            `INSERT INTO story_reactions (story_id, user_id, reactor_company_id, reaction_type)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (story_id, reactor_company_id) WHERE reactor_company_id IS NOT NULL
             DO UPDATE SET reaction_type = $4`,
            [storyId, userId, companyId, true]
        );
        console.log('   Reaction added.');

        // 3. Comment on Story as Company
        console.log('3. Commenting on story as company...');
        await client.query(
            `INSERT INTO story_comments (story_id, author_id, author_company_id, content)
             VALUES ($1, $2, $3, $4)`,
            [storyId, userId, companyId, 'Company comment test']
        );
        console.log('   Comment added.');

        // 4. Verify Attribution in getGroupedStories-style query
        console.log('4. Verifying attribution...');
        const verifyRes = await client.query(`
            SELECT 
                s.story_id,
                COALESCE(c.name, u.full_name) as author_name,
                COALESCE(c.company_id, u.user_id) as group_key
            FROM stories s
            JOIN users u ON s.author_id = u.user_id
            LEFT JOIN companies c ON s.author_company_id = c.company_id
            WHERE s.story_id = $1
        `, [storyId]);

        const story = verifyRes.rows[0];
        console.log(`   Author Name: ${story.author_name} (Expected: Tech Solutions)`);
        console.log(`   Group Key: ${story.group_key} (Expected: ${companyId})`);

        // 5. Verify Comment Attribution
        console.log('5. Verifying comment attribution...');
        const commentRes = await client.query(`
            SELECT 
                sc.content,
                COALESCE(c.name, u.full_name) as commenter_name
            FROM story_comments sc
            JOIN users u ON sc.author_id = u.user_id
            LEFT JOIN companies c ON sc.author_company_id = c.company_id
            WHERE sc.story_id = $1
        `, [storyId]);

        const comment = commentRes.rows[0];
        console.log(`   Commenter Name: ${comment.commenter_name} (Expected: Tech Solutions)`);

        console.log('--- TEST COMPLETED SUCCESSFULLY ---');

    } catch (err) {
        console.error('Test failed:', err);
    } finally {
        client.release();
        await pool.end();
    }
}

test();
