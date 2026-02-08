require('dotenv').config();
const pool = require('../src/db/pool');

const userId = '5bc56581-558e-4c6b-a0f3-01f2638b3eef';
const groupId = '58e4d998-e4c6-4f5b-a42d-16fc4f8e424b';

async function check() {
    try {
        console.log(`Checking membership for User: ${userId} in Group: ${groupId}`);

        // Check User
        const userRes = await pool.query('SELECT * FROM users WHERE user_id = $1', [userId]);
        console.log('User found:', userRes.rowCount > 0);

        // Check Group
        const groupRes = await pool.query('SELECT * FROM conversations WHERE conversation_id = $1', [groupId]);
        console.log('Group found:', groupRes.rowCount > 0);

        // Check Membership
        const memberRes = await pool.query('SELECT * FROM conversation_participants WHERE conversation_id = $1', [groupId]);
        console.log('Members found:', memberRes.rows);

    } catch (err) {
        console.error(err);
    } finally {
        pool.end();
    }
}

check();
