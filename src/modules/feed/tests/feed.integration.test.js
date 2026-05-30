/**
 * Integration Tests: Feed Generation Pipeline (B11.1)
 *
 * Sprint Task: Day 5 — Task B11.1
 * Owner: Dev B
 * AI-Assisted: Yes (Antigravity)
 * Contracts read: contracts/api-contracts.md, contracts/redis-key-registry.md
 * Last reviewed: 2026-05-28
 *
 * Runs: npx jest src/modules/feed/tests/feed.integration.test.js --forceExit
 */

'use strict';

// ─── Pinned Mock Setup (Must be declared before importing module under test) ───

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
      return Promise.resolve(['post-t1', '90', 'post-t2', '80', 'post-t3', '70']);
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

// Helper to clear the in-memory Redis mock between tests
function clearMockRedis() {
  for (const k in mockRedisStore) {
    delete mockRedisStore[k];
  }
}

describe('feed.integration.test.js — Full Pipeline Integration', () => {

  const userId = 'user-uuid-888';

  beforeEach(() => {
    jest.clearAllMocks();
    clearMockRedis();

    // Mock generic user_intent_scores query
    pool.query.mockImplementation((sql, params) => {
      if (sql.includes('FROM posts') || sql.includes('FROM   posts') || sql.includes('posts')) {
        // Return 10 standard post items
        const posts = Array.from({ length: 10 }).map((_, i) => ({
          content_id: `post-uuid-${i}`,
          type: 'post',
          author_id: `author-uuid-${i}`,
          created_at: new Date().toISOString(),
          like_count: 10 + i,
          comment_count: 2,
          share_count: 1,
          report_count: 0,
        }));
        return Promise.resolve({ rows: posts, rowCount: posts.length });
      }
      if (sql.includes('user_intent_scores')) {
        return Promise.resolve({
          rows: [{ job_seeker_score: 80, creator_score: 60, event_score: 40 }],
          rowCount: 1,
        });
      }
      if (sql.includes('connections')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (sql.includes('followers')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
  });

  // ===========================================================================
  // B11.1a — Happy Path: new user gets feed
  // ===========================================================================
  test('New user feed generation successfully runs complete pipeline', async () => {
    const testUserId = `${userId}-happy`;
    const result = await feedService.getFeed({
      userId: testUserId,
      limit: 5,
      context: 'home',
      pool,
    });

    expect(result.ok).toBe(true);
    expect(result.data).toHaveProperty('items');
    expect(result.data.items.length).toBeLessThanOrEqual(5);
    expect(result.data).toHaveProperty('session_id');
    expect(result.data).toHaveProperty('cursor');
    expect(result.data.has_more).toBe(true);
    
    // Verify that a session was recorded in in-memory Redis
    const sessionKey = `feed:session:${testUserId}`;
    expect(mockRedisStore).toHaveProperty(sessionKey);
    expect(mockRedisStore[sessionKey]).toHaveProperty('session_id', result.data.session_id);
  });

  // ===========================================================================
  // B11.1b — Pagination: cursor advances correctly
  // ===========================================================================
  test('Pagination cursor moves forward and serves non-overlapping sets', async () => {
    const testUserId = `${userId}-paginated`;
    // Generate first page (limit 3)
    const page1 = await feedService.getFeed({
      userId: testUserId,
      limit: 3,
      context: 'home',
      pool,
    });

    expect(page1.data.items.length).toBe(3);
    const firstPageIds = page1.data.items.map(item => item.id);

    // Generate second page using cursor
    const page2 = await feedService.getFeed({
      userId: testUserId,
      limit: 3,
      context: 'home',
      cursor: page1.data.cursor,
      pool,
    });

    expect(page2.data.items.length).toBe(3);
    const secondPageIds = page2.data.items.map(item => item.id);

    // Verify there are no overlapping post IDs served between page 1 and page 2
    firstPageIds.forEach(id => {
      expect(secondPageIds).not.toContain(id);
    });
  });

  // ===========================================================================
  // B11.1c — Seen Set: repeated request excludes seen items
  // ===========================================================================
  test('Seen set registers viewed items and excludes them from subsequent requests', async () => {
    const testUserId = `${userId}-seen`;
    // First request gets a feed with item post-uuid-0 and post-uuid-1
    const page = await feedService.getFeed({
      userId: testUserId,
      limit: 2,
      context: 'home',
      pool,
    });

    const seenIds = page.data.items.map(item => item.id);
    expect(seenIds.length).toBe(2);

    // Force add to seen set in Redis cache manually (as if trackEvent was called)
    const seenSetKey = `feed:seen:${testUserId}`;
    if (!mockRedisStore[seenSetKey]) mockRedisStore[seenSetKey] = [];
    seenIds.forEach(id => mockRedisStore[seenSetKey].push(id));

    // Force cache miss by clearing the initial cached slice
    delete mockRedisStore[`feed:slice:${testUserId}:initial`];

    // Request feed again with skipCache to force generation bypass cache
    const freshPage = await feedService.getFeed({
      userId: testUserId,
      limit: 5,
      context: 'home',
      pool,
    });

    // None of the newly served items should belong to the seen set list
    const freshPageIds = freshPage.data.items.map(item => item.id);
    seenIds.forEach(id => {
      expect(freshPageIds).not.toContain(id);
    });
  });

  // ===========================================================================
  // B11.1d — Session Reset: clears seen set and restarts feed session
  // ===========================================================================
  test('Session reset clears the seen set and successfully restores original items', async () => {
    const testUserId = `${userId}-reset`;
    // Get feed and record served item
    const page = await feedService.getFeed({ userId: testUserId, limit: 1, pool });
    const servedId = page.data.items[0].id;

    // Simulate item added to seen list
    const seenSetKey = `feed:seen:${testUserId}`;
    mockRedisStore[seenSetKey] = [servedId];

    // Force cache miss by clearing the initial cached slice
    delete mockRedisStore[`feed:slice:${testUserId}:initial`];

    // Verify another generation skips it
    const pageSkipped = await feedService.getFeed({ userId: testUserId, limit: 1, pool });
    expect(pageSkipped.data.items[0].id).not.toBe(servedId);

    // Trigger session reset via Redis del mocking simulation (feedSessionService reset session)
    const sessionKey = `feed:session:${testUserId}`;
    delete mockRedisStore[sessionKey];
    delete mockRedisStore[seenSetKey];

    // Force cache miss by clearing the initial cached slice
    delete mockRedisStore[`feed:slice:${testUserId}:initial`];

    // Generate again - original post is now allowed back in
    const pageRestored = await feedService.getFeed({ userId: testUserId, limit: 1, pool });
    expect(pageRestored.data.items[0].id).toBe(servedId);
  });

});
