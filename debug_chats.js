require('dotenv').config();
const pool = require("./src/db/pool");

async function debugChats() {
    try {
        // 1. Get all users
        const users = await pool.query("SELECT user_id, full_name, email FROM users LIMIT 10");
        console.log("Users:", users.rows);

        // 2. Get all conversations
        const convs = await pool.query("SELECT conversation_id, is_group, conversation_name, last_message FROM conversations LIMIT 10");
        console.log("Conversations:", convs.rows);

        // 3. Get participants count
        const participants = await pool.query("SELECT conversation_id, COUNT(*) as count FROM conversation_participants GROUP BY conversation_id");
        console.log("Participants per conversation:", participants.rows);

        // 4. Check a specific user's conversations (let's pick the first one if possible)
        if (users.rows.length > 0) {
            const userId = users.rows[0].user_id;
            console.log(`\nChecking conversations for user: ${users.rows[0].full_name} (${userId})`);

            const userConvs = await pool.query(`
        SELECT c.conversation_id, cp.joined_at, cp.left_at, cp.last_read_at
        FROM conversation_participants cp
        JOIN conversations c ON cp.conversation_id = c.conversation_id
        WHERE cp.user_id = $1
      `, [userId]);
            console.log("User Conversations:", userConvs.rows);
        }

    } catch (err) {
        console.error("Debug failed:", err);
    } finally {
        await pool.end();
    }
}

debugChats();
