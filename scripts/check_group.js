require('dotenv').config();
const pool = require('../src/db/pool');

async function checkGroup() {
    try {
        const res = await pool.query("SELECT * FROM conversations WHERE conversation_name ILIKE '%sakshi%'");
        console.log("Groups found:", res.rows);
        if (res.rows.length > 0) {
            const groupId = res.rows[0].conversation_id;
            console.log("Fetching messages for group:", groupId);
            const msgRes = await pool.query(`
            SELECT m.message_id, m.sender_id, m.text_content, u.full_name as sender_name 
            FROM messages m 
            LEFT JOIN users u ON m.sender_id = u.user_id 
            WHERE conversation_id = $1
        `, [groupId]);
            console.log("Messages:", msgRes.rows);
        }
    } catch (err) {
        console.error(err);
    } finally {
        pool.end();
    }
}

checkGroup();
