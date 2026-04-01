const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const GroupChatService = require('../src/services/groupChat.service.js');
const GroupChatModel = require('../src/models/groupChat.model.js');
const pool = require('../src/db/pool.js');
 
async function test() {
    try {
        console.log("Checking DB...");
        const res = await pool.query('SELECT conversation_id, conversation_name FROM conversations WHERE is_group = true LIMIT 5');
        console.log(res.rows);

        // Find "final_testing_1"
        const group = await pool.query("SELECT * FROM conversations WHERE conversation_name = 'final_testing_1' LIMIT 1");
        if (group.rows.length === 0) {
            console.log("Group not found");
            return;
        }

        const groupId = group.rows[0].conversation_id;
        console.log("Found Group:", groupId);

        // Get members
        const members = await pool.query("SELECT * FROM conversation_participants WHERE conversation_id = $1", [groupId]);
        console.log("Members raw data:", members.rows);

        // Let's test getGroupDetails for each user
        for (const m of members.rows) {
            console.log(`\n--- Fetching details for user: ${m.user_id} ---`);
            const details = await GroupChatService.getGroupDetails(m.user_id, groupId);
            console.log("is_inactive:", details?.is_inactive);
            console.log("isOwner calculation checking admin_id match...");
            const isOwner = group.rows[0].admin_id && group.rows[0].admin_id.toString() === m.user_id.toString();
            console.log("isOwner:", isOwner);
        }

    } catch (e) {
        console.error(e);
    } finally {
        pool.end();
    }
}
test();
