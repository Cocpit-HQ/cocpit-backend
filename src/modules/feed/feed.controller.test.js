/**
 * Unit Tests: Feed API Controller (Day 4 — B8)
 *
 * Sprint Task: Day 4 — Task B8 (B8.1–B8.7)
 * Owner: Dev B
 * AI-Assisted: Yes (Antigravity)
 * Contracts read: contracts/api-contracts.md (FROZEN)
 * Last reviewed: 2026-05-27
 *
 * Run: npm test -- --testPathPatterns="feed.controller"
 *
 * Strategy: Call handler functions directly with mock req/res/next objects.
 * No supertest / HTTP layer needed — tests the controller logic in isolation.
 * All external dependencies (feedService, feedAnalytics, feedSessionService, pool)
 * are fully mocked.
 *
 * 14 tests across 4 handlers:
 *   getFeed      (7) — auth, limit validation, context validation, happy path, error propagation
 *   trackEvent   (4) — auth, missing fields, happy path, duplicate flag
 *   getSession   (2) — happy path shape, creates session if missing
 *   resetSession (1) — happy path
 */

'use strict';

// ─── Mocks (must be hoisted before require of controller) ─────────────────────

jest.mock('./feed.service', () => ({
  getFeed: jest.fn(),
}));

jest.mock('./session/feedSession.service', () => ({
  getSession:        jest.fn(),
  createSession:     jest.fn(),
  resetSession:      jest.fn(),
  touchSession:      jest.fn(),
  incrementSeenCount: jest.fn(),
}));

jest.mock('./analytics/feedAnalytics.service', () => ({
  trackEvent: jest.fn(),
}));

jest.mock('../../core/db/pool', () => ({}));

// ─── Module under test ────────────────────────────────────────────────────────

const feedController   = require('./feed.controller');
const feedService      = require('./feed.service');
const feedSession      = require('./session/feedSession.service');
const feedAnalytics    = require('./analytics/feedAnalytics.service');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * makeReq — build a minimal Express request object.
 */
function makeReq({ user = { sub: 'test-user-uuid' }, query = {}, body = {}, headers = {} } = {}) {
  return { user, query, body, headers };
}

/**
 * makeRes — build a chainable mock response object.
 */
function makeRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json   = jest.fn().mockReturnValue(res);
  return res;
}

// ─── Test Suites ──────────────────────────────────────────────────────────────

