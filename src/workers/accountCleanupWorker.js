const pool = require("../core/db/pool");

/**
 * Account Cleanup Worker
 * Scans for users and organizations where `deletion_execute_at < NOW()`.
 * Follows the 4-category Data Retention Policy to hard-delete, anonymize, or clean up data.
 */
const processCleanups = async () => {
    let client;
    try {
        try {
            client = await pool.connect();
            client.once('error', (err) => {
                console.error("[AccountCleanupWorker] Unexpected client error:", err.message);
            });
        } catch (connErr) {
            console.warn("[AccountCleanupWorker] Database connection unavailable. Skipping sweep.");
            return;
        }

        await client.query("BEGIN");

        // --- 1. CLEAN UP EXPIRED ORGANIZATIONS ---
        const expiredOrgsRes = await client.query(`
            SELECT org_id FROM organizations 
            WHERE is_deleted = TRUE AND deletion_execute_at <= NOW()
        `);

        if (expiredOrgsRes.rowCount > 0) {
            const orgIds = expiredOrgsRes.rows.map(row => row.org_id);
            console.log(`[AccountCleanupWorker] Hard-deleting ${orgIds.length} organizations.`);

            // Category 2: Delete with Cascading Cleanup
            // The DB schema should have ON DELETE CASCADE for most child tables like jobs, posts, members, etc.
            // For now, we perform the hard delete on the parent organizations table.
            await client.query(`
                DELETE FROM organizations WHERE org_id = ANY($1)
            `, [orgIds]);
            
            // Delete associated tokens
            await client.query(`
                DELETE FROM organization_restoration_tokens WHERE org_id = ANY($1)
            `, [orgIds]);
        }

        // --- 2. CLEAN UP EXPIRED USERS ---
        const expiredUsersRes = await client.query(`
            SELECT user_id FROM users 
            WHERE deletion_execute_at <= NOW()
        `);

        if (expiredUsersRes.rowCount > 0) {
            const userIds = expiredUsersRes.rows.map(row => row.user_id);
            console.log(`[AccountCleanupWorker] Hard-deleting ${userIds.length} users.`);

            // Category 3: Preserve for System Integrity (Anonymize)
            await client.query(`
                UPDATE audit_logs SET actor_id = NULL 
                WHERE actor_id = ANY($1)
            `, [userIds]);

            // Category 1 & 2: Delete Completely
            await client.query(`
                DELETE FROM users WHERE user_id = ANY($1)
            `, [userIds]);

            // Delete associated tokens
            await client.query(`
                DELETE FROM account_restoration_tokens WHERE user_id = ANY($1)
            `, [userIds]);
        }

        // --- 3. CLEAN UP EXPIRED TOKENS ---
        await client.query(`
            DELETE FROM account_restoration_tokens WHERE expires_at < NOW()
        `);
        await client.query(`
            DELETE FROM organization_restoration_tokens WHERE expires_at < NOW()
        `);

        await client.query("COMMIT");
    } catch (err) {
        if (client) await client.query("ROLLBACK");
        console.error("[AccountCleanupWorker] Error processing cleanups:", err);
    } finally {
        if (client) client.release();
    }
};

// If run directly via node, run once. If required elsewhere, can be scheduled.
if (require.main === module) {
    processCleanups().then(() => process.exit(0));
}

module.exports = { processCleanups };
