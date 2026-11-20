'use strict';

const pool = require('../../../core/db/pool');
const analyticsService = require('../analytics.service');
const postAnalyticsController = require('../post.analytics.controller');

describe('SCRUM-11 / SCRUM-1856: Exclude Deleted Posts from Analytics', () => {

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('1. getContentData Query Filters', () => {
    test('TC-01: ensures formatPerformance and topPosts queries filter out deleted/inactive/removed posts', async () => {
      const capturedQueries = [];

      jest.spyOn(pool, 'query').mockImplementation(async (sql, params) => {
        if (typeof sql === 'string') {
          capturedQueries.push(sql);
          if (sql.includes('SELECT created_at FROM users')) {
            return { rowCount: 1, rows: [{ created_at: new Date('2025-01-01').toISOString() }] };
          }
          if (sql.includes('FROM posts p')) {
            return { rowCount: 0, rows: [] };
          }
        }
        return { rowCount: 0, rows: [] };
      });

      await analyticsService.getContentData('user-uuid-1', { filter: '7_days' });

      // Format performance query check
      const formatQuery = capturedQueries.find(q => q.includes('p.post_type, COALESCE(SUM(pad.impressions), 0)'));
      expect(formatQuery).toBeDefined();
      expect(formatQuery).toContain('p.is_active = TRUE');
      expect(formatQuery).toContain('(p.is_deleted IS FALSE OR p.is_deleted IS NULL)');
      expect(formatQuery).toContain('(p.is_removed IS FALSE OR p.is_removed IS NULL)');

      // Top posts query check
      const topPostsQuery = capturedQueries.find(q => q.includes('engagement_score'));
      expect(topPostsQuery).toBeDefined();
      expect(topPostsQuery).toContain('p.is_active = TRUE');
      expect(topPostsQuery).toContain('(p.is_deleted IS FALSE OR p.is_deleted IS NULL)');
      expect(topPostsQuery).toContain('(p.is_removed IS FALSE OR p.is_removed IS NULL)');
    });
  });

  describe('2. getOverviewData and getAudienceData Post Eligibility Checks', () => {
    test('TC-02: getOverviewData peak post and best post type queries filter out deleted posts', async () => {
      const capturedQueries = [];

      jest.spyOn(pool, 'query').mockImplementation(async (sql, params) => {
        if (typeof sql === 'string') {
          capturedQueries.push(sql);
          if (sql.includes('SELECT created_at FROM users')) {
            return { rowCount: 1, rows: [{ created_at: new Date('2025-01-01').toISOString() }] };
          }
          if (sql.includes('SELECT DATE(date) as d')) {
            return { rowCount: 1, rows: [{ d: '2025-01-02', v: '10' }] };
          }
          if (sql.includes('FROM profile_analytics_daily')) {
            return { rowCount: 1, rows: [{ profile_views: '10', search_appearances: '5' }] };
          }
          if (sql.includes('SELECT COUNT(1) as count')) {
            return { rowCount: 1, rows: [{ count: '2' }] };
          }
          if (sql.includes('FROM user_resumes')) {
            return { rowCount: 0, rows: [] };
          }
          if (sql.includes('FROM posts p JOIN profile_views')) {
            return { rowCount: 0, rows: [] };
          }
          if (sql.includes('SELECT post_id, created_at FROM posts')) {
            return { rowCount: 0, rows: [] };
          }
          if (sql.includes('SELECT p.post_type, SUM(pad.impressions)')) {
            return { rowCount: 0, rows: [] };
          }
        }
        return { rowCount: 0, rows: [] };
      });

      const profileRepository = require('../../profile/profile.repository');
      jest.spyOn(profileRepository, 'getProfileScoreData').mockResolvedValue(null);

      await analyticsService.getOverviewData('user-uuid-1', { filter: '7_days' });

      // Peak post query
      const peakPostQuery = capturedQueries.find(q => q.includes('FROM posts p\n            JOIN profile_views pv') || q.includes('FROM posts p JOIN profile_views pv'));
      if (peakPostQuery) {
        expect(peakPostQuery).toContain('p.is_active = TRUE');
        expect(peakPostQuery).toContain('p.is_deleted IS FALSE OR p.is_deleted IS NULL');
      }

      // Best post type query
      const bestPostTypeQuery = capturedQueries.find(q => q.includes('best post type') || q.includes('SELECT p.post_type, SUM(pad.impressions)'));
      expect(bestPostTypeQuery).toBeDefined();
      expect(bestPostTypeQuery).toContain('p.is_active = TRUE');
      expect(bestPostTypeQuery).toContain('p.is_deleted IS FALSE OR p.is_deleted IS NULL');
    });

    test('TC-03: getAudienceData viewersQuery and engagement queries filter out deleted posts', async () => {
      const capturedQueries = [];

      jest.spyOn(pool, 'query').mockImplementation(async (sql, params) => {
        if (typeof sql === 'string') {
          capturedQueries.push(sql);
          if (sql.includes('SELECT created_at FROM users')) {
            return { rowCount: 1, rows: [{ created_at: new Date('2025-01-01').toISOString() }] };
          }
          if (sql.includes('SELECT COUNT(1) as count FROM (')) {
            return { rowCount: 1, rows: [{ count: '5' }] };
          }
          if (sql.includes('FROM profile_analytics_daily')) {
            return { rowCount: 1, rows: [{ count: '5' }] };
          }
          if (sql.includes('FROM post_analytics_daily pad')) {
            return { rowCount: 1, rows: [{ impressions: '10', engagements: '3' }] };
          }
          if (sql.includes('u.location_country')) {
            return { rowCount: 0, rows: [] };
          }
          if (sql.includes('u.location_city')) {
            return { rowCount: 0, rows: [] };
          }
          if (sql.includes('p.working_industry')) {
            return { rowCount: 0, rows: [] };
          }
        }
        return { rowCount: 0, rows: [] };
      });

      await analyticsService.getAudienceData('user-uuid-1', { filter: '7_days' });

      // Check viewersQuery subquery inside overall reach
      const reachQuery = capturedQueries.find(q => q.includes('FROM post_impressions pi'));
      expect(reachQuery).toBeDefined();
      expect(reachQuery).toContain('p.is_active = TRUE');
      expect(reachQuery).toContain('p.is_deleted IS FALSE OR p.is_deleted IS NULL');

      // Check engagement rate query
      const engagementQuery = capturedQueries.find(q => q.includes('FROM post_analytics_daily pad\n        JOIN posts p') || q.includes('FROM post_analytics_daily pad JOIN posts p'));
      expect(engagementQuery).toBeDefined();
      expect(engagementQuery).toContain('p.is_active = TRUE');
      expect(engagementQuery).toContain('p.is_deleted IS FALSE OR p.is_deleted IS NULL');
    });
  });

  describe('3. getPostAnalytics Controller 404 Guard for Deleted Posts', () => {
    test('TC-04: returns 404 when requested post is marked inactive (is_active = FALSE)', async () => {
      const req = {
        user: { sub: 'user-uuid-1' },
        params: { postId: 'post-uuid-deleted' },
        query: { filter: '7_days' },
      };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      };
      const next = jest.fn();

      jest.spyOn(pool, 'query').mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          author_id: 'user-uuid-1',
          author_org_id: null,
          is_active: false,
          is_deleted: false,
          is_removed: false,
        }],
      });

      await postAnalyticsController.getPostAnalytics(req, res, next);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({
        status: 'error',
        message: 'Post not found',
      });
    });

    test('TC-05: returns 404 when requested post is marked deleted (is_deleted = TRUE)', async () => {
      const req = {
        user: { sub: 'user-uuid-1' },
        params: { postId: 'post-uuid-mod-deleted' },
        query: { filter: '7_days' },
      };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      };
      const next = jest.fn();

      jest.spyOn(pool, 'query').mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          author_id: 'user-uuid-1',
          author_org_id: null,
          is_active: true,
          is_deleted: true,
          is_removed: false,
        }],
      });

      await postAnalyticsController.getPostAnalytics(req, res, next);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({
        status: 'error',
        message: 'Post not found',
      });
    });
  });
});
