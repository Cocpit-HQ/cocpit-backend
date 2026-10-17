/**
 * Unit Tests: Reranking / Diversity Layer (B4)
 * Sprint Task: Day 2 — Task B4 (B4.1 – B4.5)
 * Owner: Dev B
 * AI-Assisted: Yes (Antigravity)
 * Contracts read: contracts/ranking-features.md (FROZEN v1.0.0)
 * Last reviewed: 2026-05-24
 *
 * Run: npm test -- --testPathPattern=rerankingEngine
 *
 * These are Jest unit tests — `feedCache` is mocked. No live Redis connection is required.
 */

'use strict';

const {
  rerankCandidates,
  applyDiversityPenalties,
  getAuthorPenalty,
  getContentTypePenalty,
  _applyAntiSpam,
  _isEngagementBait,
  _buildSlottedPage,
  _DIVERSITY_WEIGHT,
  _FEED_PAGE_SIZE,
} = require('./rerankingEngine');

const { getSeenSet, getHiddenSet } = require('../cache/feedCache');

// Mock feedCache getSeenSet and getHiddenSet helper
jest.mock('../cache/feedCache', () => ({
  getSeenSet: jest.fn(),
  getHiddenSet: jest.fn(),
}));

// Helper to make a standard ScoredCandidate for testing
function makeScoredCandidate(overrides = {}) {
  const contentId = overrides.contentId || 'content-uuid-1';
  const authorId = overrides.authorId || 'author-uuid-1';
  const itemType = overrides.itemType || 'post';

  return {
    item_id: contentId,
    candidate_id: overrides.itemId || 'candidate-uuid-1',
    final_score: overrides.final_score !== undefined ? overrides.final_score : 1.0,
    score_breakdown: overrides.score_breakdown || {
      recency: 0.8,
      engagement: 0.5,
      relationship: 0.5,
      intent_match: 0.5,
    },
    slot_type: overrides.isOpportunity ? 'opportunity' : 'organic',
    ranked_at: new Date().toISOString(),
    ranking_version: '1.0.0',
    position: null,
    _candidate: {
      contentId,
      itemId: overrides.itemId || 'candidate-uuid-1',
      authorId,
      itemType,
      ...overrides._candidate,
    },
  };
}

