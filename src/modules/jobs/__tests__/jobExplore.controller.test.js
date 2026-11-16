'use strict';

const jobController = require('../job.controller');
const jobRecommendationsService = require('../jobRecommendations.service');

jest.mock('../jobRecommendations.service');

describe('Job Explore Controller Tests', () => {
  let req;
  let res;

  beforeEach(() => {
    jest.clearAllMocks();
    req = {
      user: { sub: 'user-uuid-123' },
      query: {},
      params: {},
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
  });

  describe('GET /explore/sections (getExploreSections)', () => {
    test('returns 200 with aggregated sections for authenticated candidate', async () => {
      const mockSections = {
        featured: [{ id: 'job-1', title: 'Featured 1' }],
        best_matches: [{ id: 'job-2', title: 'Match 1' }],
        from_network: [{ id: 'job-3', title: 'Network 1' }],
        recently_viewed: [{ id: 'job-4', title: 'Viewed 1' }],
      };
      jobRecommendationsService.getExploreSections.mockResolvedValue(mockSections);

      await jobController.getExploreSections(req, res);

      expect(jobRecommendationsService.getExploreSections).toHaveBeenCalledWith('user-uuid-123');
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: mockSections,
      });
    });

    test('returns 200 with null userId for unauthenticated guest', async () => {
      req.user = undefined;
      const mockSections = {
        featured: [{ id: 'job-1', title: 'Featured 1' }],
        best_matches: [],
        from_network: [],
        recently_viewed: [],
      };
      jobRecommendationsService.getExploreSections.mockResolvedValue(mockSections);

      await jobController.getExploreSections(req, res);

      expect(jobRecommendationsService.getExploreSections).toHaveBeenCalledWith(null);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: mockSections,
      });
    });

    test('returns 500 on database failure', async () => {
      jobRecommendationsService.getExploreSections.mockRejectedValue(new Error('DB failure'));

      await jobController.getExploreSections(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Failed to fetch explore job sections',
      });
    });
  });

  describe('GET /explore/sections/:category (getExploreSectionDetail)', () => {
    beforeEach(() => {
      jobRecommendationsService.VALID_CATEGORIES = [
        'featured',
        'best-matches',
        'from-network',
        'recently-viewed',
      ];
    });

    test('returns 400 with INVALID_CATEGORY for unknown category slug', async () => {
      req.params.category = 'unknown-slug';

      await jobController.getExploreSectionDetail(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          code: 'INVALID_CATEGORY',
        })
      );
      expect(jobRecommendationsService.getCategoryPaginated).not.toHaveBeenCalled();
    });

    test('returns 200 with paginated jobs for valid category', async () => {
      req.params.category = 'featured';
      req.query = { limit: '10', cursor: 'base64cursor' };

      const mockResult = {
        category: 'featured',
        title: 'Featured opportunities',
        items: [{ id: 'job-1', title: 'Featured 1' }],
        nextCursor: 'next-cursor-base64',
        hasMore: true,
      };
      jobRecommendationsService.getCategoryPaginated.mockResolvedValue(mockResult);

      await jobController.getExploreSectionDetail(req, res);

      expect(jobRecommendationsService.getCategoryPaginated).toHaveBeenCalledWith(
        'featured',
        'user-uuid-123',
        { limit: '10', cursor: 'base64cursor' }
      );
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: mockResult,
      });
    });

    test('passes guest userId (null) to service for unauthenticated users', async () => {
      req.user = undefined;
      req.params.category = 'best-matches';

      const mockResult = {
        category: 'best-matches',
        title: 'Best matches for you',
        items: [],
        nextCursor: null,
        hasMore: false,
        requiresAuth: true,
      };
      jobRecommendationsService.getCategoryPaginated.mockResolvedValue(mockResult);

      await jobController.getExploreSectionDetail(req, res);

      expect(jobRecommendationsService.getCategoryPaginated).toHaveBeenCalledWith(
        'best-matches',
        null,
        { limit: undefined, cursor: null }
      );
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: mockResult,
      });
    });

    test('returns 500 when unexpected error occurs', async () => {
      req.params.category = 'featured';
      jobRecommendationsService.getCategoryPaginated.mockRejectedValue(new Error('Connection error'));

      await jobController.getExploreSectionDetail(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Failed to fetch category job listings',
      });
    });
  });

  describe('GET /locations (getLocations)', () => {
    test('returns paginated locations from jobs, orgs, and users', async () => {
      const pool = require('../../../core/db/pool');
      jest.spyOn(pool, 'query').mockResolvedValueOnce({
        rows: [
          { location: 'Bengaluru, Karnataka, India' },
          { location: 'Mumbai, Maharashtra, India' },
          { location: 'Pune, Maharashtra, India' },
        ],
      });

      req.query = { limit: '2' };
      await jobController.getLocations(req, res);

      expect(res.json).toHaveBeenCalledWith({
        items: ['Bengaluru, Karnataka, India', 'Mumbai, Maharashtra, India'],
        nextCursor: 'Mumbai, Maharashtra, India',
        hasMore: true,
      });

      pool.query.mockRestore();
    });
  });

});

