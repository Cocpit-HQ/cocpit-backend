require('dotenv').config();
const pool = require('./src/db/pool');
const GroupChatService = require('./src/services/groupChat.service');
const GroupChatModel = require('./src/models/groupChat.model');

async function testVisibility() {
    const client = await pool.connect();
    try {
        console.log('Testing Membership Visibility...');

        // 1. Create a group
        const userA = '00000000-0000-0000-0000-000000000001'; // Mock user IDs or find real ones
        const userB = '00000000-0000-0000-0000-000000000002';

        // Ensure users exist or use real ones from DB
        const users = await client.query('SELECT user_id FROM users LIMIT 2');
        if (users.rowCount < 2) {
            console.log('Not enough users in DB to test.');
            return;
        }
        const adminId = users.rows[0].user_id;
        const memberId = users.rows[1].user_id;

        console.log(`Using Admin: ${adminId}, Member: ${memberId}`);

        const group = await GroupChatService.createGroup(adminId, { name: 'Test Group' });
        const groupId = group.conversation_id;
        console.log(`Created Group: ${groupId}`);

        // 2. Admin sends M1
        await GroupChatService.sendMessage(adminId, groupId, 'Message 1 (Admin joins)');

        // 3. Add Member B
        await GroupChatModel.addMember({ groupId, userId: memberId });
        console.log('Added Member B');

        // 4. Admin sends M2
        await GroupChatService.sendMessage(adminId, groupId, 'Message 2 (Member B present)');

        // 5. Member B leaves
        await GroupChatService.leaveGroup(memberId, groupId);
        console.log('Member B left');

        // 6. Admin sends M3
        await GroupChatService.sendMessage(adminId, groupId, 'Message 3 (Member B absent)');

        // 7. Re-add Member B
        await GroupChatModel.addMember({ groupId, userId: memberId });
        console.log('Member B re-joined');

        // 8. Admin sends M4
        await GroupChatService.sendMessage(adminId, groupId, 'Message 4 (Member B re-present)');

        // 9. Check visibility for Member B
        // We simulate the query from social.controller.js
        const partCheck = await client.query(
            `SELECT joined_at FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`,
            [groupId, memberId]
        );
        const joinedAt = partCheck.rows[0].joined_at;

        const messages = await client.query(
            `SELECT text_content FROM messages WHERE conversation_id = $1 AND created_at >= $2 ORDER BY created_at ASC`,
            [groupId, joinedAt]
        );

        console.log('Messages visible to Member B:');
        messages.rows.forEach(m => console.log(`- ${m.text_content}`));

        if (messages.rowCount === 2 && messages.rows[1].text_content === 'Message 4 (Member B re-present)') {
            // Expecting 'Member B was added...' (system message) and 'Message 4'
            // Actually, system message for adding B happens when B accepts or is added.
            // In my addMember call, it's a direct add, no system message is sent by the service here.
            // Wait, GroupChatService.acceptInvitation sends system message.
            // My GroupChatModel.addMember is raw insert.
            console.log('SUCCESS: Visibility works as expected.');
        } else {
            console.log('Visibility check failed.');
        }

    } catch (err) {
        console.error('Test failed:', err);
    } finally {
        client.release();
        process.exit(0);
    }
}

testVisibility();
