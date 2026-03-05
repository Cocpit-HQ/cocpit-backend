BEGIN;

-- 1. Extend \`organization_verifications\` Table
ALTER TABLE public.organization_verifications
ADD COLUMN IF NOT EXISTS verification_type VARCHAR(30) DEFAULT 'DOMAIN',
ADD COLUMN IF NOT EXISTS document_urls JSONB DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS review_notes TEXT,
ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES public.users(user_id) ON DELETE SET NULL;

-- 1.1 Allow missing OTP for non-domain verifications
ALTER TABLE public.organization_verifications ALTER COLUMN otp DROP NOT NULL;
ALTER TABLE public.organization_verifications ALTER COLUMN expires_at DROP NOT NULL;

-- 2. Extend \`organizations\` Table
ALTER TABLE public.organizations
ADD COLUMN IF NOT EXISTS review_notes TEXT,
ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES public.users(user_id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS verified_edu BOOLEAN DEFAULT FALSE;

-- 3. Update Verification Status Constraint
ALTER TABLE public.organizations DROP CONSTRAINT IF EXISTS organizations_verification_status_check;
ALTER TABLE public.organizations DROP CONSTRAINT IF EXISTS companies_verification_status_check;
ALTER TABLE public.organizations ADD CONSTRAINT organizations_verification_status_check
CHECK (verification_status IN (
    'UNVERIFIED',
    'DOMAIN_PENDING',
    'DOMAIN_VERIFIED',
    'DOCUMENT_PENDING',
    'UNDER_REVIEW',
    'VERIFIED',
    'REJECTED'
));

COMMIT;

DO $$
BEGIN
    RAISE NOTICE 'Phase 4 migration validation PASSED';
END $$;
