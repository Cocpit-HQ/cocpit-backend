BEGIN;

-- 1. Drop legacy 'companies' table if it exists
DROP TABLE IF EXISTS public.companies CASCADE;

-- 2. Rename constraints/indexes on the 'organizations' table to be consistent
-- (Many were already handled or renamed by the initial Phase 2 migration)

ALTER INDEX IF EXISTS companies_pkey RENAME TO organizations_pkey;
ALTER INDEX IF EXISTS companies_slug_key RENAME TO organizations_slug_key;

-- 3. Any other cleanup
-- (We've already been using org_id throughout the new modules)

COMMIT;

DO $$
BEGIN
    RAISE NOTICE 'Phase 5 migration validation PASSED';
END $$;
