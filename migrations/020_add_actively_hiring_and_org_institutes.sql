-- ==============================================================================
-- Migration: 020_add_actively_hiring_and_org_institutes.sql
-- Description:
--   1. Adds actively_hiring column and index on jobs for Company Search filter.
--   2. Ensures organizations institution columns (entity_type, institution_type,
--      campus_location, established_year, verified_edu) are defined and refreshes
--      active_organizations view.
--   3. Idempotent backfill of institution_type from industry for INSTITUTION orgs.
--   4. Ensures master reference tables (job_roles_master, industries_master) exist
--      and populates canonical seed data.
-- ==============================================================================

BEGIN;

-- 1. Jobs: Add actively_hiring column and partial index
ALTER TABLE jobs 
    ADD COLUMN IF NOT EXISTS actively_hiring BOOLEAN DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_jobs_actively_hiring 
    ON jobs(org_id, actively_hiring) 
    WHERE (status = 'ACTIVE' OR is_active = TRUE);

-- 2. Organizations: Add institution columns if missing
ALTER TABLE organizations 
    ADD COLUMN IF NOT EXISTS entity_type VARCHAR(20) DEFAULT 'COMPANY',
    ADD COLUMN IF NOT EXISTS institution_type VARCHAR(50),
    ADD COLUMN IF NOT EXISTS established_year INTEGER,
    ADD COLUMN IF NOT EXISTS campus_location VARCHAR(255),
    ADD COLUMN IF NOT EXISTS verified_edu BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS auto_verify_domains VARCHAR(255)[] DEFAULT '{}';

-- 3. Idempotent backfill: fix institution_type for existing INSTITUTION records
UPDATE organizations
SET institution_type = LOWER(TRIM(industry)),
    industry = NULL
WHERE entity_type = 'INSTITUTION'
  AND institution_type IS NULL
  AND industry IS NOT NULL
  AND TRIM(industry) != '';

-- 4. Recreate active_organizations view to expose the newly added institution columns
CREATE OR REPLACE VIEW active_organizations AS 
SELECT * FROM organizations 
WHERE (is_deleted IS FALSE OR is_deleted IS NULL);

-- 5. Reference Tables: Job Roles Master
CREATE TABLE IF NOT EXISTS job_roles_master (
    role_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    role_name VARCHAR(255) UNIQUE NOT NULL,
    category VARCHAR(100),
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_job_roles_name ON job_roles_master (role_name);

-- 6. Reference Tables: Industries Master
CREATE TABLE IF NOT EXISTS industries_master (
    industry_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    industry_name VARCHAR(255) UNIQUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_industries_name ON industries_master (industry_name);

-- 7. Master Data Seeding: Initial Job Roles
INSERT INTO job_roles_master (role_name, category) VALUES
    ('Founder', 'Leadership'),
    ('CEO', 'Leadership'),
    ('CTO', 'Leadership'),
    ('COO', 'Leadership'),
    ('Director', 'Management'),
    ('Manager', 'Management'),
    ('Executive', 'Management'),
    ('Software Engineer', 'Engineering'),
    ('Frontend Developer', 'Engineering'),
    ('Backend Developer', 'Engineering'),
    ('Full Stack Developer', 'Engineering'),
    ('Mobile Developer', 'Engineering'),
    ('Data Scientist', 'Data'),
    ('Data Analyst', 'Data'),
    ('Machine Learning Engineer', 'Engineering'),
    ('Product Manager', 'Product'),
    ('Project Manager', 'Management'),
    ('UI/UX Designer', 'Design'),
    ('Product Designer', 'Design'),
    ('Graphic Designer', 'Design'),
    ('Marketing Manager', 'Marketing'),
    ('Digital Marketing Specialist', 'Marketing'),
    ('Sales Representative', 'Sales'),
    ('Account Executive', 'Sales'),
    ('Customer Success Manager', 'Customer Support'),
    ('Human Resources Manager', 'HR'),
    ('Recruiter', 'HR'),
    ('Financial Analyst', 'Finance'),
    ('Accountant', 'Finance'),
    ('Business Analyst', 'Business'),
    ('DevOps Engineer', 'Engineering'),
    ('System Administrator', 'IT'),
    ('Technical Support Specialist', 'IT')
ON CONFLICT (role_name) DO NOTHING;

-- 8. Master Data Seeding: Initial Industries
INSERT INTO industries_master (industry_name) VALUES
    ('Information Technology and Services'),
    ('Computer Software'),
    ('Software Development'),
    ('Internet'),
    ('Financial Services'),
    ('Banking'),
    ('Hospital & Health Care'),
    ('Education Management'),
    ('Higher Education'),
    ('E-Learning'),
    ('Marketing and Advertising'),
    ('Management Consulting'),
    ('Human Resources'),
    ('Staffing and Recruiting'),
    ('Design'),
    ('Graphic Design'),
    ('Media Production'),
    ('Telecommunications'),
    ('Automotive'),
    ('Real Estate'),
    ('Retail'),
    ('Hospitality'),
    ('Accounting'),
    ('Civil Engineering'),
    ('Mechanical or Industrial Engineering'),
    ('Electrical/Electronic Manufacturing'),
    ('Pharmaceuticals'),
    ('Biotechnology'),
    ('Logistics and Supply Chain'),
    ('Insurance'),
    ('Venture Capital & Private Equity'),
    ('Law Practice'),
    ('Legal Services'),
    ('Non-Profit Organization Management'),
    ('Other')
ON CONFLICT (industry_name) DO NOTHING;

COMMIT;

