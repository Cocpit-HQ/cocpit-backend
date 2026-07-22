-- Fix column types and names for remaining table sync issues

-- 1. organization_roles: expand name column type
ALTER TABLE organization_roles ALTER COLUMN name TYPE TEXT;

-- 2. organization_invites: expand role column type and update status check constraint
ALTER TABLE organization_invites ALTER COLUMN role TYPE TEXT;
ALTER TABLE organization_invites DROP CONSTRAINT IF EXISTS company_invites_status_check;
ALTER TABLE organization_invites DROP CONSTRAINT IF EXISTS organization_invites_status_check;
ALTER TABLE organization_invites ADD CONSTRAINT organization_invites_status_check 
  CHECK (status::text = ANY (ARRAY['PENDING'::character varying, 'ACCEPTED'::character varying, 'EXPIRED'::character varying, 'CANCELLED'::character varying, 'DECLINED'::character varying, 'REJECTED'::character varying]::text[]));

-- 3. organization_org_follows: fix column name from followed_org_id to following_org_id
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name='organization_org_follows' AND column_name='followed_org_id'
    ) THEN
        ALTER TABLE organization_org_follows RENAME COLUMN followed_org_id TO following_org_id;
    END IF;
END $$;

-- 4. posts: add missing is_active column required by feed hydration engine
ALTER TABLE posts ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