describe('Reranking Engine - Unit Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // 1. getAuthorPenalty Tests
  // ---------------------------------------------------------------------------
  describe('getAuthorPenalty', () => {
    test('no penalty on 1st appearance (count 0)', () => {
      expect(getAuthorPenalty(0)).toBe(0);
    });

    test('no penalty on 1st appearance (count 1 is before the 2nd appearance)', () => {
      expect(getAuthorPenalty(1)).toBe(0);
    });

    test('0.5 penalty on 2nd appearance (count 2)', () => {
      expect(getAuthorPenalty(2)).toBe(0.5);
    });

    test('0.5 penalty on subsequent appearances (count > 2)', () => {
      expect(getAuthorPenalty(3)).toBe(0.5);
      expect(getAuthorPenalty(10)).toBe(0.5);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. getContentTypePenalty Tests
  // ---------------------------------------------------------------------------
  describe('getContentTypePenalty', () => {
    test('no penalty on appearances 1 to 3 (count 0 to 3)', () => {
      expect(getContentTypePenalty(0)).toBe(0);
      expect(getContentTypePenalty(1)).toBe(0);
      expect(getContentTypePenalty(2)).toBe(0);
      expect(getContentTypePenalty(3)).toBe(0);
    });

    test('1.0 penalty on 4th same type appearance (count 4)', () => {
      expect(getContentTypePenalty(4)).toBe(1.0);
    });

    test('1.0 penalty on subsequent same type appearances (count > 4)', () => {
      expect(getContentTypePenalty(5)).toBe(1.0);
      expect(getContentTypePenalty(8)).toBe(1.0);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. applyDiversityPenalties Tests
  // ---------------------------------------------------------------------------
  describe('applyDiversityPenalties', () => {
    test('applies no penalty when there are no duplicates', () => {
      const candidates = [
        makeScoredCandidate({ contentId: 'c1', authorId: 'a1', itemType: 'post', final_score: 1.0 }),
        makeScoredCandidate({ contentId: 'c2', authorId: 'a2', itemType: 'job', final_score: 0.9 }),
      ];

      const result = applyDiversityPenalties(candidates);
      expect(result[0].final_score).toBe(1.0);
      expect(result[1].final_score).toBe(0.9);
      expect(result[0].score_breakdown.diversity_penalty).toBeUndefined();
      expect(result[1].score_breakdown.diversity_penalty).toBeUndefined();
    });

    test('applies 0.5 * Wd penalty to same author on 2nd appearance', () => {
      const candidates = [
        makeScoredCandidate({ contentId: 'c1', authorId: 'a1', final_score: 1.0 }),
        makeScoredCandidate({ contentId: 'c2', authorId: 'a1', final_score: 0.9 }), // 2nd time
      ];

      const result = applyDiversityPenalties(candidates);
      expect(result[0].final_score).toBe(1.0);
      expect(result[0].score_breakdown.diversity_penalty).toBeUndefined();

      // Penalty = 0.5 * 0.15 = 0.075. Adjusted = 0.9 - 0.075 = 0.825
      expect(result[1].final_score).toBe(0.825);
      expect(result[1].score_breakdown.diversity_penalty).toBe(0.5);
    });

    test('applies 1.0 * Wd penalty to same content type on 4th appearance', () => {
      const candidates = [
        makeScoredCandidate({ contentId: 'c1', itemType: 'post', authorId: 'a1', final_score: 1.0 }),
        makeScoredCandidate({ contentId: 'c2', itemType: 'post', authorId: 'a2', final_score: 0.9 }),
        makeScoredCandidate({ contentId: 'c3', itemType: 'post', authorId: 'a3', final_score: 0.8 }),
        makeScoredCandidate({ contentId: 'c4', itemType: 'post', authorId: 'a4', final_score: 0.7 }), // 4th post
      ];

      const result = applyDiversityPenalties(candidates);
      expect(result[0].final_score).toBe(1.0);
      expect(result[1].final_score).toBe(0.9);
      expect(result[2].final_score).toBe(0.8);

      // Penalty = 1.0 * 0.15 = 0.15. Adjusted = 0.7 - 0.15 = 0.55
      expect(result[3].final_score).toBe(0.55);
      expect(result[3].score_breakdown.diversity_penalty).toBe(1.0);
    });

    test('applies the maximum penalty instead of sum (no double-deduction)', () => {
      const candidates = [
        makeScoredCandidate({ contentId: 'c1', authorId: 'a1', itemType: 'post', final_score: 1.0 }),
        makeScoredCandidate({ contentId: 'c2', authorId: 'a2', itemType: 'post', final_score: 0.9 }),
        makeScoredCandidate({ contentId: 'c3', authorId: 'a3', itemType: 'post', final_score: 0.8 }),
        makeScoredCandidate({ contentId: 'c4', authorId: 'a1', itemType: 'post', final_score: 0.7 }), // 2nd author a1, 4th post
      ];

      const result = applyDiversityPenalties(candidates);
      // Last candidate triggers BOTH:
      // - author a1 count=1 (2nd appearance) -> author penalty = 0.5
      // - content type post count=3 (4th appearance) -> type penalty = 1.0
      // max(0.5, 1.0) = 1.0
      // Penalty = 1.0 * 0.15 = 0.15. Adjusted = 0.7 - 0.15 = 0.55
      expect(result[3].final_score).toBe(0.55);
      expect(result[3].score_breakdown.diversity_penalty).toBe(1.0);
    });

    test('score never goes below 0 (clamped at 0)', () => {
      const candidates = [
        makeScoredCandidate({ contentId: 'c1', authorId: 'a1', final_score: 1.0 }),
        makeScoredCandidate({ contentId: 'c2', authorId: 'a1', final_score: 0.05 }), // 2nd appearance, low score
      ];

      const result = applyDiversityPenalties(candidates);
      // Penalty = 0.075. 0.05 - 0.075 = -0.025 -> clamped to 0
      expect(result[1].final_score).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. rerankCandidates Pipeline Tests
  // ---------------------------------------------------------------------------
  describe('rerankCandidates', () => {
    test('returns empty array when input is empty or invalid', async () => {
      expect(await rerankCandidates([], 'user1')).toEqual([]);
      expect(await rerankCandidates(null, 'user1')).toEqual([]);
    });

    test('throws error if userId is missing', async () => {
      await expect(rerankCandidates([makeScoredCandidate()], null))
        .rejects.toThrow('rerankCandidates: `userId` is required');
    });

    test('filters out already seen content IDs', async () => {
      getSeenSet.mockResolvedValue(['c2']);
      getHiddenSet.mockResolvedValue([]);

      const candidates = [
        makeScoredCandidate({ contentId: 'c1', final_score: 1.0 }),
        makeScoredCandidate({ contentId: 'c2', final_score: 0.9 }), // seen
        makeScoredCandidate({ contentId: 'c3', final_score: 0.8 }),
      ];

      const result = await rerankCandidates(candidates, 'user1');

      expect(getSeenSet).toHaveBeenCalledWith('user1');
      expect(result.length).toBe(2);
      expect(result[0].id).toBe('c1');
      expect(result[1].id).toBe('c3');
    });

    test('re-sorts items if diversity penalty changes relative rank', async () => {
      getSeenSet.mockResolvedValue([]);
      getHiddenSet.mockResolvedValue([]);

      const candidates3 = [
        makeScoredCandidate({ contentId: 'c1', authorId: 'a1', itemType: 'post', final_score: 0.90 }),
        makeScoredCandidate({ contentId: 'c3', authorId: 'a1', itemType: 'job', final_score: 0.88 }),
        makeScoredCandidate({ contentId: 'c2', authorId: 'a2', itemType: 'post', final_score: 0.85 }),
      ];

      const result = await rerankCandidates(candidates3, 'user1');
      expect(result[0].id).toBe('c1');
      expect(result[1].id).toBe('c2');
      expect(result[2].id).toBe('c3');
    });

    test('assigns 0-indexed positions to the final resorted list', async () => {
      getSeenSet.mockResolvedValue([]);
      getHiddenSet.mockResolvedValue([]);

      const candidates = [
        makeScoredCandidate({ contentId: 'c1', final_score: 0.95 }),
        makeScoredCandidate({ contentId: 'c2', final_score: 0.85 }),
      ];

      const result = await rerankCandidates(candidates, 'user1');

      expect(result.length).toBe(2);
      expect(result[0].position).toBe(0);
      expect(result[1].position).toBe(1);
    });

    test('degrades gracefully (ignores filtering) when Redis seen set fetch fails', async () => {
      getSeenSet.mockRejectedValue(new Error('Redis connection lost'));
      getHiddenSet.mockResolvedValue([]);

      const candidates = [
        makeScoredCandidate({ contentId: 'c1', final_score: 1.0 }),
        makeScoredCandidate({ contentId: 'c2', final_score: 0.9 }),
      ];

      const result = await rerankCandidates(candidates, 'user1');

      // Check that despite the seen set failure, candidates are not dropped and are successfully returned
      expect(result.length).toBe(2);
      expect(result[0].id).toBe('c1');
      expect(result[0].position).toBe(0);
      expect(result[1].id).toBe('c2');
      expect(result[1].position).toBe(1);
    });

    // -------------------------------------------------------------------------
    // Day 3 Tests
    // -------------------------------------------------------------------------

    test('drops 4th author appearance (anti-spam)', async () => {
      getSeenSet.mockResolvedValue([]);
      getHiddenSet.mockResolvedValue([]);
      const candidates = [
        makeScoredCandidate({ contentId: 'c1', authorId: 'a1', final_score: 1.0 }),
        makeScoredCandidate({ contentId: 'c2', authorId: 'a1', final_score: 0.9 }),
        makeScoredCandidate({ contentId: 'c3', authorId: 'a1', final_score: 0.8 }),
        makeScoredCandidate({ contentId: 'c4', authorId: 'a1', final_score: 0.7 }), // 4th -> drop
      ];
      const result = await rerankCandidates(candidates, 'u1');
      expect(result.length).toBe(3);
    });

    test('drops 6th type appearance (anti-spam)', async () => {
      getSeenSet.mockResolvedValue([]);
      getHiddenSet.mockResolvedValue([]);
      const candidates = [
        makeScoredCandidate({ contentId: 'c1', authorId: 'a1', itemType: 'job', final_score: 1.0 }),
        makeScoredCandidate({ contentId: 'c2', authorId: 'a2', itemType: 'job', final_score: 0.9 }),
        makeScoredCandidate({ contentId: 'c3', authorId: 'a3', itemType: 'job', final_score: 0.8 }),
        makeScoredCandidate({ contentId: 'c4', authorId: 'a4', itemType: 'job', final_score: 0.7 }),
        makeScoredCandidate({ contentId: 'c5', authorId: 'a5', itemType: 'job', final_score: 0.6 }),
        makeScoredCandidate({ contentId: 'c6', authorId: 'a6', itemType: 'job', final_score: 0.5 }), // 6th -> drop
      ];
      const result = await rerankCandidates(candidates, 'u1');
      expect(result.length).toBe(5);
    });

    test('drops engagement bait', async () => {
      getSeenSet.mockResolvedValue([]);
      getHiddenSet.mockResolvedValue([]);
      const candidates = [
        makeScoredCandidate({ contentId: 'c1', final_score: 1.0, _candidate: { metadata: { share_count: 50, like_count: 2, comment_count: 1 } } }),
        makeScoredCandidate({ contentId: 'c2', final_score: 0.9 }),
      ];
      const result = await rerankCandidates(candidates, 'u1');
      expect(result.length).toBe(1);
      expect(result[0].id).toBe('c2');
    });

    test('injects slots exactly at expected positions', async () => {
      getSeenSet.mockResolvedValue([]);
      getHiddenSet.mockResolvedValue([]);
      // 20 organic items with unique authors and cycled types to bypass anti-spam limits
      const organic = Array(20).fill(0).map((_, i) => makeScoredCandidate({
        contentId: `o${i}`,
        authorId: `author-${i}`,
        itemType: `type-${i % 8}`,
        final_score: (20 - i) * 0.05
      }));
      
      const opps = [
        { contentId: 'opp1', itemType: 'job', score: 0.8 },
        { contentId: 'opp2', itemType: 'event', score: 0.7 },
        { contentId: 'opp3', itemType: 'job', score: 0.6 },
      ];
      const exp = [
        { contentId: 'exp1', itemType: 'post', score: 0.9 },
        { contentId: 'exp2', itemType: 'post', score: 0.8 },
        { contentId: 'exp3', itemType: 'post', score: 0.7 },
      ];

      const result = await rerankCandidates(organic, 'u1', { exploration_enabled: true }, opps, exp);
      
      expect(result.length).toBe(_FEED_PAGE_SIZE);
      
      // Explore slots: [3, 10, 17]
      expect(result[3].slot_type).toBe('exploration');
      expect(result[10].slot_type).toBe('exploration');
      expect(result[17].slot_type).toBe('exploration');

      // Opp slots: [6, 13, 19]
      expect(result[6].slot_type).toBe('opportunity');
      expect(result[13].slot_type).toBe('opportunity');
      expect(result[19].slot_type).toBe('opportunity');

      // Others organic
      expect(result[0].slot_type).toBe('organic');
      expect(result[0].position).toBe(0);
    });

    test('respects exploration_enabled flag', async () => {
      getSeenSet.mockResolvedValue([]);
      getHiddenSet.mockResolvedValue([]);
      const organic = Array(20).fill(0).map((_, i) => makeScoredCandidate({ contentId: `o${i}`, final_score: (20-i)*0.05 }));
      const exp = [{ contentId: 'exp1', itemType: 'post', score: 0.9 }];
      
      const result = await rerankCandidates(organic, 'u1', { exploration_enabled: false }, [], exp);
      
      expect(result.some(r => r.slot_type === 'exploration')).toBe(false);
    });
  });
});
