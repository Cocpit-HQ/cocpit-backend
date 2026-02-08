require('dotenv').config();
const pool = require("../src/db/pool");

async function debugChat() {
    try {
        // Find the 'chai_wala' group
        const groupRes = await pool.query("SELECT * FROM conversations WHERE conversation_name = 'chai_wala' AND is_group = TRUE");
        if (groupRes.rowCount === 0) {
            console.log("❌ Group 'chai_wala' not found");
            return;
        }
        const group = groupRes.rows[0];
        console.log("Group:", group.conversation_id, group.conversation_name);

        // Get participants and their joined_at
        const partsRes = await pool.query(
            "SELECT u.full_name, cp.user_id, cp.joined_at, cp.last_read_at FROM conversation_participants cp JOIN users u ON cp.user_id = u.user_id WHERE cp.conversation_id = $1",
            [group.conversation_id]
        );
        console.log("\nParticipants:");
        partsRes.rows.forEach(p => {
            console.log(`- ${p.full_name} (${p.user_id}): Joined: ${new Date(p.joined_at).toISOString()}, Read: ${p.last_read_at ? new Date(p.last_read_at).toISOString() : 'NULL'}`);
        });

        // Get recent messages
        const msgRes = await pool.query(
            "SELECT message_id, created_at, text_content FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 5",
            [group.conversation_id]
        );
        console.log("\nRecent Messages:");
        msgRes.rows.forEach(m => {
            console.log(`- ${m.message_id}: ${new Date(m.created_at).toISOString()} - "${m.text_content}"`);
        });

    } catch (err) {
        console.error("Error:", err);
    } finally {
        pool.end();
    }
}

debugChat();
