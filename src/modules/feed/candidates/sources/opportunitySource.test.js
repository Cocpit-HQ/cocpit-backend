/**
 * Unit Tests: Opportunity Candidate Source (A6)
 *
 * Run: npm test -- --testPathPattern=opportunitySource
 */

'use strict';

const {
  getOpportunityCandidates,
  _computeLocationMatch,
  _computeIntentMatch,
  _computeRecency,
  _computeRelevanceScore,
  _RELEVANCE_THRESHOLD,
} = require('./opportunitySource');
const { CANDIDATE_SOURCES } = require('../CandidateItem');

describe('opportunitySource', () => {

  describe('_computeLocationMatch', () => {
    test('exact match returns 1.0', () => {
      expect(_computeLocationMatch('San Francisco', 'san francisco')).toBe(1.0);
    });
    test('partial match returns 0.5', () => {
      expect(_computeLocationMatch('San Francisco, CA', 'San Francisco')).toBe(0.5);
    });
    test('remote/virtual returns 0.8', () => {
      expect(_computeLocationMatch('New York', 'Remote')).toBe(0.8);
      expect(_computeLocationMatch(null, 'Virtual Event')).toBe(0.8);
    });
    test('no match returns 0.0', () => {
      expect(_computeLocationMatch('New York', 'London')).toBe(0.0);
    });
    test('null user location returns 0.5', () => {
      expect(_computeLocationMatch(null, 'London')).toBe(0.5);
    });
  });

  describe('_computeIntentMatch', () => {
    test('job intent normalized', () => {
      expect(_computeIntentMatch({ job_seeker_score: 80 }, 'job')).toBe(0.8);
    });
    test('event intent normalized', () => {
      expect(_computeIntentMatch({ event_score: 120 }, 'event')).toBe(1.0); // capped
    });
    test('missing scores return 0', () => {
      expect(_computeIntentMatch(null, 'job')).toBe(0);
      expect(_computeIntentMatch({}, 'event')).toBe(0);
    });
  });

  describe('_computeRelevanceScore', () => {
    test('product of 3 factors', () => {
      expect(_computeRelevanceScore(1.0, 0.8, 1.0)).toBe(0.8);
      expect(_computeRelevanceScore(0.5, 0.5, 0.5)).toBe(0.125);
    });
  });

  describe('getOpportunityCandidates', () => {
    const mockPool = { query: jest.fn() };
    const mockDate = new Date().toISOString();

    beforeEach(() => {
      jest.clearAllMocks();
    });

    test('returns empty if userId or pool missing', async () => {
      expect(await getOpportunityCandidates({ pool: mockPool })).toEqual([]);
      expect(await getOpportunityCandidates({ userId: 'u1' })).toEqual([]);
    });

    test('filters items below relevance threshold', async () => {
      mockPool.query.mockImplementation(async (sql) => {
        if (sql.includes('user_intent_scores')) return { rows: [{ location: 'London', job_seeker_score: 100, event_score: 100 }] };
        if (sql.includes('jobs')) return { rows: [{ content_id: 'j1', type: 'job', location: 'London', created_at: mockDate }] };
        if (sql.includes('events')) return { rows: [{ content_id: 'e1', type: 'event', location: 'Tokyo', created_at: mockDate }] }; // Tokyo = 0.0 loc match
        return { rows: [] };
      });

      const results = await getOpportunityCandidates({ userId: 'u1', pool: mockPool });
      expect(results.length).toBe(1);
      expect(results[0].contentId).toBe('j1');
      expect(results[0].isOpportunity).toBe(true);
    });

    test('maps sources correctly', async () => {
      mockPool.query.mockImplementation(async (sql) => {
        if (sql.includes('user_intent_scores')) return { rows: [{ location: 'London', job_seeker_score: 100, event_score: 100 }] };
        if (sql.includes('jobs')) return { rows: [{ content_id: 'j1', type: 'job', location: 'London', created_at: mockDate }] };
        if (sql.includes('events')) return { rows: [{ content_id: 'e1', type: 'event', location: 'London', created_at: mockDate }] };
        return { rows: [] };
      });

      const results = await getOpportunityCandidates({ userId: 'u1', pool: mockPool });
      expect(results.length).toBe(2);
      expect(results.some(r => r.source === CANDIDATE_SOURCES.OPPORTUNITY_JOB)).toBe(true);
      expect(results.some(r => r.source === CANDIDATE_SOURCES.OPPORTUNITY_EVENT)).toBe(true);
      expect(results.every(r => r.isOpportunity)).toBe(true);
    });
  });
});
