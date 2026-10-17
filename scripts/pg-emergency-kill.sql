-- ══════════════════════════════════════════════════════════════════════════════
-- COCPIT — Emergency PostgreSQL Connection Recovery Script
-- Run this INSTEAD of restarting the Postgres service when the DB stops responding
-- Usage: psql -U swaroop -d cocpit_backend -h 192.168.1.50 -f pg-emergency-kill.sql
-- ══════════════════════════════════════════════════════════════════════════════

-- STEP 1: Diagnose — see what is holding connections
SELECT state, wait_event_type, wait_event, count(*) AS count
FROM pg_stat_activity
WHERE pid <> pg_backend_pid()
GROUP BY state, wait_event_type, wait_event
ORDER BY count DESC;

-- STEP 2: Long-running queries > 30 seconds
SELECT pid, usename, state, wait_event_type, wait_event,
  now() - query_start AS duration, left(query, 120) AS query_preview
FROM pg_stat_activity
WHERE (now() - query_start) > interval '30 seconds'
  AND pid <> pg_backend_pid()
ORDER BY duration DESC;

-- STEP 3: Blocked queries
SELECT pid, usename, pg_blocking_pids(pid) AS blocked_by, state, left(query, 120) AS query_preview
FROM pg_stat_activity
WHERE cardinality(pg_blocking_pids(pid)) > 0;

-- STEP 4: Kill idle connections idle > 2 minutes (safe)
SELECT pg_terminate_backend(pid), pid, usename, state,
  now() - state_change AS idle_duration
FROM pg_stat_activity
WHERE state = 'idle'
  AND state_change < now() - interval '2 minutes'
  AND pid <> pg_backend_pid();

-- STEP 5: Kill idle-in-transaction stuck > 2 minutes (safe)
SELECT pg_terminate_backend(pid), pid, usename, state,
  now() - query_start AS stuck_duration, left(query, 120) AS last_query
FROM pg_stat_activity
WHERE state = 'idle in transaction'
  AND query_start < now() - interval '2 minutes'
  AND pid <> pg_backend_pid();

-- STEP 6: Verify — connections remaining
SELECT count(*) AS remaining_connections, state
FROM pg_stat_activity
WHERE pid <> pg_backend_pid()
GROUP BY state
ORDER BY remaining_connections DESC;
