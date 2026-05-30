/**
 * Unit Tests: Feed Analytics Service (A8)
 *
 * Run: npm test -- --testPathPattern=feedAnalytics.service
 */

'use strict';

const { trackEvent, processEventQueue, _validateEvent, _isDuplicateImpression, _EVENTS_QUEUE_KEY } = require('./feedAnalytics.service');
const redis = require('../../../core/cache/redis');

const mockPipeline = {
  rpop: jest.fn(),
  exec: jest.fn().mockResolvedValue([]),
};

jest.mock('../../../core/cache/redis', () => ({
  exists: jest.fn(),
  set: jest.fn(),
  llen: jest.fn(),
  lpush: jest.fn(),
  pipeline: jest.fn(() => mockPipeline),
}));


describe('feedAnalytics.service', () => {

  describe('_validateEvent', () => {
    test('requires base fields', () => {
      const res = _validateEvent({});
      expect(res.valid).toBe(false);
      expect(res.errors.length).toBeGreaterThan(0);
    });

    test('accepts valid DB types', () => {
      const res = _validateEvent({
        event_type: 'like', item_id: 'i1', item_type: 'post',
        user_id: 'u1', session_id: 's1', position: 0, context: 'home'
      });
      expect(res.valid).toBe(true);
      expect(res.normalized.event_type).toBe('like');
    });

    test('maps schema-only types to DB types', () => {
      const res = _validateEvent({
        event_type: 'dismiss', item_id: 'i1', item_type: 'post',
        user_id: 'u1', session_id: 's1', position: 0, context: 'home'
      });
      expect(res.valid).toBe(true);
      expect(res.normalized.event_type).toBe('skip');
    });
  });

  describe('trackEvent', () => {
    const validEvent = {
      event_type: 'impression', item_id: 'i1', item_type: 'post',
      user_id: 'u1', session_id: 's1', position: 0, context: 'home'
    };

    beforeEach(() => {
      jest.clearAllMocks();
    });

    test('dedups impressions', async () => {
      redis.exists.mockResolvedValueOnce(1); // duplicate

      const res = await trackEvent(validEvent);
      
      expect(res.accepted).toBe(true);
      expect(res.duplicate).toBe(true);
      expect(redis.lpush).not.toHaveBeenCalled();
    });

    test('pushes to queue for new impression', async () => {
      redis.exists.mockResolvedValueOnce(0); // new
      redis.llen.mockResolvedValueOnce(10); // queue space available

      const res = await trackEvent(validEvent);
      
      expect(res.accepted).toBe(true);
      expect(res.duplicate).toBe(false);
      expect(redis.set).toHaveBeenCalled(); // mark seen
      expect(redis.lpush).toHaveBeenCalled();
    });
  });

  describe('processEventQueue', () => {

    beforeEach(() => {
      jest.clearAllMocks();
      mockPipeline.rpop.mockClear();
      mockPipeline.exec.mockClear();
    });

    test('drains queue and inserts', async () => {
      const mockPool = { query: jest.fn().mockResolvedValue({}) };
      const mockEvent = { event_type: 'like', item_id: 'i1' };
      const pipeline = mockPipeline;
      pipeline.exec.mockResolvedValueOnce([
        [null, JSON.stringify(mockEvent)],
        [null, JSON.stringify(mockEvent)],
        [new Error('redis miss'), null]
      ]);

      const count = await processEventQueue(mockPool, 3);
      
      expect(count).toBe(2);
      expect(mockPool.query).toHaveBeenCalledTimes(2);
    });

    test('graceful on db failure', async () => {
      const mockPool = { query: jest.fn() };
      const mockEvent = { event_type: 'like', item_id: 'i1' };
      const pipeline = mockPipeline;
      pipeline.exec.mockResolvedValueOnce([
        [null, JSON.stringify(mockEvent)],
        [null, JSON.stringify(mockEvent)]
      ]);
      mockPool.query.mockRejectedValueOnce(new Error('db crash'));
      mockPool.query.mockResolvedValueOnce({}); // 2nd succeeds

      const count = await processEventQueue(mockPool, 2);
      
      expect(count).toBe(1); // 1 success, 1 failure
    });
  });
});
