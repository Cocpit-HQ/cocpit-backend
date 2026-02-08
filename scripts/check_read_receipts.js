require('dotenv').config();
const pool = require("../src/db/pool");

async function checkReadReceipts() {
    try {
        // 1. Get the chai_wala group
        const groupRes = await pool.query("SELECT conversation_id, conversation_name FROM conversations WHERE conversation_name = 'chai_wala'");
        if (groupRes.rowCount === 0) {
            console.log("Group not found");
            return;
        }
        const groupId = groupRes.rows[0].conversation_id;
        console.log(`Checking group: ${groupRes.rows[0].conversation_name} (${groupId})`);

        // 2. Get the latest message
        const msgRes = await pool.query(`
            SELECT m.message_id, m.text_content, m.sender_id, u.full_name as sender_name, m.created_at
            FROM messages m
            JOIN users u ON m.sender_id = u.user_id
            WHERE m.conversation_id = $1
            ORDER BY m.created_at DESC
            LIMIT 1
        `, [groupId]);

        if (msgRes.rowCount === 0) {
            console.log("No messages found");
            return;
        }

        const message = msgRes.rows[0];
        console.log(`\nLatest Message:
        ID: ${message.message_id}
        Sender: ${message.sender_name}
        Content: "${message.text_content}"
        Time: ${message.created_at}`);

        // 3. Get Read Receipts
        const readRes = await pool.query(`
            SELECT u.full_name, mr.read_at
            FROM message_reads mr
            JOIN users u ON mr.user_id = u.user_id
            WHERE mr.message_id = $1
            ORDER BY mr.read_at ASC
        `, [message.message_id]);

        console.log(`\nRead by (${readRes.rowCount}):`);
        readRes.rows.forEach(r => {
            console.log(`- ${r.full_name} at ${r.read_at}`);
        });

    } catch (err) {
        console.error(err);
    } finally {
        pool.end();
    }
}

checkReadReceipts();
