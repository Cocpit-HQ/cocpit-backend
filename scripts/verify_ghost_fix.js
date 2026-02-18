require("dotenv").config();
const pool = require("../src/db/pool");
const app = require("../src/app"); // Assuming app.js exports express app
// If app is not exported or needs server start, we might need to rely on DB queries mostly.

// We will use direct DB manipulation for setup and controller calls if possible, 
// or just DB queries to verify state after manual/API-simulated actions.
// Actually, calling the controller functions directly or via a mock request is complex.
// Let's use direct DB queries to simulate the state that 'deleteAccount' would produce 
// AND call the deleteAccount function logic (or similar) to test it.

// Better: Test the `deleteAccount` logic by importing the controller? 
// No, controller expects req/res.

// Let's replicate the `deleteAccount` logic in this script to verify it works as expected,
// OR just manually check the DB state after we run a query that *should* have been run.

// Wait, the best way is to actually call the API if possible.
// But we don't have the server running in this script context easily without setup.

// Let's write a script that:
// 1. Creates User A and User B directly in DB.
// 2. Creates a conversation between them.
// 3. Runs the DELETION logic (same SQL as in controller).
// 4. Verifies the participant row is GONE.
// 5. runs the getConversations SQL query to see if it returns "Deleted User".

async function verifyFix() {
    const client = await pool.connect();
    try {
        console.log("Starting verification...");
        await client.query("BEGIN");

        // 1. Create Users
        const userA = await client.query("INSERT INTO users (full_name, email, password_hash) VALUES ('User A', 'usera@test.com', 'hash') RETURNING user_id");
        const userB = await client.query("INSERT INTO users (full_name, email, password_hash) VALUES ('User B', 'userb@test.com', 'hash') RETURNING user_id");

        const idA = userA.rows[0].user_id;
        const idB = userB.rows[0].user_id;
        console.log(`Created Users: A=${idA}, B=${idB}`);

        // 2. Create Conversation
        const conv = await client.query("INSERT INTO conversations (is_group) VALUES (false) RETURNING conversation_id");
        const convId = conv.rows[0].conversation_id;

        await client.query("INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2), ($1, $3)", [convId, idA, idB]);
        console.log(`Created Conversation: ${convId}`);

        // 3. Simulate Delete Logic for User B (The Fix)
        console.log("Simulating deletion of User B...");

        // This is the logic we added to propertly clean up:
        const delPart = await client.query("DELETE FROM conversation_participants WHERE user_id = $1 RETURNING *", [idB]);
        console.log(`Deleted ${delPart.rowCount} participant rows (Expected 1).`);

        const delUser = await client.query("DELETE FROM users WHERE user_id = $1 RETURNING *", [idB]);
        console.log(`Deleted ${delUser.rowCount} user rows (Expected 1).`);

        // 4. Verification 1: Participant row should be gone
        const checkPart = await client.query("SELECT * FROM conversation_participants WHERE user_id = $1", [idB]);
        if (checkPart.rowCount === 0) {
            console.log("✅ SUCCESS: Participant row is completely gone.");
        } else {
            console.error("❌ FAILURE: Participant row still exists!");
        }

        // 5. Verification 2: Get Conversations Query for User A
        // We run the EXACT SQL query from social.controller.js (simplified for test)
        // detailed query is complex, let's just check the critical part: other_user_name derivation
        // logic: LEFT JOIN users u ON cp_other.user_id = u.user_id

        // We need to simulate the join:
        // cp_other for User A's conversation is User B (who is deleted from users table)
        // BUT wait, if we delete the participant row for B, then User A has a conversation with NO other participant?
        // Ah, `getConversations` logic:
        // JOIN conversation_participants cp_other ON c.conversation_id = cp_other.conversation_id AND cp_other.user_id != $1

        // If we deleted User B's participant row, then `cp_other` will be NULL!
        // So User A sees a conversation with... nobody?
        // Let's check `getConversations` SQL again.

        /*
        LEFT JOIN conversation_participants cp_other ON c.conversation_id = cp_other.conversation_id 
            AND cp_other.user_id != $1 AND c.is_group = FALSE
        */

        // If we hard deleted B's participant row, `cp_other` will match NOTHING.
        // So `u.full_name` will be null, but `other_user_name` case:
        /*
        CASE 
            WHEN c.is_group THEN ...
            WHEN u.full_name IS NULL THEN 'Deleted User' <--- This logic relies on `u` being null.
            ELSE u.full_name
        END
        */
        // If `cp_other` is null (because we deleted the row), then `u` (joined on cp_other.user_id) will also be null.
        // So `u.full_name` is null.
        // So it should return 'Deleted User'.

        // Let's verify this specific query logic.
        const query = `
            SELECT 
                c.conversation_id,
                cp_other.user_id as other_id,
                u.full_name,
                CASE 
                    WHEN u.full_name IS NULL THEN 'Deleted User' 
                    ELSE u.full_name 
                END AS other_user_name
            FROM conversations c
            LEFT JOIN conversation_participants cp_other ON c.conversation_id = cp_other.conversation_id 
                AND cp_other.user_id != $1
            LEFT JOIN users u ON cp_other.user_id = u.user_id
            WHERE c.conversation_id = $2
        `;

        const res = await client.query(query, [idA, convId]);
        const row = res.rows[0];
        console.log("Conversation Query Result:", row);

        if (row.other_user_name === 'Deleted User') {
            console.log("✅ SUCCESS: Conversation shows 'Deleted User'.");
        } else {
            console.error(`❌ FAILURE: Conversation shows '${row.other_user_name}'`);
        }

        await client.query("ROLLBACK"); // Clean up test data
        console.log("Test data rolled back.");

    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Verification Error:", err);
    } finally {
        client.release();
        process.exit();
    }
}

verifyFix();
