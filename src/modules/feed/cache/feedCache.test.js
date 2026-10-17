/**
 * Unit Tests: Feed Cache Service (B1.8)
 * Sprint Task: Day 1 — Task B1 | Day 2 — Task B5 (candidate pool cache)
 * Owner: Dev B
 * AI-Assisted: Yes (Antigravity)
 *
 * Run: npm test -- --testPathPattern=feedCache
 *
 * These are Jest unit tests — `redis` client is mocked. No live Redis connection is required.
 */

"use strict";

const {
  setFeedSlice,
  getFeedSlice,
  addToSeenSet,
  getSeenSet,
  // clearSeenSet, // UNUSED
  setCandidatePool,
  getCandidatePool,
  getRegisteredKeyPatterns,
  _keys,
  _TTL,
} = require("./feedCache");

// Reference to mock store and redis mock
const mockStore = {};
const mockPipeline = {
  sadd: jest.fn(),
  expire: jest.fn(),
  exec: jest.fn().mockResolvedValue([]),
};

jest.mock("../../../core/cache/redis", () => {
  return {
    get: jest.fn().mockImplementation(async (key) => mockStore[key] || null),
    set: jest.fn().mockImplementation(async (key, val, ex, ttl) => {
      mockStore[key] = val;
      return "OK";
    }),
    del: jest.fn().mockImplementation(async (key) => {
      delete mockStore[key];
      return 1;
    }),
    sadd: jest.fn(),
    srem: jest.fn(),
    scard: jest.fn(),
    srandmember: jest.fn(),
    smembers: jest.fn(),
    exists: jest.fn(),
    pipeline: jest.fn().mockImplementation(() => mockPipeline),
    once: jest.fn(),
    on: jest.fn(),
  };
});

const redis = require("../../../core/cache/redis");

const TEST_USER = "test-user-feedcache-001";
const TEST_CURSOR = "cursor-abc-123";
const SAMPLE_ITEMS = [
  { id: "item-1", type: "post", score: 0.9 },
  { id: "item-2", type: "job", score: 0.8 },
];

describe("Feed Cache Service - Unit Tests", () => {
  beforeEach(() => {
    // Clear mock store and call counts
    for (const k of Object.keys(mockStore)) {
      delete mockStore[k];
    }
    jest.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // 1. Feed Slice Cache Tests
  // ---------------------------------------------------------------------------
  describe("Feed Slice Cache", () => {
    test("setFeedSlice stores items in Redis with correct key and TTL", async () => {
      await setFeedSlice(TEST_USER, TEST_CURSOR, SAMPLE_ITEMS);

      expect(redis.set).toHaveBeenCalledWith(
        _keys.feedSlice(TEST_USER, TEST_CURSOR),
        JSON.stringify(SAMPLE_ITEMS),
        "EX",
        _TTL.FEED_SLICE
      );
      expect(mockStore[_keys.feedSlice(TEST_USER, TEST_CURSOR)]).toBe(JSON.stringify(SAMPLE_ITEMS));
    });

    test("getFeedSlice returns parsed items on hit", async () => {
      mockStore[_keys.feedSlice(TEST_USER, TEST_CURSOR)] = JSON.stringify(SAMPLE_ITEMS);

      const result = await getFeedSlice(TEST_USER, TEST_CURSOR);
      expect(result).toEqual(SAMPLE_ITEMS);
    });

    test("getFeedSlice returns null on cache miss", async () => {
      const result = await getFeedSlice(TEST_USER, "nonexistent-cursor");
      expect(result).toBeNull();
    });

    test("setFeedSlice throws on invalid args", async () => {
      await expect(setFeedSlice(null, TEST_CURSOR, [])).rejects.toThrow("setFeedSlice: userId and cursor are required");
      await expect(setFeedSlice(TEST_USER, TEST_CURSOR, "not-an-array")).rejects.toThrow("setFeedSlice: items must be an array");
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Seen Set Deduplication Tests
  // ---------------------------------------------------------------------------
  describe("Seen Set Deduplication", () => {
    test("addToSeenSet adds items to Redis set using pipeline", async () => {
      redis.scard.mockResolvedValue(3); // below threshold

      await addToSeenSet(TEST_USER, ["item-1", "item-2", "item-3"]);

      expect(redis.pipeline).toHaveBeenCalled();
      expect(mockPipeline.sadd).toHaveBeenCalledWith(_keys.seenSet(TEST_USER), "item-1", "item-2", "item-3");
      expect(mockPipeline.expire).toHaveBeenCalledWith(_keys.seenSet(TEST_USER), _TTL.SEEN_SET);
      expect(mockPipeline.exec).toHaveBeenCalled();
    });

    test("getSeenSet returns all item IDs", async () => {
      const expectedMembers = ["a", "b", "c"];
      redis.smembers.mockResolvedValue(expectedMembers);

      const result = await getSeenSet(TEST_USER);
      expect(redis.smembers).toHaveBeenCalledWith(_keys.seenSet(TEST_USER));
      expect(result).toEqual(expectedMembers);
    });

    /*
    test("clearSeenSet removes the seen set key", async () => {
      await clearSeenSet(TEST_USER);
      expect(redis.del).toHaveBeenCalledWith(_keys.seenSet(TEST_USER));
    });
    */
  });

  // ---------------------------------------------------------------------------
  // 3. Candidate Pool Cache Tests
  // ---------------------------------------------------------------------------
  describe("Candidate Pool Cache", () => {
    test("setCandidatePool stores candidates with correct key and TTL", async () => {
      await setCandidatePool(TEST_USER, SAMPLE_ITEMS);

      expect(redis.set).toHaveBeenCalledWith(
        _keys.candidatePool(TEST_USER),
        JSON.stringify(SAMPLE_ITEMS),
        "EX",
        _TTL.CANDIDATE_POOL
      );
      expect(mockStore[_keys.candidatePool(TEST_USER)]).toBe(JSON.stringify(SAMPLE_ITEMS));
    });

    test("getCandidatePool returns parsed candidates on cache hit", async () => {
      mockStore[_keys.candidatePool(TEST_USER)] = JSON.stringify(SAMPLE_ITEMS);

      const result = await getCandidatePool(TEST_USER);
      expect(result).toEqual(SAMPLE_ITEMS);
    });

    test("getCandidatePool returns null on cache miss", async () => {
      const result = await getCandidatePool(TEST_USER);
      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Key Patterns Verification
  // ---------------------------------------------------------------------------
  describe("Key Patterns & Registry Verification", () => {
    test("getRegisteredKeyPatterns matches specifications", () => {
      const patterns = getRegisteredKeyPatterns();
      expect(patterns.feedSlice).toBe("feed:slice:{user_id}:{cursor}");
      expect(patterns.seenSet).toBe("feed:seen:{user_id}");
      expect(patterns.candidatePool).toBe("feed:candidates:{user_id}");
    });

    test("Key builders produce correct key shapes", () => {
      expect(_keys.feedSlice("u1", "c1")).toBe("feed:slice:u1:c1");
      expect(_keys.seenSet("u1")).toBe("feed:seen:u1");
      expect(_keys.candidatePool("u1")).toBe("feed:candidates:u1");
    });
  });
});
