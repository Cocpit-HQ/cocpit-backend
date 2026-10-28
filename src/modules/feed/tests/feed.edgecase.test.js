/**
 * Edge Case Tests: Cold Starts, Large Seen Sets, and Empty Candidate Pools (B11.4)
 *
 * Sprint Task: Day 5 — Task B11.4
 * Owner: Dev B
 * AI-Assisted: Yes (Antigravity)
 * Contracts read: contracts/api-contracts.md, contracts/redis-key-registry.md
 * Last reviewed: 2026-05-28
 *
 * Runs: npx jest src/modules/feed/tests/feed.edgecase.test.js --forceExit
 */

'use strict';
/* global jest, describe, test, expect, beforeEach */

const mockRedisStore = {};

jest.mock('../../../core/cache/redis', () => {
  const mockRedis = {
    get: jest.fn(key => {
      const val = mockRedisStore[key];
      return Promise.resolve(val ? (typeof val === 'object' ? JSON.stringify(val) : String(val)) : null);
    }),
    set: jest.fn((key, val) => {
      try {
        mockRedisStore[key] = JSON.parse(val);
      } catch {
        mockRedisStore[key] = val;
      }
      return Promise.resolve('OK');
    }),
    del: jest.fn(key => {
      delete mockRedisStore[key];
      return Promise.resolve(1);
    }),
    exists: jest.fn(key => {
      return Promise.resolve(mockRedisStore[key] !== undefined ? 1 : 0);
    }),
    sadd: jest.fn((key, ...members) => {
      if (!mockRedisStore[key]) mockRedisStore[key] = [];
      let added = 0;
      members.forEach(m => {
        if (!mockRedisStore[key].includes(m)) {
          mockRedisStore[key].push(m);
          added++;
        }
      });
      return Promise.resolve(added);
    }),
    srem: jest.fn((key, ...members) => {
      if (!mockRedisStore[key]) return Promise.resolve(0);
      let removed = 0;
      mockRedisStore[key] = mockRedisStore[key].filter(m => {
        if (members.includes(m)) {
          removed++;
          return false;
        }
        return true;
      });
      return Promise.resolve(removed);
    }),
    scard: jest.fn(key => {
      return Promise.resolve(mockRedisStore[key] ? mockRedisStore[key].length : 0);
    }),
    smembers: jest.fn(key => {
      return Promise.resolve(mockRedisStore[key] || []);
    }),
    srandmember: jest.fn((key, count) => {
      const members = mockRedisStore[key] || [];
      return Promise.resolve(members.slice(0, count));
    }),
    hgetall: jest.fn(key => {
      return Promise.resolve(mockRedisStore[key] || null);
    }),
    hincrby: jest.fn((key, field, increment) => {
      if (!mockRedisStore[key]) mockRedisStore[key] = {};
      const val = parseInt(mockRedisStore[key][field], 10) || 0;
      mockRedisStore[key][field] = String(val + increment);
      return Promise.resolve(Number(mockRedisStore[key][field]));
    }),
    zrevrange: jest.fn(() => {
      return Promise.resolve([]);
    }),
    llen: jest.fn(key => {
      return Promise.resolve(mockRedisStore[key] ? mockRedisStore[key].length : 0);
    }),
    lpush: jest.fn((key, val) => {
      if (!mockRedisStore[key]) mockRedisStore[key] = [];
      mockRedisStore[key].unshift(JSON.parse(val));
      return Promise.resolve(mockRedisStore[key].length);
    }),
    pipeline: jest.fn(() => {
      const chain = {
        hset: jest.fn((key, field, val) => {
          if (typeof field === 'object') {
            mockRedisStore[key] = { ...mockRedisStore[key], ...field };
          } else {
            if (!mockRedisStore[key]) mockRedisStore[key] = {};
            mockRedisStore[key][field] = String(val);
          }
          return chain;
        }),
        hmset: jest.fn((key, obj) => {
          mockRedisStore[key] = { ...mockRedisStore[key], ...obj };
          return chain;
        }),
        set: jest.fn((key, val) => {
          mockRedisStore[key] = val;
          return chain;
        }),
        sadd: jest.fn((key, ...members) => {
          if (!mockRedisStore[key]) mockRedisStore[key] = [];
          members.forEach(m => {
            if (!mockRedisStore[key].includes(m)) mockRedisStore[key].push(m);
          });
          return chain;
        }),
        del: jest.fn(key => {
          delete mockRedisStore[key];
          return chain;
        }),
        expire: jest.fn(() => chain),
        exec: jest.fn(() => Promise.resolve([])),
      };
      return chain;
    }),
  };
  return mockRedis;
});

jest.mock('../../../core/db/pool', () => ({
  query: jest.fn(),
}));

// ─── Module under test ────────────────────────────────────────────────────────

const feedService = require('../feed.service');
const pool = require('../../../core/db/pool');
const feedCache = require('../cache/feedCache');

function clearMockRedis() {
  for (const k in mockRedisStore) {
    delete mockRedisStore[k];
  }
}

