/**
 * Performance & Concurrency Tests: Benchmark Feed Engine Concurrency (B11.3)
 *
 * Sprint Task: Day 5 — Task B11.3
 * Owner: Dev B
 * AI-Assisted: Yes (Antigravity)
 * Contracts read: contracts/api-contracts.md (FROZEN)
 * Last reviewed: 2026-05-28
 *
 * Runs: npx jest src/modules/feed/tests/feed.performance.test.js --forceExit
 */

'use strict';

const { performance } = require('perf_hooks');

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

function clearMockRedis() {
  for (const k in mockRedisStore) {
    delete mockRedisStore[k];
  }
}

describe('feed.performance.test.js — Concurrency & Latency Benchmark', () => {

  beforeEach(() => {
    jest.clearAllMocks();
    clearMockRedis();

    // Mock highly performant DB response simulation
    pool.query.mockImplementation((sql) => {
      if (sql.includes('posts')) {
        const posts = Array.from({ length: 15 }).map((_, i) => ({
          content_id: `post-uuid-${i}`,
          type: 'post',
          author_id: `author-uuid-${i}`,
          created_at: new Date().toISOString(),
          like_count: 50 + i,
          comment_count: 10,
          share_count: 5,
          report_count: 0,
        }));
        return Promise.resolve({ rows: posts, rowCount: posts.length });
      }
      if (sql.includes('user_intent_scores')) {
        return Promise.resolve({
          rows: [{ job_seeker_score: 90, creator_score: 80, event_score: 70 }],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
  });

  // ===========================================================================
  // B11.3 — Concurrency Benchmark (20 requests < 500ms)
  // ===========================================================================
  test('Launches 20 concurrent requests and verifies response latency is within SLA (< 500ms)', async () => {
    const totalRequests = 20;
    const requestPromises = [];

    const startTime = performance.now();

    for (let i = 0; i < totalRequests; i++) {
      requestPromises.push(
        feedService.getFeed({
          userId: `user-perf-uuid-${i}`,
          limit: 10,
          context: 'home',
          pool,
        })
      );
    }

    const results = await Promise.all(requestPromises);
    const endTime = performance.now();
    const totalDuration = endTime - startTime;
    const averageDuration = totalDuration / totalRequests;

    // Assert SLA thresholds
    expect(results.length).toBe(totalRequests);
    results.forEach(res => {
      expect(res.ok).toBe(true);
      expect(res.data.items.length).toBeLessThanOrEqual(10);
    });

    console.log(`[Performance Benchmark] Processed ${totalRequests} concurrent requests.`);
    console.log(`[Performance Benchmark] Total time: ${totalDuration.toFixed(2)}ms`);
    console.log(`[Performance Benchmark] Average request time: ${averageDuration.toFixed(2)}ms`);

    // Verify average latency is well under the 500ms SLA
    expect(averageDuration).toBeLessThan(500);
  });

});
