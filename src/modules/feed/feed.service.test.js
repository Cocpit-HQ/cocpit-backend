/**
 * Unit Tests: Feed Service (B7)
 *
 * Run: npm test -- --testPathPattern=feed.service
 */

'use strict';
/* global jest, describe, test, expect, beforeEach */

const { getFeed } = require('./feed.service');
const feedCache = require('./cache/feedCache');
const feedSessionService = require('./session/feedSession.service');

// Mock dependencies
jest.mock('./cache/feedCache');
jest.mock('./session/feedSession.service');
jest.mock('../../core/cache/redis', () => ({}));
jest.mock('../../core/db/pool', () => ({ query: jest.fn() }));
jest.mock('../../utils/shareHydration', () => ({
  hydrateShareCounts: jest.fn(async (rows) => rows),
}));

// Mock pipeline modules
jest.mock('./candidates/candidateGenerator', () => ({
  generateCandidates: jest.fn().mockResolvedValue([{ contentId: 'c1' }]),
}));
jest.mock('./ranking/rankingCalculator', () => ({
  rankCandidates: jest.fn().mockResolvedValue([{ item_id: 'c1', _candidate: {} }]),
}));
jest.mock('./reranking/rerankingEngine', () => ({
  rerankCandidates: jest.fn().mockResolvedValue([{ id: 'c1', slot_type: 'organic' }]),
}));
jest.mock('./exploration/explorationPool', () => ({
  getExplorationCandidates: jest.fn().mockResolvedValue([]),
}));

describe('feed.service', () => {

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('throws if userId missing', async () => {
    await expect(getFeed({})).rejects.toThrow('userId');
  });

  test('returns cached slice immediately if hit (pipeline bypass)', async () => {
    feedCache.getFeedSlice.mockResolvedValue([{ id: 'cached1', slot_type: 'organic' }]);
    feedSessionService.getSession.mockResolvedValue({ session_id: 's1', cursor: 'next' });

    const result = await getFeed({ userId: 'u1' });

    expect(result.meta.cache_hit).toBe(true);
    expect(result.data.items[0].id).toBe('cached1');
    expect(result.data.cursor).toBe('next');
    
    // Pipeline should NOT be called
    const { generateCandidates } = require('./candidates/candidateGenerator');
    expect(generateCandidates).not.toHaveBeenCalled();
  });

  test('runs full pipeline on cache miss', async () => {
    feedCache.getFeedSlice.mockResolvedValue(null); // MISS
    feedSessionService.getSession.mockResolvedValue({ session_id: 's1' });

    const result = await getFeed({ userId: 'u1' });

    expect(result.meta.cache_hit).toBe(false);
    expect(result.data.items[0].id).toBe('c1');
    
    // Assert cache write
    expect(feedCache.setFeedSlice).toHaveBeenCalled();
    // Assert session updates
    expect(feedSessionService.updateCursor).toHaveBeenCalled();
    expect(feedCache.addToSeenSet).toHaveBeenCalled();
  });

  test('degrades gracefully on pipeline crash', async () => {
    feedCache.getFeedSlice.mockResolvedValue(null);
    const { generateCandidates } = require('./candidates/candidateGenerator');
    generateCandidates.mockRejectedValueOnce(new Error('crash'));

    const result = await getFeed({ userId: 'u1' });

    expect(result.data.items).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test('bypasses pipeline when algorithm is false (chronological feed)', async () => {
    feedCache.getFeedSlice.mockResolvedValue(null);
    feedCache.getHiddenSet.mockResolvedValue(['hidden-1']);
    const mockPool = {
      query: jest.fn((sql, params) => {
        if (sql.includes('p.post_id = ANY($3::uuid[])')) {
          return Promise.resolve({ rows: params[2].map((postId) => ({ post_id: postId, is_reported: false })) });
        }
        return Promise.resolve({ rows: [
          { id: 'c1', type: 'post', slot_type: 'organic', created_at: '2026-07-15T10:00:00.000Z' },
          { id: 'hidden-1', type: 'post', slot_type: 'organic', created_at: '2026-07-15T09:00:00.000Z' }
        ] });
      })
    };
    feedSessionService.getSession.mockResolvedValue({ session_id: 's1' });

    const result = await getFeed({ userId: 'u1', pool: mockPool, algorithm: false });

    // Should only have c1 because hidden-1 is filtered out
    expect(result.data.items).toHaveLength(1);
    expect(result.data.items[0].id).toBe('c1');
    expect(mockPool.query).toHaveBeenCalled();
    
    // Pipeline should NOT be called
    const { generateCandidates } = require('./candidates/candidateGenerator');
    expect(generateCandidates).not.toHaveBeenCalled();
  });
});
