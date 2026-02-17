const dotenv = require('dotenv');
dotenv.config();
const pool = require('./src/db/pool');

async function runMigration() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Create saved_folders table
        await client.query(`
      CREATE TABLE IF NOT EXISTS saved_folders (
        folder_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, name)
      );
    `);
        console.log("Created saved_folders table.");

        // 2. Add folder_id to saved_post table
        // Check if column exists first to avoid error on rerun
        const checkColumn = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name='saved_post' AND column_name='folder_id';
    `);

        if (checkColumn.rowCount === 0) {
            await client.query(`
            ALTER TABLE saved_post 
            ADD COLUMN folder_id UUID REFERENCES saved_folders(folder_id) ON DELETE SET NULL;
        `);
            console.log("Added folder_id column to saved_post table.");
        } else {
            console.log("folder_id column already exists in saved_post table.");
        }

        // 3. Add composite unique constraint to allow saving same post to different folders (optional, or just enforce unique post per user regardless of folder?)
        // The prompt says "No duplicate posts inside same folder".
        // Existing constraint likely is UNIQUE(user_id, post_id).
        // If we want to allow saving the same post to multiple folders, we need to drop the old constraint and add a new one including folder_id.
        // HOWEVER, the prompt says "Move posts between folders". This implies a post belongs to ONE folder at a time (or "All Saved" which is NULL).
        // "Allow moving post between folders" usually implies distinct folder assignment.
        // "If post is deleted -> remove from all folders automatically".
        // Let's stick to: One post can be in ONE folder (or NULL). 
        // If I save to "Travel", it moves there.
        // So the existing UNIQUE(user_id, post_id) is actually correct if a post can only be in one folder at a time.
        // Wait, if I want to have a post in "Travel" AND "Inspiration", then I need to remove the unique constraint on (user_id, post_id) and add (user_id, post_id, folder_id).
        // The prompts says: "No duplicate posts inside same folder".
        // "Allow moving post between folders".
        // "Keep a default folder named 'All Saved'".
        // Usually "All Saved" is a virtual view of all posts.
        // If I save to "Travel", does it appear in "All Saved"? Yes.
        // If I save to "Work", does it appear in "All Saved"? Yes.
        // Can I have it in BOTH "Travel" and "Work"? 
        // Instagram Collections allow a post to be in multiple collections.
        // If I want that, I need `saved_post` to be a mapping table: `(id, user_id, post_id, folder_id)`.
        // But currently `saved_post` IS the save record.
        // If I strictly follow "No duplicate posts inside same folder", it implies I CAN have duplicates across DIFFERENT folders.
        // So I should DROP the `user_id, post_id` unique constraint and replace it with `user_id, post_id, folder_id`.
        // Let's check existing constraints.

        await client.query('COMMIT');
        console.log("Migration completed successfully.");
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Migration failed:", err);
    } finally {
        client.release();
        process.exit(); // Exit script
    }
}

runMigration();
