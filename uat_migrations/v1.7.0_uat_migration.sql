-- ==============================================================================
-- UAT Migration v1.7.0
-- Target Database: cocpit_backend_uat (also applied to staging/dev)
-- Prepared Date:  2026-10-19
-- Description: Promote MANAGE_COMPANY_DETAILS from system-only key to dynamic UI checklist key
--              allowing organization admins to assign company profile edit access via custom roles.
--
-- Changes Included:
--   1. organization_permission_keys: Update sort_order = 20, label = 'Edit company profile'
--      for 'MANAGE_COMPANY_DETAILS' so it appears in dynamic roles checklist and is permitted in custom roles.
-- ==============================================================================

BEGIN;

INSERT INTO organization_permission_keys (
    permission_key,
    label,
    ui_type,
    parent_key,
    requires_parent,
    sort_order
)
VALUES (
    'MANAGE_COMPANY_DETAILS',
    'Edit company profile',
    'toggle',
    NULL,
    FALSE,
    20
)
ON CONFLICT (permission_key) DO UPDATE
SET sort_order = 20,
    label = 'Edit company profile',
    ui_type = 'toggle',
    requires_parent = FALSE,
    parent_key = NULL;

COMMIT;
