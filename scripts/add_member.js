require('dotenv').config();
const pool = require('../src/db/pool');

const userId = '5bc56581-558e-4c6b-a0f3-01f2638b3eef';
const groupId = '58e4d998-e4c6-4f5b-a42d-16fc4f8e424b';

async function addMember() {
    try {
        console.log(`Adding User: ${userId} to Group: ${groupId}`);

        await pool.query(
            `INSERT INTO conversation_participants (conversation_id, user_id, joined_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT DO NOTHING`,
            [groupId, userId]
        );
        console.log('Member added successfully.');

    } catch (err) {
        console.error(err);
    } finally {
        pool.end();
    }
}

addMember();