describe('feed.edgecase.test.js — Feed Engine Resilience and Edge Cases', () => {

  const userId = 'edgecase-user-uuid';

  beforeEach(() => {
    jest.clearAllMocks();
    clearMockRedis();
  });

  // ===========================================================================
  // B11.4a — Cold Start User: zero connections, no intent scores, gets fallbacks
  // ===========================================================================
  test('TC-E01: Cold start user with zero profile signals successfully fallback to trending items', async () => {
    // Mock database queries returning empty rows for relationship matches and user signals
    pool.query.mockImplementation((sql, params) => {
      if (sql.includes('p.post_id = ANY($3::uuid[])')) {
        const rows = params[2].map((postId) => ({ post_id: postId, is_reported: false }));
        return Promise.resolve({ rows, rowCount: rows.length });
      }
      if (sql.includes("created_at >= NOW() - INTERVAL '24 hours'")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (sql.includes('posts')) {
        // Trending source query is triggered as a fallback; return 5 fallback trending items
        const posts = Array.from({ length: 5 }).map((_, i) => ({
          content_id: `post-trending-uuid-${i}`,
          type: 'post',
          author_id: `author-uuid-${i}`,
          created_at: new Date().toISOString(),
          like_count: 10 + i,
          comment_count: 0,
          share_count: 0,
          report_count: 0,
        }));
        return Promise.resolve({ rows: posts, rowCount: posts.length });
      }
      if (sql.includes('user_intent_scores')) {
        return Promise.resolve({ rows: [], rowCount: 0 }); // cold start - no intent
      }
      if (sql.includes('connections') || sql.includes('followers')) {
        return Promise.resolve({ rows: [], rowCount: 0 }); // no connections
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const result = await feedService.getFeed({
      userId: `${userId}-cold`,
      limit: 10,
      context: 'home',
      pool,
    });

    expect(result.ok).toBe(true);
    expect(result.data.items.length).toBeGreaterThan(0);
    // Verifies items served are indeed from fallback trending items
    expect(result.data.items[0].id).toContain('post-trending-uuid-');
  });

  // ===========================================================================
  // B11.4b — Seen Sets with 5000+ Items: triggers seen set trimming
  // ===========================================================================
  test('TC-E02: Large seen set (5000+ members) triggers overflow trimming and remains fully functional', async () => {
    const testUserId = `${userId}-large-seen`;
    const seenSetKey = `feed:seen:${testUserId}`;

    // Populate mockRedisStore with a large array exceeding limits.SEEN_SET_MAX (5000)
    mockRedisStore[seenSetKey] = Array.from({ length: 5010 }).map((_, i) => `item-seen-${i}`);

    // Mock Redis scard and srandmember functions
    const redisMock = require('../../../core/cache/redis');
    redisMock.scard.mockResolvedValue(5010);
    redisMock.srandmember.mockResolvedValue(['item-seen-0', 'item-seen-1', 'item-seen-2', 'item-seen-3', 'item-seen-4', 'item-seen-5', 'item-seen-6', 'item-seen-7', 'item-seen-8', 'item-seen-9']);

    // Attempt to add new elements which triggers trimming
    await feedCache.addToSeenSet(testUserId, ['item-new-1', 'item-new-2']);

    // Expecting srem to be triggered to trim down the excess
    expect(redisMock.srem).toHaveBeenCalledWith(seenSetKey, expect.any(String), expect.any(String), expect.any(String), expect.any(String), expect.any(String), expect.any(String), expect.any(String), expect.any(String), expect.any(String), expect.any(String));
  });

  // ===========================================================================
  // B11.4c — Empty Candidate Pool Handling
  // ===========================================================================
  test('TC-E03: Complete empty candidates pool returns clean response with zero items', async () => {
    // Mock absolutely zero database hits or candidates returned
    pool.query.mockResolvedValue({ rows: [], rowCount: 0 });

    const result = await feedService.getFeed({
      userId: `${userId}-empty`,
      limit: 10,
      context: 'home',
      pool,
    });

    expect(result.ok).toBe(true);
    expect(result.data.items).toEqual([]);
    expect(result.meta.total_candidates).toBe(0);
  });

  // ===========================================================================
  // B11.4d — Invalid Cursor Injection Handling
  // ===========================================================================
  test('TC-E04: Expired or invalid cursors fallback gracefully to new start', async () => {
    pool.query.mockImplementation((sql, params) => {
      if (sql.includes('p.post_id = ANY($3::uuid[])')) {
        const rows = params[2].map((postId) => ({ post_id: postId, is_reported: false }));
        return Promise.resolve({ rows, rowCount: rows.length });
      }
      if (sql.includes("created_at >= NOW() - INTERVAL '24 hours'")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (sql.includes('posts')) {
        const posts = [{ content_id: 'post-new-uuid', type: 'post', author_id: 'a1', created_at: new Date().toISOString() }];
        return Promise.resolve({ rows: posts, rowCount: posts.length });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    // Request with custom invalid/expired cursor
    const result = await feedService.getFeed({
      userId: `${userId}-invalid-cursor`,
      cursor: 'invalid_expired_cursor_123',
      limit: 10,
      context: 'home',
      pool,
    });

    // Pipeline executes fallback (skips cache hit since key doesn't exist and builds fresh)
    expect(result.ok).toBe(true);
    expect(result.data.items.length).toBeGreaterThan(0);
    expect(result.data.items[0].id).toBe('post-new-uuid');
  });

});
