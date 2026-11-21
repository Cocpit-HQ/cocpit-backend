const fs = require('fs');
const path = require('path');

describe('SCRUM-1854: Closed Jobs Ordering Regression Tests', () => {
  const jobControllerSource = fs.readFileSync(
    path.resolve(__dirname, '../job.controller.js'),
    'utf8'
  );
  const orgJobsSource = fs.readFileSync(
    path.resolve(__dirname, '../../organization/organization.jobs.controller.js'),
    'utf8'
  );
  const poolSource = fs.readFileSync(path.resolve(__dirname, '../../../core/db/pool.js'), 'utf8');

  test('TC-01: pool.js ensures closed_at column and partial index exist on jobs table', () => {
    expect(poolSource).toContain('ALTER TABLE jobs ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ');
    expect(poolSource).toContain(
      "CREATE INDEX IF NOT EXISTS idx_jobs_org_closed ON jobs(org_id, closed_at DESC) WHERE status = 'CLOSED'"
    );
    expect(poolSource).toContain(
      "CREATE INDEX IF NOT EXISTS idx_jobs_recruiter_closed ON jobs(recruiter_id, closed_at DESC) WHERE status = 'CLOSED'"
    );
  });

  test('TC-02: performLifecycleAction sets closed_at = NOW() when targetStatus is CLOSED', () => {
    expect(jobControllerSource).toContain("targetStatus === 'CLOSED'");
    expect(jobControllerSource).toContain('closed_at = NOW()');
    expect(jobControllerSource).toContain('closed_at = NULL');
  });

  test('TC-03: getMyJobs orders by closed_at when status is CLOSED', () => {
    expect(jobControllerSource).toContain("status.trim().toUpperCase() === 'CLOSED'");
    expect(jobControllerSource).toContain(
      'COALESCE(j.closed_at, j.updated_at, j.published_at, j.created_at)'
    );
    expect(jobControllerSource).toContain('query += ` ORDER BY ${orderTimestampExpr} DESC`');
  });

  test('TC-04: organization.jobs.controller orders by closed_at when status is CLOSED and scope is internal', () => {
    expect(orgJobsSource).toContain("status.trim().toUpperCase() === 'CLOSED'");
    expect(orgJobsSource).toContain(
      'COALESCE(j.closed_at, j.updated_at, j.published_at, j.created_at)'
    );
    expect(orgJobsSource).toContain('ORDER BY ${orderTimestampExpr} DESC');
  });

  test('TC-05: nextCursor resolves closed_at for closed jobs in both controllers', () => {
    expect(jobControllerSource).toContain('jobs[jobs.length - 1].closed_at');
    expect(orgJobsSource).toContain('jobs[jobs.length - 1].closed_at');
  });
});
