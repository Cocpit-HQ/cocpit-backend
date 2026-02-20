const pool = require("../db/pool");

/**
 * Worker to automatically expire jobs when their `expires_at` date has passed.
 * It also logs an audit event and queues an outbox event.
 */
const processJobExpirations = async () => {
    let client;
    try {
        client = await pool.connect();
        await client.query("BEGIN");

        // 1. Find jobs that need to expire
        const expiredRes = await client.query(`
            UPDATE jobs 
            SET status = 'EXPIRED'
            WHERE status = 'ACTIVE' AND expires_at <= NOW()
            RETURNING job_id, company_id, title
        `);

        if (expiredRes.rowCount > 0) {
            console.log(`[JobExpiryWorker] Expired ${expiredRes.rowCount} jobs.`);

            // 2. Queue outbox events & audit logs
            for (const job of expiredRes.rows) {

                // System actor for audit, or leave actor_id NULL
                await client.query(
                    `INSERT INTO audit_logs (entity_type, entity_id, action, metadata)
                     VALUES ('COMPANY', $1, 'EXPIRE_JOB', $2)`,
                    [job.company_id, JSON.stringify({ jobId: job.job_id, title: job.title })]
                );

                await client.query(
                    `INSERT INTO event_outbox (topic, payload) VALUES ($1, $2)`,
                    ['JOB_EXPIRED', JSON.stringify({ jobId: job.job_id, companyId: job.company_id })]
                );
            }
        }

        await client.query("COMMIT");
    } catch (err) {
        if (client) {
            try { await client.query("ROLLBACK"); } catch (e) { }
        }
        console.error("[JobExpiryWorker] Error:", err);
    } finally {
        if (client) client.release();
    }
};

module.exports = {
    processJobExpirations
};
