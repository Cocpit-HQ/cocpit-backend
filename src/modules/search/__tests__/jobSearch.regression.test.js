'use strict';

const pool = require('../../../core/db/pool');
const { searchJobs } = require('../queries/jobSearch.query');
const searchService = require('../search.service');

describe('Job Search Regression Test Suite', () => {
  let mockClient;

  beforeEach(() => {
    mockClient = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
      release: jest.fn(),
    };
  });

  describe('1. Saved state joins and block enforcement', () => {
    test('When viewerId is provided, job_saves and job_applications are joined with $1', async () => {
      mockClient.query.mockResolvedValueOnce({
        rows: [
          {
            job_id: 'job-123',
            title: 'Frontend Developer',
            company: 'TechSpheree',
            company_name: 'TechSpheree',
            isSaved: true,
            hasApplied: false,
            created_at: new Date().toISOString(),
          },
        ],
      });

      const result = await searchJobs(mockClient, {
        queryParams: { q: 'Frontend' },
        viewerId: 'user-uuid-456',
        limit: 10,
      });

      expect(mockClient.query).toHaveBeenCalledTimes(1);
      const [sql, params] = mockClient.query.mock.calls[0];

      // Verifies viewerId is $1
      expect(params[0]).toBe('user-uuid-456');
      expect(sql).toContain('LEFT JOIN job_saves js ON js.job_id = j.job_id AND js.user_id = $1');
      expect(sql).toContain('LEFT JOIN job_applications ja ON ja.job_id = j.job_id AND ja.applicant_id = $1');

      // Verifies output contains is_saved: true and isSaved: true
      expect(result.items[0].is_saved).toBe(true);
      expect(result.items[0].isSaved).toBe(true);
    });

    test('When both viewerId (user) and orgActorId (company) are provided, block checks both and job_saves uses user viewerId', async () => {
      mockClient.query.mockResolvedValueOnce({
        rows: [
          {
            job_id: 'job-789',
            title: 'Backend Engineer',
            company: 'Atlas Tech',
            isSaved: true,
            hasApplied: true,
            created_at: new Date().toISOString(),
          },
        ],
      });

      const result = await searchJobs(mockClient, {
        queryParams: { q: 'Backend' },
        viewerId: 'user-uuid-456',
        orgActorId: 'org-uuid-999',
        limit: 10,
      });

      const [sql, params] = mockClient.query.mock.calls[0];

      // viewerId should still be $1 for saved/applications
      expect(params[0]).toBe('user-uuid-456');
      expect(sql).toContain('LEFT JOIN job_saves js ON js.job_id = j.job_id AND js.user_id = $1');
      // orgActorId should be included in params for block check
      expect(params).toContain('org-uuid-999');

      expect(result.items[0].is_saved).toBe(true);
      expect(result.items[0].is_applied).toBe(true);
    });

    test('is_saved is robustly parsed from isSaved, issaved, or is_saved in database row', async () => {
      mockClient.query.mockResolvedValueOnce({
        rows: [
          {
            job_id: 'job-case-test',
            title: 'Fullstack Dev',
            issaved: true,
            hasapplied: false,
            created_at: new Date().toISOString(),
          },
        ],
      });

      const result = await searchJobs(mockClient, {
        queryParams: {},
        viewerId: 'user-uuid-456',
        limit: 10,
      });

      expect(result.items[0].is_saved).toBe(true);
      expect(result.items[0].isSaved).toBe(true);
    });
  });

  describe('2. searchService orchestrator actor handling', () => {
    test('When searching as ORGANIZATION, searchJobs receives human user ID for viewerId', async () => {
      jest.spyOn(pool, 'connect').mockResolvedValue(mockClient);

      await searchService.executeSearch({
        q: 'developer',
        type: 'jobs',
        actor: {
          type: 'ORGANIZATION',
          id: 'company-org-id',
          userId: 'human-user-id',
          orgId: 'company-org-id',
        },
      });

      // Find the SELECT query from jobs
      const selectCall = mockClient.query.mock.calls.find(call => typeof call[0] === 'string' && call[0].includes('FROM jobs j'));
      expect(selectCall).toBeDefined();
      const [sql, params] = selectCall;

      // $1 MUST be the human user id, NOT company-org-id!
      expect(params[0]).toBe('human-user-id');
      expect(sql).toContain('LEFT JOIN job_saves js ON js.job_id = j.job_id AND js.user_id = $1');

      pool.connect.mockRestore();
    });
  });

  describe('3. Experience level filter accuracy', () => {
    test('Mid-level (3-5 yrs) filter enforces explicit non-null experience and excludes 0-2 yrs jobs', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [] });

      await searchJobs(mockClient, {
        queryParams: { q: 'testing', experience_level: 'Mid-level (3-5 yrs)' },
        viewerId: 'user-uuid-456',
        limit: 10,
      });

      const [sql] = mockClient.query.mock.calls[0];

      // Must require experience_min or experience_max to be non-null
      expect(sql).toContain('j.experience_min IS NOT NULL OR j.experience_max IS NOT NULL');
      // Must require lower bound >= 3 and upper bound <= 5 (with min >= 2)
      expect(sql).toContain('COALESCE(j.experience_min, j.experience_max) <= 5');
      expect(sql).toContain('COALESCE(j.experience_max, j.experience_min) >= 3');
      expect(sql).toContain('COALESCE(j.experience_min, 0) >= 2');
    });

    test('Fresher filter correctly bounds to 0-2 yrs and requires non-null numeric bounds', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [] });

      await searchJobs(mockClient, {
        queryParams: { experience_level: 'Fresher' },
        viewerId: 'user-uuid-456',
        limit: 10,
      });

      const [sql] = mockClient.query.mock.calls[0];

      expect(sql).toContain('COALESCE(j.experience_min, 0) = 0');
      expect(sql).toContain('COALESCE(j.experience_max, j.experience_min, 0) <= 2');
    });
  });
});
