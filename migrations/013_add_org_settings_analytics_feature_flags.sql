-- ============================================================================
-- Migration: 013_add_org_settings_analytics_feature_flags
-- Description: Adds feature flag entries for Organization Settings and Organization Analytics.
-- ============================================================================

INSERT INTO feature_flags (flag_key, is_enabled, updated_at)
VALUES 
  ('enableOrgSettingsModule', TRUE, now()),
  ('enableOrgSettings', TRUE, now()),
  ('orgSettings', TRUE, now()),
  ('enableOrgAnalyticsModule', TRUE, now()),
  ('enableOrgAnalytics', TRUE, now()),
  ('orgAnalytics', TRUE, now())
ON CONFLICT (flag_key) DO NOTHING;
