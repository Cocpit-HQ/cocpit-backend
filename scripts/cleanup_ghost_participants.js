require("dotenv").config();
const pool = require("../src/db/pool");

async function cleanupGhostParticipants() {
    const client = await pool.connect();
    try {
        console.log("Starting cleanup of ghost participants...");
        await client.query("BEGIN");

        // 1. Count ghosts before deletion
        const countRes = await client.query(`
            SELECT COUNT(*) 
            FROM conversation_participants cp
            LEFT JOIN users u ON cp.user_id = u.user_id
            WHERE u.user_id IS NULL
        `);
        const ghostCount = parseInt(countRes.rows[0].count);
        console.log(`Found ${ghostCount} ghost participants.`);

        if (ghostCount > 0) {
            // 2. Delete ghosts
            const deleteRes = await client.query(`
                DELETE FROM conversation_participants cp
                WHERE NOT EXISTS (
                    SELECT 1 FROM users u WHERE u.user_id = cp.user_id
                )
                RETURNING *
            `);
            console.log(`Deleted ${deleteRes.rowCount} ghost participant rows.`);
        } else {
            console.log("No ghost participants found.");
        }

        await client.query("COMMIT");
        console.log("Cleanup complete.");
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Error during cleanup:", err);
    } finally {
        client.release();
        process.exit();
    }
}

cleanupGhostParticipants();
