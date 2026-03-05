BEGIN;

DROP TRIGGER IF EXISTS update_institution_enrollments_updated_at ON public.institution_enrollments;
DROP FUNCTION IF EXISTS update_enrollment_updated_at_column();

DROP TABLE IF EXISTS public.institution_enrollments CASCADE;

ALTER TABLE public.organizations
DROP COLUMN IF EXISTS verified_edu,
DROP COLUMN IF EXISTS campus_location,
DROP COLUMN IF EXISTS website_url,
DROP COLUMN IF EXISTS auto_verify_domains;

COMMIT;

DO $$
BEGIN
    RAISE NOTICE 'Phase 2 rollback validation PASSED';
END $$;
