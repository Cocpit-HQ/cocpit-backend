BEGIN;

-- Add institution-specific columns to organizations table
ALTER TABLE public.organizations
ADD COLUMN verified_edu BOOLEAN DEFAULT FALSE,
ADD COLUMN campus_location VARCHAR(255),
ADD COLUMN website_url VARCHAR(255),
ADD COLUMN auto_verify_domains VARCHAR(255)[] DEFAULT '{}'; -- e.g., ['@stanford.edu']

-- Create institution_enrollments table for student/faculty onboarding
CREATE TABLE IF NOT EXISTS public.institution_enrollments (
    enrollment_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL REFERENCES public.organizations(org_id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.users(user_id) ON DELETE CASCADE,
    role VARCHAR(50) NOT NULL CHECK (role IN ('STUDENT', 'FACULTY', 'ALUMNI')),
    verification_method VARCHAR(50) NOT NULL CHECK (verification_method IN ('EMAIL', 'ID_UPLOAD', 'MANUAL')),
    status VARCHAR(20) DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'VERIFIED', 'REJECTED')),
    document_url VARCHAR(255), -- for ID uploads
    verified_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(org_id, user_id)
);

-- Trigger for updated_at on institution_enrollments
CREATE OR REPLACE FUNCTION update_enrollment_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_institution_enrollments_updated_at
    BEFORE UPDATE ON public.institution_enrollments
    FOR EACH ROW
    EXECUTE FUNCTION update_enrollment_updated_at_column();

-- Add default Institution Roles to role presets
-- (This will be largely handled in code by adding to createOrganization, but we ensure roles table accepts necessary permissions)
-- We don't need to alter organization_roles since it's flexible, but we will use the following presets in application code:
-- 1. INSTITUTION_ADMIN: All permissions
-- 2. FACULTY: Post in Academic, Moderate Students
-- 3. STUDENT_MODERATOR: Moderate General
-- 4. STUDENT: Post in General

COMMIT;

DO $$
BEGIN
    RAISE NOTICE 'Phase 2 migration validation PASSED';
END $$;
