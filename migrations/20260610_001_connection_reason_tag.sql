-- =============================================================================
-- Migration: 20260610_001_connection_reason_tag
-- Description: Adds reason_tag column to connection_requests table to support
--              interest-based chip display on the Connection UI (e.g. "Shared
--              interest in Rust programming"). Safe to run multiple times (IF NOT EXISTS).
-- Author: Cocpit Team
-- Date: 2026-06-10
-- =============================================================================

BEGIN;

-- 1. Add reason_tag column to connection_requests
ALTER TABLE connection_requests
  ADD COLUMN IF NOT EXISTS reason_tag TEXT DEFAULT NULL;

COMMENT ON COLUMN connection_requests.reason_tag IS
  'Optional short label explaining the connection suggestion context (e.g. "Shared interest in Rust"). Populated when a request is sent via the suggestions flow.';

COMMIT;
