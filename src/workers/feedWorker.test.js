/**
 * Unit Tests: Feed Background Worker (Day 4 — B9)
 *
 * Sprint Task: Day 4 — Task B9 (B9.1 – B9.5)
 * Owner: Dev B
 * AI-Assisted: Yes (Antigravity)
 * Last reviewed: 2026-05-27
 *
 * Run: npm test -- --testPathPatterns="feedWorker"
 *
 * Strategy: All external dependencies are mocked. Jest fake timers are used
 * to test setInterval/setTimeout behaviour without real delays.
 *
 * 6 tests:
 *   1. runFeedWorkerCycle calls refreshExplorationPool
 *   2. runFeedWorkerCycle calls processEventQueue
 *   3. Cycle continues if refreshExplorationPool throws
 *   4. Cycle continues if processEventQueue throws
 *   5. startFeedWorker is idempotent — second call is a no-op
 *   6. FEED_WORKER_INTERVAL_MS env var is respected
 */

'use strict';

// ─── Mocks (hoisted before require) ──────────────────────────────────────────

const mockRefreshExplorationPool = jest.fn();
const mockProcessEventQueue      = jest.fn();

jest.mock('../modules/feed/exploration/explorationPool', () => ({
  refreshExplorationPool: mockRefreshExplorationPool,
}));

jest.mock('../modules/feed/analytics/feedAnalytics.service', () => ({
  processEventQueue: mockProcessEventQueue,
}));

jest.mock('../core/db/pool', () => ({}));

// ─── Module under test ────────────────────────────────────────────────────────

// Require AFTER mocks are in place
const { runFeedWorkerCycle, startFeedWorker, stopFeedWorker } = require('./feedWorker');

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('feedWorker', () => {

  beforeEach(() => {
    jest.clearAllMocks();
    // Always reset the worker between tests so startFeedWorker idempotency tests are clean
    stopFeedWorker();
    jest.useFakeTimers();
  });

  afterEach(() => {
    stopFeedWorker();
    jest.useRealTimers();
    // Reset FEED_WORKER_INTERVAL_MS env override if set
    delete process.env.FEED_WORKER_INTERVAL_MS;
  });

  // ---------------------------------------------------------------------------
  // Test 1 — runFeedWorkerCycle calls refreshExplorationPool
  // ---------------------------------------------------------------------------
  test('TC-W01: runFeedWorkerCycle calls refreshExplorationPool once', async () => {
    mockRefreshExplorationPool.mockResolvedValue(undefined);
    mockProcessEventQueue.mockResolvedValue(0);

    await runFeedWorkerCycle();

    expect(mockRefreshExplorationPool).toHaveBeenCalledTimes(1);
    expect(mockRefreshExplorationPool).toHaveBeenCalledWith(
      expect.any(Object) // the mocked pool
    );
  });

  // ---------------------------------------------------------------------------
  // Test 2 — runFeedWorkerCycle calls processEventQueue
  // ---------------------------------------------------------------------------
  test('TC-W02: runFeedWorkerCycle calls processEventQueue once', async () => {
    mockRefreshExplorationPool.mockResolvedValue(undefined);
    mockProcessEventQueue.mockResolvedValue(3);

    await runFeedWorkerCycle();

    expect(mockProcessEventQueue).toHaveBeenCalledTimes(1);
    expect(mockProcessEventQueue).toHaveBeenCalledWith(
      expect.any(Object) // the mocked pool
    );
  });

  // ---------------------------------------------------------------------------
  // Test 3 — refreshExplorationPool failure does NOT prevent processEventQueue
  // ---------------------------------------------------------------------------
  test('TC-W03: cycle continues and calls processEventQueue even if refreshExplorationPool throws', async () => {
    mockRefreshExplorationPool.mockRejectedValue(new Error('Redis down'));
    mockProcessEventQueue.mockResolvedValue(0);

    // Should not throw — the worker is resilient
    await expect(runFeedWorkerCycle()).resolves.toBeUndefined();

    // processEventQueue must still be called
    expect(mockProcessEventQueue).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // Test 4 — processEventQueue failure does NOT cause unhandled rejection
  // ---------------------------------------------------------------------------
  test('TC-W04: cycle resolves cleanly even if processEventQueue throws', async () => {
    mockRefreshExplorationPool.mockResolvedValue(undefined);
    mockProcessEventQueue.mockRejectedValue(new Error('DB unavailable'));

    // Must resolve (not reject) — error is swallowed inside try/catch
    await expect(runFeedWorkerCycle()).resolves.toBeUndefined();

    // refreshExplorationPool still ran
    expect(mockRefreshExplorationPool).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // Test 5 — startFeedWorker is idempotent: second call is a no-op
  // ---------------------------------------------------------------------------
  test('TC-W05: startFeedWorker ignores duplicate calls (idempotent)', () => {
    const setIntervalSpy = jest.spyOn(global, 'setInterval');

    startFeedWorker();
    startFeedWorker(); // second call — must be a no-op
    startFeedWorker(); // third call — also a no-op

    // setInterval should have been called exactly once
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    setIntervalSpy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // Test 6 — FEED_WORKER_INTERVAL_MS env var is respected
  // ---------------------------------------------------------------------------
  test('TC-W06: FEED_WORKER_INTERVAL_MS env var overrides the default 5-minute interval', () => {
    process.env.FEED_WORKER_INTERVAL_MS = '60000'; // 1 minute

    const setIntervalSpy = jest.spyOn(global, 'setInterval');

    startFeedWorker();

    // setInterval must have been called with the env-var value
    expect(setIntervalSpy).toHaveBeenCalledWith(
      expect.any(Function),
      60000
    );

    setIntervalSpy.mockRestore();
  });

});
