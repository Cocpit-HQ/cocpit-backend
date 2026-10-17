-- ============================================================================
-- Migration: 012_add_teams_feature_flag
-- Description: Adds feature flag entries for Teams module management.
-- ============================================================================

INSERT INTO feature_flags (flag_key, is_enabled, updated_at)
VALUES 
  ('enableTeamsModule', TRUE, now()),
  ('enableTeams', TRUE, now()),
  ('teams', TRUE, now())
ON CONFLICT (flag_key) DO NOTHING;
