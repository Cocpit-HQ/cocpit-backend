-- ============================================================================
-- Migration: 03_feature_flags_table
-- Description: Creates the feature_flags table to act as the permanent
--              source of truth for application feature flags.
-- ============================================================================

CREATE TABLE IF NOT EXISTS feature_flags (
    flag_key VARCHAR(100) PRIMARY KEY,
    is_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Note: We only need these basic columns right now. 
-- In the future, we could add 'updated_by' if the admin panel starts 
-- sending the admin user ID in the request payload.
