const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const pool = require('../src/db/pool');

async function migrate() {
    const client = await pool.connect();
    try {
        console.log('Starting migration for Post Sharing...');
        await client.query('BEGIN');

        // 1. Add shared_post_id to posts
        console.log('Adding shared_post_id to posts table...');
        await client.query(`
      ALTER TABLE posts 
      ADD COLUMN IF NOT EXISTS shared_post_id UUID REFERENCES posts(post_id);
    `);

        // 2. Add shared_post_id to messages
        console.log('Adding shared_post_id to messages table...');
        await client.query(`
      ALTER TABLE messages 
      ADD COLUMN IF NOT EXISTS shared_post_id UUID REFERENCES posts(post_id);
    `);

        // 3. Add shared_post_id to stories
        console.log('Adding shared_post_id to stories table...');
        await client.query(`
      ALTER TABLE stories 
      ADD COLUMN IF NOT EXISTS shared_post_id UUID REFERENCES posts(post_id);
    `);

        await client.query('COMMIT');
        console.log('✅ Migration successful!');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ Migration failed:', err);
    } finally {
        client.release();
        pool.end();
    }
}

migrate();
