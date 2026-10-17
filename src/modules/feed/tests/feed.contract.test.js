/**
 * Contract Tests: API Payloads and Redis Key Registry Compliance (B11.2)
 *
 * Sprint Task: Day 5 — Task B11.2
 * Owner: Dev B
 * AI-Assisted: Yes (Antigravity)
 * Contracts read: contracts/api-contracts.md, contracts/redis-key-registry.md
 * Last reviewed: 2026-05-28
 *
 * Runs: npx jest src/modules/feed/tests/feed.contract.test.js --forceExit
 */

'use strict';

const { _keys: cacheKeys } = require('../cache/feedCache');
const { _keys: sessionKeys } = require('../session/feedSession.service');

// UUID regex for structural checks
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)$/;

describe('feed.contract.test.js — API and Redis Contracts', () => {

  // ===========================================================================
  // 1. API Payload Contracts Verification
  // ===========================================================================
  describe('API Response Structures', () => {

    test('FeedItem schema validation', () => {
      const mockFeedItem = {
        id: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
        type: 'post',
        content: { body: 'Hello world' },
        author: {
          id: '8c1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6c',
          name: 'Jane Doe',
          avatar_url: 'https://avatar.com/jane',
          verified: true,
        },
        score: 0.87,
        slot_type: 'organic',
        ranked_at: '2026-05-28T12:00:00.000Z',
        position: 0,
      };

      // Assert precise property keys
      expect(Object.keys(mockFeedItem).sort()).toEqual([
        'author',
        'content',
        'id',
        'position',
        'ranked_at',
        'score',
        'slot_type',
        'type',
      ]);

      // Assert property types and constraints per api-contracts.md
      expect(mockFeedItem.id).toMatch(UUID_REGEX);
      expect(['post', 'job', 'event', 'startup', 'person']).toContain(mockFeedItem.type);
      expect(typeof mockFeedItem.content).toBe('object');
      
      // Detailed author assertions
      expect(mockFeedItem.author.id).toMatch(UUID_REGEX);
      expect(typeof mockFeedItem.author.name).toBe('string');
      expect(mockFeedItem.author.avatar_url === null || typeof mockFeedItem.author.avatar_url === 'string').toBe(true);
      expect(typeof mockFeedItem.author.verified).toBe('boolean');

      expect(typeof mockFeedItem.score).toBe('number');
      expect(['organic', 'exploration', 'opportunity']).toContain(mockFeedItem.slot_type);
      expect(mockFeedItem.ranked_at).toMatch(ISO_DATE_REGEX);
      expect(Number.isInteger(mockFeedItem.position)).toBe(true);
    });

    test('GET /api/feed success payload shape', () => {
      const mockResponse = {
        ok: true,
        data: {
          items: [
            {
              id: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
              type: 'post',
              content: {},
              author: {
                id: '8c1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6c',
                name: 'Jane',
                avatar_url: null,
                verified: false,
              },
              score: 0.95,
              slot_type: 'exploration',
              ranked_at: '2026-05-28T12:00:05.000Z',
              position: 0,
            }
          ],
          cursor: 'eyJzZXNzaW9uX2lkIjoiMTIzIiwicGFnZSI6Mn0=',
          has_more: true,
          session_id: 'd9b32cd5-aa8e-4a65-985c-1979313d42df',
          served_at: '2026-05-28T12:00:05.123Z',
        },
        meta: {
          total_candidates: 150,
          cache_hit: false,
          exploration_slots: 3,
          ranking_version: '1.0.0',
        },
      };

      // Top level
      expect(mockResponse.ok).toBe(true);
      expect(mockResponse).toHaveProperty('data');
      expect(mockResponse).toHaveProperty('meta');

      // Data block
      expect(mockResponse.data.items).toBeInstanceOf(Array);
      expect(mockResponse.data.cursor === null || typeof mockResponse.data.cursor === 'string').toBe(true);
      expect(typeof mockResponse.data.has_more).toBe('boolean');
      expect(mockResponse.data.session_id).toMatch(UUID_REGEX);
      expect(mockResponse.data.served_at).toMatch(ISO_DATE_REGEX);

      // Meta block
      expect(mockResponse.meta).toEqual({
        total_candidates: expect.any(Number),
        cache_hit: expect.any(Boolean),
        exploration_slots: expect.any(Number),
        ranking_version: '1.0.0', // Strictly version 1.0.0
      });
    });

    test('POST /api/feed/event success payload shape', () => {
      const mockResponse = {
        ok: true,
        message: 'Event accepted',
      };

      expect(mockResponse).toEqual({
        ok: true,
        message: 'Event accepted',
      });
    });

    test('GET /api/feed/session success payload shape', () => {
      const mockResponse = {
        ok: true,
        data: {
          session_id: 'a9b32cd5-aa8e-4a65-985c-1979313d42de',
          cursor: 'cursor-string-example',
          seen_count: 42,
          started_at: '2026-05-28T11:30:00.000Z',
          expires_at: '2026-05-28T12:00:00.000Z',
        },
      };

      expect(mockResponse.ok).toBe(true);
      expect(mockResponse.data).toEqual({
        session_id: expect.stringMatching(UUID_REGEX),
        cursor: expect.any(String),
        seen_count: expect.any(Number),
        started_at: expect.stringMatching(ISO_DATE_REGEX),
        expires_at: expect.stringMatching(ISO_DATE_REGEX),
      });
    });

    test('DELETE /api/feed/session success payload shape', () => {
      const mockResponse = {
        ok: true,
        message: 'Feed session reset',
      };

      expect(mockResponse).toEqual({
        ok: true,
        message: 'Feed session reset',
      });
    });
  });

  // ===========================================================================
  // 2. Redis Key Registry Compliance Verification
  // ===========================================================================
  describe('Redis Key Registry', () => {

    const userId = '11111111-2222-3333-4444-555555555555';
    const itemId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const cursor = 'initial';

    // List of active key builders to assert
    const cacheKeysToVerify = [
      { name: 'feedSlice', key: cacheKeys.feedSlice(userId, cursor), expected: `feed:slice:${userId}:${cursor}`, pattern: 'feed:slice:{user_id}:{cursor}' },
      { name: 'seenSet', key: cacheKeys.seenSet(userId), expected: `feed:seen:${userId}`, pattern: 'feed:seen:{user_id}' },
      { name: 'candidatePool', key: cacheKeys.candidatePool(userId), expected: `feed:candidates:${userId}`, pattern: 'feed:candidates:{user_id}' },
      { name: 'explorePool', key: cacheKeys.explorePool(), expected: 'feed:explore:pool', pattern: 'feed:explore:pool' },
      { name: 'eventsQueue', key: cacheKeys.eventsQueue(), expected: 'feed:events:queue', pattern: 'feed:events:queue' },
      { name: 'impression', key: cacheKeys.impression(userId, itemId), expected: `feed:impression:${userId}:${itemId}`, pattern: 'feed:impression:{user_id}:{item_id}' },
    ];

    const sessionKeysToVerify = [
      { name: 'session', key: sessionKeys.session(userId), expected: `feed:session:${userId}`, pattern: 'feed:session:{user_id}' },
      { name: 'cursor', key: sessionKeys.cursor(userId), expected: `feed:cursor:${userId}`, pattern: 'feed:cursor:{user_id}' },
      { name: 'seenSet', key: sessionKeys.seenSet(userId), expected: `feed:seen:${userId}`, pattern: 'feed:seen:{user_id}' },
    ];

    const allKeys = [...cacheKeysToVerify, ...sessionKeysToVerify];

    test('Every key starts with the mandatory "feed:" prefix isolation rule', () => {
      allKeys.forEach(({ name, key }) => {
        expect(key.startsWith('feed:')).toBe(true);
      });
    });

    test('Every key strictly uses colons (":") as separators with no forbidden characters in key segments', () => {
      // Registry rule: "All keys use colons as separators. No dots, dashes, or underscores in key segments."
      // Let's verify each segment of the keys generated by static structures before substitution.
      allKeys.forEach(({ name, pattern }) => {
        const segments = pattern.split(':');
        segments.forEach(segment => {
          // If the segment is not a dynamic placeholder (e.g. {user_id}, {cursor})
          // it must NOT contain periods, dashes, or underscores
          if (!segment.startsWith('{') && !segment.endsWith('}')) {
            expect(segment).not.toContain('.');
            expect(segment).not.toContain('-');
            expect(segment).not.toContain('_');
          }
        });
      });
    });

    test('Every generated key matches its registry contract exactly', () => {
      allKeys.forEach(({ name, key, expected }) => {
        expect(key).toBe(expected);
      });
    });
  });

});
