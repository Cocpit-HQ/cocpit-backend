/**
 * Unit Tests: Exploration Pool (A7)
 *
 * Run: npm test -- --testPathPattern=explorationPool
 */

'use strict';

const { refreshExplorationPool, getExplorationCandidates, _EXPLORE_POOL_KEY } = require('./explorationPool');

const redis = require('../../../core/cache/redis');

const mockPipeline = {
  zadd: jest.fn(),
  zremrangebyrank: jest.fn(),
  expire: jest.fn(),
  exec: jest.fn().mockResolvedValue([]),
};

jest.mock('../../../core/cache/redis', () => ({
  pipeline: jest.fn(() => mockPipeline),
  zrevrange: jest.fn(),
  smembers: jest.fn(),
}));

describe('explorationPool', () => {

  describe('refreshExplorationPool', () => {
    const mockPool = { query: jest.fn() };

    beforeEach(() => {
      jest.clearAllMocks();
    });

    test('aborts if pool is missing', async () => {
      await refreshExplorationPool(null);
      expect(mockPool.query).not.toHaveBeenCalled();
    });

    test('writes to redis pipeline and sets TTL', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ content_id: 'c1', like_count: '10' }] }); // trending
      mockPool.query.mockResolvedValueOnce({ rows: [{ content_id: 'c2', comment_count: '5' }] }); // new creator



      await refreshExplorationPool(mockPool);

      expect(mockPipeline.zadd).toHaveBeenCalledTimes(2);
      expect(mockPipeline.expire).toHaveBeenCalledWith(_EXPLORE_POOL_KEY, 300);
      expect(mockPipeline.exec).toHaveBeenCalled();
    });
  });

  describe('getExplorationCandidates', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    test('returns empty if redis misses', async () => {
      redis.zrevrange.mockResolvedValueOnce([]);
      const result = await getExplorationCandidates('u1');
      expect(result).toEqual([]);
    });

    test('filters seen items', async () => {
      redis.zrevrange.mockResolvedValueOnce(['c1', '10', 'c2', '8', 'c3', '5']);
      redis.smembers.mockResolvedValueOnce(['c2']); // user has seen c2

      const result = await getExplorationCandidates('u1', 2);

      expect(result.length).toBe(2);
      expect(result[0].contentId).toBe('c1');
      expect(result[1].contentId).toBe('c3');
      expect(result[0].source).toBe('exploration');
      expect(result[0].isOpportunity).toBe(false);
    });

    test('graceful degradation on seen set failure', async () => {
      redis.zrevrange.mockResolvedValueOnce(['c1', '10']);
      redis.smembers.mockRejectedValueOnce(new Error('Redis err'));

      const result = await getExplorationCandidates('u1', 1);

      expect(result.length).toBe(1);
      expect(result[0].contentId).toBe('c1');
    });
  });
});
