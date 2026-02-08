require('dotenv').config();
const pool = require('../src/db/pool');

const groupId = '58e4d998-e4c6-4f5b-a42d-16fc4f8e424b';
const existingUserId = '5bc56581-558e-4c6b-a0f3-01f2638b3eef';

async function setupSecondMember() {
    try {
        // Find a user who is NOT the existing user
        const userRes = await pool.query('SELECT user_id, full_name FROM users WHERE user_id != $1 LIMIT 1', [existingUserId]);

        if (userRes.rowCount === 0) {
            console.log("No other users found!");
            return;
        }

        const newUser = userRes.rows[0];
        console.log("Selected User:", newUser);

        // Add to group
        await pool.query(
            `INSERT INTO conversation_participants (conversation_id, user_id, joined_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT DO NOTHING`,
            [groupId, newUser.user_id]
        );
        console.log('Member added successfully.');

        // Output User ID for next step
        console.log(`USER_ID_2=${newUser.user_id}`);

    } catch (err) {
        console.error(err);
    } finally {
        pool.end();
    }
}

setupSecondMember();
