require("dotenv").config();
const pool = require('./src/core/db/pool');

const sql = `
BEGIN;

-- 1. Alter jobs columns (salaries nullable, add experience fields)
ALTER TABLE jobs ALTER COLUMN salary_min DROP NOT NULL;
ALTER TABLE jobs ALTER COLUMN salary_max DROP NOT NULL;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS experience_min INTEGER;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS experience_max INTEGER;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS experience_label TEXT;

-- 2. Alter status constraint and default
ALTER TABLE jobs ALTER COLUMN status SET DEFAULT 'DRAFT';
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_status_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_status_check CHECK (status IN ('DRAFT', 'ACTIVE', 'CLOSED', 'EXPIRED', 'REJECTED', 'UNDER_REVIEW', 'PAUSED', 'ARCHIVED'));

-- 3. Add salary constraint
ALTER TABLE jobs ADD CONSTRAINT jobs_salary_check CHECK (salary_min IS NULL OR salary_max IS NULL OR salary_min <= salary_max);

-- 4. job_versions updates
ALTER TABLE job_versions ADD COLUMN IF NOT EXISTS trigger_event VARCHAR(50);
ALTER TABLE job_versions ADD COLUMN IF NOT EXISTS provenance VARCHAR(50) DEFAULT 'USER';

-- 5. job_activity table
CREATE TABLE IF NOT EXISTS job_activity (
  activity_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
  actor_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
  action VARCHAR(50) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

COMMIT;
`;

async function run() {
  console.log("Running Phase 8 Job DB Migration...");
  try {
    await pool.query(sql);
    console.log("Job migration successful!");
  } catch (e) {
    console.error("Job migration failed:", e);
  } finally {
    process.exit(0);
  }
}

run();
