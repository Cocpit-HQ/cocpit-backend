/**
 * Unit Tests: Feed Analytics Service (A8)
 *
 * Run: npm test -- --testPathPattern=feedAnalytics.service
 */

'use strict';
/* global jest, describe, test, expect, beforeEach */

const { trackEvent, processEventQueue, _validateEvent } = require('./feedAnalytics.service');
const redis = require('../../../core/cache/redis');
const validSessionId = '123e4567-e89b-12d3-a456-426614174000';
const validUserId = '123e4567-e89b-12d3-a456-426614174001';
const validItemId = '123e4567-e89b-12d3-a456-426614174002';

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
        event_type: 'like', item_id: validItemId, item_type: 'post',
        user_id: validUserId, session_id: validSessionId, position: 0, context: 'home'
      });
      expect(res.valid).toBe(true);
      expect(res.normalized.event_type).toBe('like');
    });

    test('maps schema-only types to DB types', () => {
      const res = _validateEvent({
        event_type: 'dismiss', item_id: validItemId, item_type: 'post',
        user_id: validUserId, session_id: validSessionId, position: 0, context: 'home'
      });
      expect(res.valid).toBe(true);
      expect(res.normalized.event_type).toBe('skip');
    });

    test('rejects a non-UUID session ID', () => {
      const res = _validateEvent({
        event_type: 'like', item_id: validItemId, item_type: 'post',
        user_id: validUserId, session_id: 's1', position: 0, context: 'home'
      });
      expect(res.valid).toBe(false);
      expect(res.errors).toContain('session_id must be a valid UUID');
    });
  });

  describe('trackEvent', () => {
    const validEvent = {
      event_type: 'impression', item_id: validItemId, item_type: 'post',
      user_id: validUserId, session_id: validSessionId, position: 0, context: 'home'
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
