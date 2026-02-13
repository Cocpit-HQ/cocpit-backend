require('dotenv').config();
const GroupChatService = require("./src/services/groupChat.service");
const pool = require("./src/db/pool");

async function testAdminPromotion() {
    console.log("🚀 Starting Admin Promotion Test...");

    try {
        // 1. Setup: Find 3 users
        const usersRes = await pool.query("SELECT user_id, email, full_name FROM users LIMIT 3");
        if (usersRes.rowCount < 3) {
            console.error("❌ Need at least 3 users in DB to test.");
            process.exit(1);
        }

        const [user1, user2, user3] = usersRes.rows;
        console.log(`Using users: ${user1.full_name}, ${user2.full_name}, ${user3.full_name}`);

        // 2. Create a group
        const group = await GroupChatService.createGroup(user1.user_id, {
            name: "Promotion Test Group",
            description: "Testing automatic admin promotion",
            avatarUrl: null,
            members: [user2.user_id, user3.user_id]
        });
        const groupId = group.conversation_id;
        console.log(`✅ Group created: ID ${groupId}`);

        // Wait for members to be added (normally async invitations, but createGroup adds admin immediately)
        // Actually members are invited. Let's force add them for testing.
        await pool.query(
            "INSERT INTO conversation_participants (conversation_id, user_id, role, joined_at) VALUES ($1, $2, 'member', now() - interval '1 minute'), ($1, $3, 'member', now())",
            [groupId, user2.user_id, user3.user_id]
        );
        console.log("✅ Members added (user2 is older)");

        // 3. User1 (Admin) leaves
        console.log(`🏃 admin 1 (${user1.full_name}) is leaving...`);
        await GroupChatService.leaveGroup(user1.user_id, groupId);

        // 4. Verify results (Cycle 1)
        let membersRows = await pool.query(
            "SELECT cp.user_id, cp.role, cp.left_at, u.full_name FROM conversation_participants cp JOIN users u ON cp.user_id = u.user_id WHERE cp.conversation_id = $1",
            [groupId]
        );
        let members = membersRows.rows;

        console.log("Current Members Status (Cycle 1):");
        members.forEach(m => console.log(`- ${m.full_name}: role=${m.role}, left_at=${m.left_at}`));

        let newAdmin = members.find(m => m.user_id === user2.user_id);
        if (newAdmin && newAdmin.role === 'admin' && newAdmin.left_at === null) {
            console.log("✅ SUCCESS: user2 (Sakshi) was promoted to admin!");
        } else {
            console.error("❌ FAILURE: user2 was not promoted to admin.");
        }

        // Verify admin_id update
        let groupRes = await pool.query("SELECT admin_id FROM conversations WHERE conversation_id = $1", [groupId]);
        if (groupRes.rows[0].admin_id === user2.user_id) {
            console.log("✅ SUCCESS: conversations.admin_id transferred to user2.");
        } else {
            console.error(`❌ FAILURE: admin_id is ${groupRes.rows[0].admin_id}, expected ${user2.user_id}`);
        }

        // 5. CYCLE 2: User2 (New Admin) leaves
        console.log(`🏃 admin 2 (${user2.full_name}) is leaving...`);
        await GroupChatService.leaveGroup(user2.user_id, groupId);

        // 6. Verify results (Cycle 2)
        membersRows = await pool.query(
            "SELECT cp.user_id, cp.role, cp.left_at, u.full_name FROM conversation_participants cp JOIN users u ON cp.user_id = u.user_id WHERE cp.conversation_id = $1",
            [groupId]
        );
        members = membersRows.rows;

        console.log("Current Members Status (Cycle 2):");
        members.forEach(m => console.log(`- ${m.full_name}: role=${m.role}, left_at=${m.left_at}`));

        let finalAdmin = members.find(m => m.user_id === user3.user_id);
        if (finalAdmin && finalAdmin.role === 'admin' && finalAdmin.left_at === null) {
            console.log("✅ SUCCESS: user3 (Swaroop) was promoted to admin recursively!");
        } else {
            console.error("❌ FAILURE: user3 was not promoted to admin.");
        }

        // Verify admin_id update again
        groupRes = await pool.query("SELECT admin_id FROM conversations WHERE conversation_id = $1", [groupId]);
        if (groupRes.rows[0].admin_id === user3.user_id) {
            console.log("✅ SUCCESS: conversations.admin_id transferred to user3.");
        } else {
            console.error(`❌ FAILURE: admin_id is ${groupRes.rows[0].admin_id}, expected ${user3.user_id}`);
        }

    } catch (err) {
        console.error("💥 Test Failed:", err);
    } finally {
        process.exit(0);
    }
}

testAdminPromotion();
