require('dotenv').config();
const pool = require("./src/db/pool");

async function updateGroupChatSchema() {
    try {
        console.log("Starting Group Chat Schema Updates...");

        // 1. Alter conversations table
        console.log("Checking columns in 'conversations' table...");
        const columnsToCheck = ['conversation_name', 'admin_id', 'group_avatar', 'is_group'];
        // Note: is_group already exists in schema.sql but let's be safe

        await pool.query(`
            ALTER TABLE conversations 
            ADD COLUMN IF NOT EXISTS conversation_name TEXT,
            ADD COLUMN IF NOT EXISTS admin_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
            ADD COLUMN IF NOT EXISTS group_avatar TEXT,
            ADD COLUMN IF NOT EXISTS description TEXT;
        `);
        console.log("Updated 'conversations' table.");

        // 2. Create group_invitations table
        console.log("Creating 'group_invitations' table...");
        await pool.query(`
            CREATE TABLE IF NOT EXISTS group_invitations (
                invitation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                group_id UUID REFERENCES conversations(conversation_id) ON DELETE CASCADE,
                sender_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
                receiver_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
                status TEXT CHECK (status IN ('pending', 'accepted', 'rejected')) DEFAULT 'pending',
                created_at TIMESTAMPTZ DEFAULT now(),
                updated_at TIMESTAMPTZ DEFAULT now(),
                UNIQUE(group_id, receiver_id)
            );
        `);
        console.log("Created 'group_invitations' table.");

        // 3. Add system message type support if needed (or just use convention in text_content)
        // Schema shows 'messages' has 'text_content'. We might need 'message_type'.
        console.log("Checking 'messages' table for 'message_type'...");
        await pool.query(`
            ALTER TABLE messages
            ADD COLUMN IF NOT EXISTS message_type TEXT DEFAULT 'text', -- 'text', 'system', 'image', etc.
            ADD COLUMN IF NOT EXISTS action_type TEXT, -- 'add', 'leave', 'remove'
            ADD COLUMN IF NOT EXISTS target_id UUID REFERENCES users(user_id) ON DELETE SET NULL;
        `);
        console.log("Updated 'messages' table.");

        console.log("All updates completed successfully.");
        process.exit(0);
    } catch (err) {
        console.error("Migration failed:", err);
        process.exit(1);
    }
}

updateGroupChatSchema();
