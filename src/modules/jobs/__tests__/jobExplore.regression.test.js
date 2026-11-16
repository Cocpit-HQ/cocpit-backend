'use strict';

const jobRecommendationsService = require('../jobRecommendations.service');

describe('Job Explore Recommendation Regression Test Suite', () => {
  let mockClient;

  beforeEach(() => {
    mockClient = {
      query: jest.fn(),
      release: jest.fn(),
    };
  });

  describe('1. Common Eligibility & Ownership Models', () => {
    test('Type A: Org-backed job with recruiter assigned', () => {
      const { whereClause } = jobRecommendationsService.buildCommonEligibilityPredicate('user-1');
      expect(whereClause).toContain('j.is_active = TRUE');
      expect(whereClause).toContain("j.status = 'ACTIVE'");
      expect(whereClause).toContain('j.org_id IS NOT NULL AND c.org_id IS NOT NULL');
      expect(whereClause).toContain('(c.is_deleted IS FALSE OR c.is_deleted IS NULL)');
    });

    test('Type B: Org-backed job with NULL recruiter_id is eligible', () => {
      const { whereClause } = jobRecommendationsService.buildCommonEligibilityPredicate('user-1');
      // Must not require u.user_id IS NOT NULL when org_id is present
      expect(whereClause).toContain('j.org_id IS NOT NULL AND c.org_id IS NOT NULL');
      expect(whereClause).toContain('(j.recruiter_id IS NULL OR u.user_id IS NULL OR (u.is_deactivated IS FALSE OR u.is_deactivated IS NULL))');
    });

    test('Type C: Independent recruiter job (org_id IS NULL) requires active recruiter', () => {
      const { whereClause } = jobRecommendationsService.buildCommonEligibilityPredicate('user-1');
      expect(whereClause).toContain('j.org_id IS NULL AND j.recruiter_id IS NOT NULL AND u.user_id IS NOT NULL');
      expect(whereClause).toContain('(u.is_deactivated IS FALSE OR u.is_deactivated IS NULL)');
    });

    test('Candidate exclusions: Candidate cannot see jobs they posted', () => {
      const { whereClause, params } = jobRecommendationsService.buildCommonEligibilityPredicate('candidate-uuid');
      expect(params).toContain('candidate-uuid');
      expect(whereClause).toContain('(j.recruiter_id IS NULL OR j.recruiter_id != $1)');
    });

    test('Candidate exclusions: Excludes applied jobs but keeps withdrawn applications', () => {
      const { whereClause } = jobRecommendationsService.buildCommonEligibilityPredicate('candidate-uuid');
      expect(whereClause).toContain('FROM job_applications ja');
      expect(whereClause).toContain("ja.current_status != 'Withdrawn'");
    });

    test('Candidate exclusions: Excludes active offers', () => {
      const { whereClause } = jobRecommendationsService.buildCommonEligibilityPredicate('candidate-uuid');
      expect(whereClause).toContain('FROM job_offers jo');
      expect(whereClause).toContain('jo.user_id = $1');
    });

    test('Candidate exclusions: Excludes bi-directionally blocked entities', () => {
      const { whereClause } = jobRecommendationsService.buildCommonEligibilityPredicate('candidate-uuid');
      expect(whereClause).toContain('FROM blocks b');
      expect(whereClause).toContain('b.blocker_id = $1 AND b.blocked_id = j.org_id');
      expect(whereClause).toContain('b.blocker_id = j.org_id AND b.blocked_id = $1');
    });
  });

  describe('2. Featured Opportunities Quality Scoring', () => {
    test('Calculates quality_score SQL expression covering verification, completeness and freshness', async () => {
      mockClient.query.mockResolvedValueOnce({
        rows: [
          {
            job_id: 'job-1',
            title: 'Senior Engineer',
            company_name: 'Acme',
            created_at: new Date().toISOString(),
            quality_score: 92,
            saves_count: 5,
          },
        ],
      });

      const result = await jobRecommendationsService.getFeaturedOpportunities(mockClient, 'user-1', { limit: 10 });

      expect(mockClient.query).toHaveBeenCalled();
      const sql = mockClient.query.mock.calls[0][0];
      expect(sql).toContain('quality_score');
      expect(sql).toContain('SELECT COUNT(*)::int FROM job_saves js_cnt WHERE js_cnt.job_id = j.job_id');
      expect(sql).toContain('ORDER BY quality_score DESC, saves_count DESC, created_at DESC, job_id DESC');
      expect(result.items).toHaveLength(1);
      expect(result.items[0].quality_score).toBe(92);
    });

    test('Keyset cursor incorporates score, saves, created_at, and job_id', async () => {
      const fakeDate = '2026-11-01T12:00:00.000Z';
      mockClient.query.mockResolvedValueOnce({
        rows: [
          { job_id: 'job-1', title: 'Job 1', created_at: fakeDate, quality_score: 95, saves_count: 8 },
          { job_id: 'job-2', title: 'Job 2', created_at: fakeDate, quality_score: 90, saves_count: 4 },
        ],
      });

      // Request limit: 1 -> query fetches 2 -> hasMore: true
      const result = await jobRecommendationsService.getFeaturedOpportunities(mockClient, 'user-1', { limit: 1 });

      expect(result.hasMore).toBe(true);
      expect(result.items).toHaveLength(1);
      expect(result.nextCursor).toBeDefined();

      const decoded = jobRecommendationsService.decodeCursor(result.nextCursor);
      expect(decoded.score).toBe(95);
      expect(decoded.saves).toBe(8);
      expect(decoded.id).toBe('job-1');
    });
  });

  describe('3. Best Matches Recommendation Logic', () => {
    test('Returns empty array with requiresAuth: true for unauthenticated guests', async () => {
      const result = await jobRecommendationsService.getBestMatches(mockClient, null, { limit: 10 });
      expect(result.items).toEqual([]);
      expect(result.requiresAuth).toBe(true);
      expect(mockClient.query).not.toHaveBeenCalled();
    });

    test('Scores and filters candidate jobs with MIN_MATCH_THRESHOLD = 60', async () => {
      // 1. Profile, Skills, Experiences
      mockClient.query
        .mockResolvedValueOnce({
          rows: [{ job_title: 'Full Stack Engineer', work_preference: 'Remote', city: 'San Francisco' }],
        })
        .mockResolvedValueOnce({
          rows: [{ skill_name: 'react' }, { skill_name: 'node.js' }, { skill_name: 'postgresql' }],
        })
        .mockResolvedValueOnce({
          rows: [{ title: 'Full Stack Engineer', start_date: '2022-01-01', end_date: '2025-01-01', is_current: true }],
        })
        // 2. Candidate jobs pool
        .mockResolvedValueOnce({
          rows: [
            {
              job_id: 'job-high-match',
              title: 'Full Stack Engineer',
              skills: ['react', 'node.js', 'postgresql'],
              experience_min: 2,
              experience_max: 4,
              work_mode: 'Remote',
              location: 'San Francisco',
              created_at: '2026-11-01T10:00:00Z',
            },
            {
              job_id: 'job-low-match',
              title: 'Senior Civil Engineer',
              skills: ['autocad', 'structural analysis'],
              experience_min: 8,
              experience_max: 12,
              work_mode: 'Onsite',
              location: 'Tokyo',
              created_at: '2026-11-01T10:00:00Z',
            },
          ],
        });

      const result = await jobRecommendationsService.getBestMatches(mockClient, 'user-1', { limit: 10 });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe('job-high-match');
      expect(result.items[0].match_score).toBeGreaterThanOrEqual(60);
    });
  });

  describe('4. From Your Network Affiliation & Ranking', () => {
    test('Returns empty array with requiresAuth: true for unauthenticated guests', async () => {
      const result = await jobRecommendationsService.getFromNetwork(mockClient, null, { limit: 10 });
      expect(result.items).toEqual([]);
      expect(result.requiresAuth).toBe(true);
      expect(mockClient.query).not.toHaveBeenCalled();
    });

    test('Executes DISTINCT ON to deduplicate connection affiliations', async () => {
      mockClient.query.mockResolvedValueOnce({
        rows: [
          {
            job_id: 'job-net-1',
            title: 'Staff Engineer',
            company_name: 'Stripe',
            connection_count: 2,
            network_connection_name: 'Alice Smith',
            created_at: '2026-11-01T10:00:00Z',
          },
        ],
      });

      const result = await jobRecommendationsService.getFromNetwork(mockClient, 'user-1', { limit: 10 });

      expect(mockClient.query).toHaveBeenCalled();
      const sql = mockClient.query.mock.calls[0][0];
      expect(sql).toContain('DISTINCT ON (dc.connection_id, affiliation.org_id)');
      expect(sql).toContain('ORDER BY freshness_tier ASC, direct_recruiter_tier ASC, connection_count DESC, created_at DESC, job_id DESC');
      expect(result.items[0].network_badge).toEqual({
        connection_count: 2,
        primary_name: 'Alice Smith',
        text: 'Alice Smith and 1 other connection work here',
      });
    });
  });

  describe('5. Recently Viewed Universal Exclusions & Ordering', () => {
    test('Returns empty array with requiresAuth: true for unauthenticated guests', async () => {
      const result = await jobRecommendationsService.getRecentlyViewed(mockClient, null, { limit: 10 });
      expect(result.items).toEqual([]);
      expect(result.requiresAuth).toBe(true);
      expect(mockClient.query).not.toHaveBeenCalled();
    });

    test('Queries user_activity_log grouped by entity_id with universal candidate exclusions', async () => {
      mockClient.query.mockResolvedValueOnce({
        rows: [
          {
            job_id: 'job-viewed-1',
            title: 'Design Lead',
            company_name: 'Figma',
            last_viewed_at: '2026-11-02T15:00:00Z',
            created_at: '2026-11-01T10:00:00Z',
          },
        ],
      });

      const result = await jobRecommendationsService.getRecentlyViewed(mockClient, 'user-1', { limit: 10 });

      expect(mockClient.query).toHaveBeenCalled();
      const sql = mockClient.query.mock.calls[0][0];
      expect(sql).toContain("action_type = 'view_job'");
      expect(sql).toContain("entity_type = 'job'");
      expect(sql).toContain('GROUP BY entity_id');
      expect(sql).toContain('ORDER BY latest_views.last_viewed_at DESC, j.job_id DESC');
      expect(result.items[0].last_viewed_at).toBe('2026-11-02T15:00:00Z');
    });
  });

  describe('6. Paginated Category Endpoint Service (getCategoryPaginated)', () => {
    test('Throws INVALID_CATEGORY for unsupported category string', async () => {
      await expect(
        jobRecommendationsService.getCategoryPaginated('unsupported', 'user-1')
      ).rejects.toThrow(/Invalid explore category/);
    });

    test('Delegates to appropriate category query for supported categories', async () => {
      mockClient.query.mockResolvedValue({ rows: [] });

      const resFeatured = await jobRecommendationsService.getCategoryPaginated('featured', 'user-1', { limit: 5, dbClient: mockClient });
      expect(resFeatured.category).toBe('featured');
      expect(resFeatured.title).toBe('Featured opportunities');
      expect(resFeatured.items).toEqual([]);
    });
  });

  describe('7. Aggregated Preview (5 cards limit)', () => {
    test('getExploreSections requests preview limit of 5 for each category', async () => {
      mockClient.query.mockResolvedValue({ rows: [] });

      const sections = await jobRecommendationsService.getExploreSections('user-1', mockClient);
      expect(sections).toHaveProperty('featured');
      expect(sections).toHaveProperty('best_matches');
      expect(sections).toHaveProperty('from_network');
      expect(sections).toHaveProperty('recently_viewed');

      // Verify queries passed 6 (safeLimit 5 + 1) to determine hasMore
      const limitsPassed = mockClient.query.mock.calls.map(call => call[1]).flat();
      expect(limitsPassed).toContain(6);
    });
  });

});
