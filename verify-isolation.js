require('dotenv').config();
const pool = require('./src/db/pool');
const GroupChatService = require('./src/services/groupChat.service');

async function verifyIsolation() {
    console.log("🚀 Starting Membership-Based Visibility Restored Verification...");

    try {
        const usersRes = await pool.query("SELECT user_id FROM users LIMIT 3");
        if (usersRes.rowCount < 3) {
            console.error("❌ Need at least 3 users");
            return;
        }
        const adminId = usersRes.rows[0].user_id;
        const member1Id = usersRes.rows[1].user_id;
        const member2Id = usersRes.rows[2].user_id;

        console.log("📁 Creating group and inviting M1...");
        const group = await GroupChatService.createGroup(adminId, {
            name: "Membership Restored Test",
            members: [member1Id]
        });
        const groupId = group.conversation_id;

        // M1 joins
        const invitations = await GroupChatService.getPendingInvitations(member1Id);
        const inv1 = invitations.find(i => i.conversation_id === groupId);
        await GroupChatService.acceptInvitation(member1Id, inv1.invitation_id);

        // M1 leaves
        console.log(`🏃 Member 1 is leaving...`);
        await GroupChatService.leaveGroup(member1Id, groupId);

        // Invite M2 AFTER M1 left
        console.log("📩 Inviting Member 2 (M2) AFTER M1 left...");
        await GroupChatService.inviteMember(adminId, groupId, member2Id);
        const inv2 = (await GroupChatService.getPendingInvitations(member2Id)).find(i => i.conversation_id === groupId);
        await GroupChatService.acceptInvitation(member2Id, inv2.invitation_id);

        // 5. TEST: Inactive user tries to send a message (should fail)
        console.log("🚫 Testing backend blocking: Inactive user sending message...");
        try {
            await GroupChatService.sendMessage(member1Id, groupId, "I should not be able to send this", 'text');
            console.error("❌ FAILURE: Inactive user successfully sent a message!");
        } catch (err) {
            if (err.message === "User is not a member of this group") {
                console.log("✅ SUCCESS: Backend blocked message from inactive user.");
            } else {
                console.error(`❌ FAILURE: Unexpected error: ${err.message}`);
            }
        }

        // 6. Verify Member 1 snapshot (Admins, M1, but NO M2)
        console.log("🧐 Verifying M1's historical membership snapshot...");
        const details = await GroupChatService.getGroupDetails(member1Id, groupId);

        const memberIds = details.members.map(m => m.user_id);
        console.log("📦 M1's Member List:", memberIds);

        if (memberIds.includes(adminId) && memberIds.includes(member1Id) && !memberIds.includes(member2Id)) {
            console.log("✅ SUCCESS: M1 sees historical members only (Admin, M1)");
        } else {
            console.error("❌ FAILURE: Snapshot logic failed", memberIds);
        }

        console.log("✅ Restored visibility verification complete.");

    } catch (err) {
        console.error("❌ Verification failed:", err.message);
    } finally {
        await pool.end();
    }
}

verifyIsolation();
