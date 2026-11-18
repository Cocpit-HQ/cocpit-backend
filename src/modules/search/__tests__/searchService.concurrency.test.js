'use strict';

const pool = require('../../../core/db/pool');
const redis = require('../../../core/cache/redis');
const searchService = require('../search.service');

describe('Search Service Concurrency & Caching Integration Suite', () => {
  let mockClient;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient = {
      query: jest.fn().mockImplementation((sql) => {
        if (typeof sql === 'string' && sql.startsWith('SET statement_timeout')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn(),
    };
  });

  describe('1. Single Connection Pool Acquisition for type=all', () => {
    test('acquires exactly 1 client from pool and executes subroutines on the same connection', async () => {
      const connectSpy = jest.spyOn(pool, 'connect').mockResolvedValue(mockClient);

      const result = await searchService.executeSearch({
        q: 'test',
        type: 'all',
        actor: { type: 'USER', id: 'user-123' },
      });

      // Crucial: Must connect exactly 1 time, NOT 5 or 6 times!
      expect(connectSpy).toHaveBeenCalledTimes(1);
      expect(mockClient.release).toHaveBeenCalledTimes(1);

      // Verify session timeout was configured and then reset without BEGIN/COMMIT
      const sqlCalls = mockClient.query.mock.calls.map(c => c[0]);
      expect(sqlCalls).toContain('SET statement_timeout = 3500');
      expect(sqlCalls).toContain('SET statement_timeout = 0');
      expect(sqlCalls).not.toContain('BEGIN');
      expect(sqlCalls).not.toContain('COMMIT');

      // Verify sections structure
      expect(result.status).toBe('success');
      expect(result.sections).toHaveProperty('people');
      expect(result.sections).toHaveProperty('companies');
      expect(result.sections).toHaveProperty('institutes');
      expect(result.sections).toHaveProperty('posts');
      expect(result.sections).toHaveProperty('hashtags');

      connectSpy.mockRestore();
    });
  });

  describe('2. Redis Caching & Resilience', () => {
    test('serves cached result on cache hit without touching database pool', async () => {
      const connectSpy = jest.spyOn(pool, 'connect').mockResolvedValue(mockClient);
      const cachedPayload = {
        status: 'success',
        type: 'all',
        query: 'cached-query',
        sections: { people: { items: [], has_more: false, status: 'success' } },
        results: { people: { items: [], has_more: false, status: 'success' } },
      };

      jest.spyOn(redis, 'get').mockResolvedValueOnce(JSON.stringify(cachedPayload));

      const result = await searchService.executeSearch({
        q: 'cached-query',
        type: 'all',
        actor: { type: 'USER', id: 'user-123' },
      });

      expect(result).toEqual(cachedPayload);
      // Database pool must NOT have been called on cache hit!
      expect(connectSpy).not.toHaveBeenCalled();

      connectSpy.mockRestore();
      redis.get.mockRestore();
    });

    test('gracefully falls back to database when Redis get throws error', async () => {
      const connectSpy = jest.spyOn(pool, 'connect').mockResolvedValue(mockClient);
      jest.spyOn(redis, 'get').mockRejectedValueOnce(new Error('ECONNREFUSED'));
      jest.spyOn(redis, 'set').mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const result = await searchService.executeSearch({
        q: 'resilience-test',
        type: 'all',
        actor: { type: 'USER', id: 'user-123' },
      });

      expect(result.status).toBe('success');
      expect(connectSpy).toHaveBeenCalledTimes(1);

      connectSpy.mockRestore();
      redis.get.mockRestore();
      redis.set.mockRestore();
    });

    test('computes deterministic scoped cache keys and appropriate TTLs', () => {
      const userScope = searchService.buildSearchCacheScopeId({ actor: { type: 'USER', id: 'u1' } });
      expect(userScope).toBe('user:u1');

      const orgScope = searchService.buildSearchCacheScopeId({ actor: { type: 'ORGANIZATION', orgId: 'o1' } });
      expect(orgScope).toBe('org:o1');

      const guestScope = searchService.buildSearchCacheScopeId({});
      expect(guestScope).toBe('guest');

      expect(searchService.getSearchCacheTTL({ scopeId: userScope, type: 'all' })).toBe(30);
      expect(searchService.getSearchCacheTTL({ scopeId: userScope, type: 'companies' })).toBe(120);
      expect(searchService.getSearchCacheTTL({ scopeId: guestScope, type: 'all' })).toBe(120);
      expect(searchService.getSearchCacheTTL({ scopeId: userScope, type: 'hashtags' })).toBe(300);
    });
  });
});
