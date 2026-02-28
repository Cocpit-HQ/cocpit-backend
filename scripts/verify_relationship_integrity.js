require('dotenv').config();
const pool = require("../src/db/pool");

async function verifyRelationshipIntegrity() {
    console.log("--- Starting Relationship Integrity Check ---");

    try {
        // 1. Check for orphaned connections (Connection exists but no follower record)
        const orphanedConnections = await pool.query(`
            SELECT cc.company_id, cc.user_id 
            FROM company_connections cc
            LEFT JOIN company_followers cf ON cc.company_id = cf.company_id AND cc.user_id = cf.user_id
            WHERE cf.user_id IS NULL
        `);

        if (orphanedConnections.rowCount > 0) {
            console.error(`[FAIL] Found ${orphanedConnections.rowCount} orphaned connections:`);
            console.table(orphanedConnections.rows);
        } else {
            console.log("[PASS] No orphaned connections found.");
        }

        // 2. Check for accepted requests without a corresponding connection record
        const acceptedRequestsWithoutConnection = await pool.query(`
            SELECT cr.company_id, cr.user_id 
            FROM company_connection_requests cr
            LEFT JOIN company_connections cc ON cr.company_id = cc.company_id AND cr.user_id = cc.user_id
            WHERE cr.status = 'accepted' AND cc.company_id IS NULL
        `);

        if (acceptedRequestsWithoutConnection.rowCount > 0) {
            console.error(`[FAIL] Found ${acceptedRequestsWithoutConnection.rowCount} accepted requests without connection rows:`);
            console.table(acceptedRequestsWithoutConnection.rows);
        } else {
            console.log("[PASS] No stale accepted requests found.");
        }

        // 3. Check for users who are both followers and members (Optional logic check)
        const followersWhoAreMembers = await pool.query(`
            SELECT cf.company_id, cf.user_id 
            FROM company_followers cf
            JOIN company_members cm ON cf.company_id = cm.company_id AND cf.user_id = cm.user_id
        `);
        console.log(`[INFO] Found ${followersWhoAreMembers.rowCount} users who are both followers and members.`);

    } catch (err) {
        console.error("Verification failed:", err);
    } finally {
        pool.end();
    }
}

verifyRelationshipIntegrity();
