-- ============================================================================
-- Migration: 014_add_org_notifications_feature_flag
-- Description: Adds feature flag entries for Organization Notifications.
-- ============================================================================

INSERT INTO feature_flags (flag_key, is_enabled, updated_at)
VALUES 
  ('enableOrgNotificationsModule', TRUE, now()),
  ('enableOrgNotifications', TRUE, now()),
  ('orgNotifications', TRUE, now())
ON CONFLICT (flag_key) DO NOTHING;
