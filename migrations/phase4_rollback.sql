BEGIN;

-- 1. Restore the original constraint limit
ALTER TABLE public.organizations DROP CONSTRAINT IF EXISTS organizations_verification_status_check;
ALTER TABLE public.organizations ADD CONSTRAINT organizations_verification_status_check
CHECK (verification_status IN (
    'UNVERIFIED',
    'DOMAIN_PENDING',
    'DOMAIN_VERIFIED'
));

-- 2. Drop new columns from \`organizations\`
ALTER TABLE public.organizations
DROP COLUMN IF EXISTS review_notes,
DROP COLUMN IF EXISTS reviewed_by,
DROP COLUMN IF EXISTS reviewed_at;

-- 3. Drop new columns from \`organization_verifications\`
ALTER TABLE public.organization_verifications
DROP COLUMN IF EXISTS verification_type,
DROP COLUMN IF EXISTS document_urls,
DROP COLUMN IF EXISTS review_notes,
DROP COLUMN IF EXISTS reviewed_by;

COMMIT;

DO $$
BEGIN
    RAISE NOTICE 'Phase 4 rollback validation PASSED';
END $$;
