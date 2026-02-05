const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const pool = require('../src/db/pool');

console.log("DB_USER:", process.env.DB_USER);
console.log("DB_PASSWORD present:", !!process.env.DB_PASSWORD);

async function checkInvitations() {
    try {
        // 1. Find user 'ruby'
        console.log("Searching for user 'ruby'...");
        const userRes = await pool.query("SELECT user_id, full_name, account_name FROM users WHERE full_name ILIKE '%ruby%' OR account_name ILIKE '%ruby%'");
        if (userRes.rowCount === 0) {
            console.log("User 'ruby' not found.");
            return;
        }

        console.log("Found users matching 'ruby':");
        userRes.rows.forEach(u => console.log(`- ${u.full_name} (@${u.account_name}) ID: ${u.user_id}`));

        const rubyId = userRes.rows[0].user_id;

        // 2. Check invitations for this user (USING MODEL QUERY)
        console.log(`\nChecking pending invitations for first 'ruby' (ID: ${rubyId})...`);
        const invRes = await pool.query(
            `SELECT gi.invitation_id, gi.conversation_id, gi.status, gi.created_at,
              COALESCE(c.conversation_name, 'Unnamed Group') as group_name, 
              COALESCE(c.group_avatar, c.avatar_url) as group_avatar,
              u.full_name as inviter_name
       FROM group_invitations gi
       LEFT JOIN conversations c ON gi.conversation_id = c.conversation_id
       LEFT JOIN users u ON gi.inviter_id = u.user_id
       WHERE gi.invitee_id = $1 AND gi.status = 'pending'`,
            [rubyId]
        );

        if (invRes.rowCount === 0) {
            console.log("No invitations found for this user using Model Query.");
        } else {
            console.log("Invitations found (Model Query):");
            console.log(invRes.rows);
        }

        // 3. Check ALL pending invitations just in case
        console.log("\nChecking ALL pending invitations in DB (Top 10)...");
        const allInvRes = await pool.query("SELECT * FROM group_invitations WHERE status = 'pending' LIMIT 10");
        console.log(allInvRes.rows);

    } catch (err) {
        console.error(err);
    } finally {
        pool.end();
    }
}

checkInvitations();
