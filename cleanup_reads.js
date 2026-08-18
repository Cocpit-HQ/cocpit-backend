require('dotenv').config();
const pool = require('./src/core/db/pool');

async function run() {
    try {
        const res = await pool.query(`
            DELETE FROM message_reads mr
            USING messages m, conversation_participants cp
            WHERE mr.message_id = m.message_id
              AND m.conversation_id = cp.conversation_id
              AND mr.user_id = cp.user_id
              AND m.created_at < cp.joined_at
            RETURNING mr.message_id, mr.user_id;
        `);
        console.log('Deleted rows:', res.rowCount);
    } catch (e) {
        console.error(e);
    } finally {
        pool.end();
    }
}

run();
