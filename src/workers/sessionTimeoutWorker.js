/**
 * Session Timeout Worker
 * Sweeps for ACTIVE sessions with last_activity_at > 10 minutes ago.
 * Sets them to TIMED_OUT and emits socket events.
 * Runs every 2 minutes via setInterval.
 */

const pool = require("../core/db/pool");
const socketService = require("../core/infrastructure/socket.service");
const { logAudit } = require("../core/infrastructure/audit.service");

const TIMEOUT_MINUTES = 10;
const SWEEP_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

let intervalId = null;

async function sweepTimedOutSessions() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Find and lock sessions that have timed out
        const result = await client.query(
            `UPDATE organization_chat_sessions
             SET status = 'TIMED_OUT', ended_at = NOW(), end_reason = 'timeout'
             WHERE status = 'ACTIVE'
             AND last_activity_at < NOW() - INTERVAL '${TIMEOUT_MINUTES} minutes'
             RETURNING session_id, conversation_id, org_id, handler_user_id, handler_name_snapshot`
        );

        if (result.rowCount > 0) {
            console.log(`[SessionWorker] Timed out ${result.rowCount} session(s)`);
        }

        // Audit and notify for each timed-out session
        for (const session of result.rows) {
            // Audit log
            await logAudit(client, {
                entityType: 'ORGANIZATION_CHAT_SESSION',
                entityId: session.org_id,
                actorId: null, // System action
                action: 'SESSION_TIMEOUT',
                metadata: {
                    sessionId: session.session_id,
                    conversationId: session.conversation_id,
                    handler: session.handler_user_id
                }
            });
        }

        await client.query('COMMIT');

        // Socket notifications (outside transaction)
        for (const session of result.rows) {
            // Notify the handler
            socketService.notifyUser(session.handler_user_id, 'session_released', {
                conversationId: session.conversation_id,
                sessionId: session.session_id,
                reason: 'timeout'
            });

            // Notify all organization members
            try {
                const members = await pool.query(
                    'SELECT user_id FROM organization_members WHERE org_id = $1 AND status = $2',
                    [session.org_id, 'ACTIVE']
                );
                for (const m of members.rows) {
                    if (m.user_id !== session.handler_user_id) {
                        socketService.notifyUser(m.user_id, 'session_released', {
                            conversationId: session.conversation_id,
                            sessionId: session.session_id,
                            reason: 'timeout'
                        });
                    }
                }
            } catch (notifyErr) {
                console.error(`[SessionWorker] Failed to notify members for session ${session.session_id}:`, notifyErr);
            }
        }

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("[SessionWorker] Sweep error:", err);
    } finally {
        if (client) {
            client.release();
        }
    }
}

function startSessionTimeoutWorker() {
    if (intervalId) {
        console.warn("[SessionWorker] Worker already running");
        return;
    }
    console.log(`[SessionWorker] Started (sweep every ${SWEEP_INTERVAL_MS / 1000}s, timeout ${TIMEOUT_MINUTES}min)`);
    intervalId = setInterval(sweepTimedOutSessions, SWEEP_INTERVAL_MS);

    // Also run once immediately on startup (after a brief delay to let DB connect)
    setTimeout(sweepTimedOutSessions, 5000);
}

function stopSessionTimeoutWorker() {
    if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
        console.log("[SessionWorker] Stopped");
    }
}

module.exports = {
    startSessionTimeoutWorker,
    stopSessionTimeoutWorker,
    // Exposed for testing
    sweepTimedOutSessions,
    TIMEOUT_MINUTES
};