describe('feed.controller', () => {

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ===========================================================================
  // getFeed — 7 tests
  // ===========================================================================
  describe('getFeed', () => {

    test('TC-C01: returns 401 when req.user is null', async () => {
      const req  = makeReq({ user: null });
      const res  = makeRes();
      const next = jest.fn();

      await feedController.getFeed(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ ok: false, message: 'Unauthenticated' })
      );
      expect(feedService.getFeed).not.toHaveBeenCalled();
    });

    test('TC-C02: returns 400 when limit > 50', async () => {
      const req  = makeReq({ query: { limit: '51' } });
      const res  = makeRes();
      const next = jest.fn();

      await feedController.getFeed(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ ok: false, message: expect.stringContaining('1 and 50') })
      );
    });

    test('TC-C03: returns 400 when limit < 1 (zero)', async () => {
      const req  = makeReq({ query: { limit: '0' } });
      const res  = makeRes();
      const next = jest.fn();

      await feedController.getFeed(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ ok: false })
      );
    });

    test('TC-C04: returns 400 when limit is non-numeric (NaN)', async () => {
      const req  = makeReq({ query: { limit: 'abc' } });
      const res  = makeRes();
      const next = jest.fn();

      await feedController.getFeed(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('TC-C05: returns 400 when context is invalid enum value', async () => {
      const req  = makeReq({ query: { context: 'dashboard' } });
      const res  = makeRes();
      const next = jest.fn();

      await feedController.getFeed(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          ok: false,
          message: expect.stringContaining('home, explore, startup'),
        })
      );
    });

    test('TC-C06: happy path — calls feedService and returns 200', async () => {
      const mockFeedResponse = {
        ok: true,
        data: { items: [], cursor: 'c1', has_more: true, session_id: 's1', served_at: new Date().toISOString() },
        meta: { total_candidates: 42, cache_hit: false, exploration_slots: 3, ranking_version: '1.0.0' },
      };
      feedService.getFeed.mockResolvedValue(mockFeedResponse);

      const req  = makeReq({ query: { limit: '20', context: 'home' } });
      const res  = makeRes();
      const next = jest.fn();

      await feedController.getFeed(req, res, next);

      expect(feedService.getFeed).toHaveBeenCalledWith(
        expect.objectContaining({
          userId:  'test-user-uuid',
          limit:   20,
          context: 'home',
        })
      );
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(mockFeedResponse);
      expect(next).not.toHaveBeenCalled();
    });

    test('TC-C07: limit omitted defaults to 20 and calls feedService', async () => {
      feedService.getFeed.mockResolvedValue({ ok: true, data: {}, meta: {} });

      const req  = makeReq({ query: {} }); // no limit in query
      const res  = makeRes();
      const next = jest.fn();

      await feedController.getFeed(req, res, next);

      expect(feedService.getFeed).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 20 })
      );
      expect(res.status).toHaveBeenCalledWith(200);
    });

    test('TC-C14: calls next(err) when feedService throws', async () => {
      const boom = new Error('feed pipeline exploded');
      feedService.getFeed.mockRejectedValue(boom);

      const req  = makeReq();
      const res  = makeRes();
      const next = jest.fn();

      await feedController.getFeed(req, res, next);

      expect(next).toHaveBeenCalledWith(boom);
      expect(res.status).not.toHaveBeenCalledWith(500); // error middleware handles it
    });
  });

  // ===========================================================================
  // trackEvent — 4 tests
  // ===========================================================================
  describe('trackEvent', () => {

    const validBody = {
      event_type: 'impression',
      item_id:    'item-uuid-001',
      item_type:  'post',
      session_id: 'session-uuid-001',
      position:   0,
      context:    'home',
    };

    test('TC-C08: returns 401 when req.user is null', async () => {
      const req  = makeReq({ user: null, body: validBody });
      const res  = makeRes();
      const next = jest.fn();

      await feedController.trackEvent(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
    });

    test('TC-C09: returns 400 when event_type is missing', async () => {
      const { event_type, ...bodyWithout } = validBody; // eslint-disable-line no-unused-vars
      const req  = makeReq({ body: bodyWithout });
      const res  = makeRes();
      const next = jest.fn();

      await feedController.trackEvent(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ ok: false, message: expect.stringContaining('event_type') })
      );
      expect(feedAnalytics.trackEvent).not.toHaveBeenCalled();
    });

    test('TC-C10: returns 400 when session_id is missing', async () => {
      const { session_id, ...bodyWithout } = validBody; // eslint-disable-line no-unused-vars
      const req  = makeReq({ body: bodyWithout });
      const res  = makeRes();
      const next = jest.fn();

      await feedController.trackEvent(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('TC-C11: happy path — returns 202, calls analytics, touches session', async () => {
      feedAnalytics.trackEvent.mockResolvedValue({ accepted: true, duplicate: false });
      feedSession.touchSession.mockResolvedValue(true);

      const req  = makeReq({ body: validBody });
      const res  = makeRes();
      const next = jest.fn();

      await feedController.trackEvent(req, res, next);

      expect(feedAnalytics.trackEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'impression',
          item_id:    'item-uuid-001',
          user_id:    'test-user-uuid',
        })
      );
      expect(feedSession.touchSession).toHaveBeenCalledWith('test-user-uuid');
      expect(res.status).toHaveBeenCalledWith(202);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ ok: true, message: 'Event accepted' })
      );
    });

    test('TC-C11b: duplicate impression response includes duplicate:true flag', async () => {
      feedAnalytics.trackEvent.mockResolvedValue({ accepted: true, duplicate: true });
      feedSession.touchSession.mockResolvedValue(true);

      const req  = makeReq({ body: validBody });
      const res  = makeRes();
      const next = jest.fn();

      await feedController.trackEvent(req, res, next);

      expect(res.status).toHaveBeenCalledWith(202);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ ok: true, duplicate: true })
      );
    });
  });

  // ===========================================================================
  // getSession — 2 tests
  // ===========================================================================
  describe('getSession', () => {

    test('TC-C12: returns 200 with correct contract shape when session exists', async () => {
      const mockSession = {
        session_id: 'sess-uuid',
        cursor:     'cursor-abc',
        seen_count: 5,
        started_at: '2026-05-27T00:00:00.000Z',
        expires_at: '2026-05-27T00:30:00.000Z',
      };
      feedSession.getSession.mockResolvedValue(mockSession);

      const req  = makeReq();
      const res  = makeRes();
      const next = jest.fn();

      await feedController.getSession(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        ok: true,
        data: {
          session_id: 'sess-uuid',
          cursor:     'cursor-abc',
          seen_count: 5,
          started_at: '2026-05-27T00:00:00.000Z',
          expires_at: '2026-05-27T00:30:00.000Z',
        },
      });
    });

    test('TC-C12b: creates a new session when none exists and returns it', async () => {
      feedSession.getSession.mockResolvedValue(null); // no existing session
      const newSession = {
        session_id: 'new-sess-uuid',
        cursor:     'init-cursor',
        seen_count: 0,
        started_at: '2026-05-27T07:00:00.000Z',
        expires_at: '2026-05-27T07:30:00.000Z',
      };
      feedSession.createSession.mockResolvedValue(newSession);

      const req  = makeReq({ query: { context: 'explore' } });
      const res  = makeRes();
      const next = jest.fn();

      await feedController.getSession(req, res, next);

      expect(feedSession.createSession).toHaveBeenCalledWith('test-user-uuid', 'explore');
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ ok: true, data: expect.objectContaining({ session_id: 'new-sess-uuid' }) })
      );
    });
  });

  // ===========================================================================
  // resetSession — 1 test
  // ===========================================================================
  describe('resetSession', () => {

    test('TC-C13: calls resetSession and returns ok=true with correct message', async () => {
      feedSession.resetSession.mockResolvedValue(undefined);

      const req  = makeReq();
      const res  = makeRes();
      const next = jest.fn();

      await feedController.resetSession(req, res, next);

      expect(feedSession.resetSession).toHaveBeenCalledWith('test-user-uuid');
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        ok:      true,
        message: 'Feed session reset',
      });
    });
  });

});
