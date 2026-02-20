const pool = require("../db/pool");

/**
 * Worker to process the outbox pattern.
 * This guarantees event emission without tying it directly to the HTTP request transaction.
 */
const processEventOutbox = async () => {
    // We don't want to lock a connection from the pool for a long running polling, 
    // a simple loop on interval is sufficient for this startup size.

    // In production, we'd use SELECT ... FOR UPDATE SKIP LOCKED
    // to allow multiple worker processes to pick off events concurrently.

    let client;
    try {
        client = await pool.connect();
        await client.query("BEGIN");

        // Fetch up to 50 pending events and lock them
        const pendingRes = await client.query(`
            SELECT event_id, topic, payload 
            FROM event_outbox
            WHERE status = 'PENDING'
            ORDER BY created_at ASC
            LIMIT 50
            FOR UPDATE SKIP LOCKED
        `);

        if (pendingRes.rowCount > 0) {
            console.log(`[EventOutboxWorker] Processing ${pendingRes.rowCount} pending events.`);

            for (const event of pendingRes.rows) {
                try {
                    // --- EMIT LOGIC HERE ---
                    // Example:
                    // If topic === 'JOB_POSTED', we could trigger an external service 
                    // or Socket.io namespace to notify candidates.
                    console.log(`[EVENT EMITTED] ${event.topic}`, event.payload);

                    // Mark as processed
                    await client.query(
                        `UPDATE event_outbox SET status = 'PROCESSED', processed_at = NOW() WHERE event_id = $1`,
                        [event.event_id]
                    );

                } catch (emitError) {
                    console.error(`[EventOutboxWorker] Failed to process event ${event.event_id}:`, emitError);
                    // Mark as failed
                    await client.query(
                        `UPDATE event_outbox SET status = 'FAILED', processed_at = NOW() WHERE event_id = $1`,
                        [event.event_id]
                    );
                }
            }
        }

        await client.query("COMMIT");
    } catch (err) {
        if (client) {
            try { await client.query("ROLLBACK"); } catch (e) { }
        }
        console.error("[EventOutboxWorker] Error:", err);
    } finally {
        if (client) client.release();
    }
};

module.exports = {
    processEventOutbox
};
