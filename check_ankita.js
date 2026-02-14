require('dotenv').config();
const pool = require('./src/db/pool');

async function checkAnkita() {
    const userId = '3606d096-be60-4ce7-948c-e5eef42cbbd2'; // Ankita's user_id from previous check
    try {
        const res = await pool.query(`
      SELECT cp.*, c.is_group, c.conversation_name
      FROM conversation_participants cp
      JOIN conversations c ON cp.conversation_id = c.conversation_id
      WHERE cp.user_id = $1
    `, [userId]);
        console.log(`Conversations for Ankita (${userId}):`);
        console.log(JSON.stringify(res.rows, null, 2));

        if (res.rows.length > 0) {
            const convId = res.rows[0].conversation_id;
            const messages = await pool.query(`
            SELECT COUNT(*) FROM messages WHERE conversation_id = $1
        `, [convId]);
            console.log(`\nMessage count for first conversation (${convId}):`, messages.rows[0].count);
        }

    } catch (err) {
        console.error("Failed to check Ankita:", err);
    } finally {
        await pool.end();
    }
}

checkAnkita();
