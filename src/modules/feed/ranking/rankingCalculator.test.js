/**
 * Unit Tests: Ranking Calculator (A5.8)
 * Sprint Task: Day 2 — Task A5
 * Owner: Dev A
 * AI-Assisted: Yes (Antigravity)
 * Contracts read: contracts/ranking-features.md, contracts/schemas/ranking-result.schema.json
 * Last reviewed: 2026-05-24
 *
 * Run: npm test -- --testPathPattern=rankingCalculator
 *
 * These are pure-function tests — NO DB, NO Redis required.
 * rankCandidates is tested with a mock pool for intent score isolation.
 */

'use strict';

const {
  computeRecency,
  computeEngagement,
  computeRelationship,
  computeIntentMatch,
  computeSpamPenalty,
  computeFinalScore,
  rankCandidates,
  RANKING_VERSION,
  _SIGNAL_REGISTRY,
} = require('./rankingCalculator');

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeCandidate(overrides = {}) {
  return {
    itemId:            'item-uuid-001',
    itemType:          'post',
    source:            'social_graph',
    contentId:         'content-uuid-001',
    authorId:          'author-uuid-001',
    createdAt:         new Date().toISOString(), // default: just now
    score:             50,                       // raw_engagement
    relationshipScore: 0.50,
    isOpportunity:     false,
    metadata:          { like_count: 10, comment_count: 5, share_count: 2 },
    ...overrides,
  };
}

function makeCtx(overrides = {}) {
  return {
    userId:        'user-uuid-001',
    maxEngagement: 100,
    intentScores: {
      job_seeker_score: 50,
      creator_score:    30,
      event_score:      20,
    },
    ...overrides,
  };
}

// Mock pool — returns intent scores without hitting DB
function makeMockPool(intentRow = { job_seeker_score: 50, creator_score: 30, event_score: 20 }) {
  return {
    query: jest.fn().mockResolvedValue({ rows: intentRow ? [intentRow] : [] }),
  };
}

// ---------------------------------------------------------------------------
// Test 1 — computeRecency: age < 1 hour → 1.0
// ---------------------------------------------------------------------------
test('computeRecency: age < 1 hour returns 1.0', () => {
  const candidate = makeCandidate({
    createdAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(), // 30 min ago
  });
  const result = computeRecency(candidate);
  expect(result).toBe(1.0);
});

// ---------------------------------------------------------------------------
// Test 2 — computeRecency: age = 36h → ~0.5
// ---------------------------------------------------------------------------
test('computeRecency: age = 36h returns ~0.5', () => {
  const candidate = makeCandidate({
    createdAt: new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString(),
  });
  const result = computeRecency(candidate);
  expect(result).toBeCloseTo(0.5, 1); // 1.0 - (36/72) = 0.5
});

// ---------------------------------------------------------------------------
// Test 3 — computeRecency: age > 72h → decayed, floor ≥ 0.05
// ---------------------------------------------------------------------------
test('computeRecency: age > 72h is decayed and never below 0.05 floor', () => {
  const candidate = makeCandidate({
    createdAt: new Date(Date.now() - 80 * 60 * 60 * 1000).toISOString(), // 80h ago
  });
  const result = computeRecency(candidate);
  expect(result).toBeGreaterThanOrEqual(0.05);
  expect(result).toBeLessThan(0.5); // decayed, not the linear formula
});

// ---------------------------------------------------------------------------
// Test 4 — computeEngagement: zero engagement → 0.0
// ---------------------------------------------------------------------------
test('computeEngagement: zero raw score returns 0.0', () => {
  const candidate = makeCandidate({ score: 0 });
  const ctx = makeCtx({ maxEngagement: 100 });
  expect(computeEngagement(candidate, ctx)).toBe(0);
});

// ---------------------------------------------------------------------------
// Test 5 — computeEngagement: max in pool → 1.0
// ---------------------------------------------------------------------------
test('computeEngagement: score equal to maxEngagement returns 1.0', () => {
  const candidate = makeCandidate({ score: 100 });
  const ctx = makeCtx({ maxEngagement: 100 });
  expect(computeEngagement(candidate, ctx)).toBe(1.0);
});

// ---------------------------------------------------------------------------
// Test 6 — computeSpamPenalty: spam candidate (shares >> likes, low comments)
// ---------------------------------------------------------------------------
test('computeSpamPenalty: engagement bait returns 1.0', () => {
  const candidate = makeCandidate({
    metadata: { like_count: 2, comment_count: 1, share_count: 999 },
  });
  // shares (999) > 10 × likes (2=20) AND comments (1) < 5 → spam
  expect(computeSpamPenalty(candidate)).toBe(1.0);
});

// ---------------------------------------------------------------------------
// Test 7 — computeSpamPenalty: clean candidate → 0.0
// ---------------------------------------------------------------------------
test('computeSpamPenalty: normal engagement returns 0.0', () => {
  const candidate = makeCandidate({
    metadata: { like_count: 100, comment_count: 20, share_count: 15 },
  });
  expect(computeSpamPenalty(candidate)).toBe(0.0);
});

// ---------------------------------------------------------------------------
// Test 8 — A5.8 DETERMINISM: same inputs × 3 runs → identical final_score
// ---------------------------------------------------------------------------
test('A5.8 Determinism: same inputs always produce the same final_score', () => {
  const candidate = makeCandidate({
    createdAt:         new Date('2026-05-24T06:00:00.000Z').toISOString(),
    score:             60,
    relationshipScore: 0.75,
  });
  const ctx = makeCtx({ maxEngagement: 100 });

  const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(1779840000000);

  const run1 = computeFinalScore(candidate, ctx).score;
  const run2 = computeFinalScore(candidate, ctx).score;
  const run3 = computeFinalScore(candidate, ctx).score;

  dateSpy.mockRestore();

  expect(run1).toBe(run2);
  expect(run2).toBe(run3);
});

// ---------------------------------------------------------------------------
// Test 9 — rankCandidates: output sorted descending by final_score
// ---------------------------------------------------------------------------
test('rankCandidates: output is sorted descending by final_score', async () => {
  const candidates = [
    makeCandidate({ contentId: 'c1', score: 10,  relationshipScore: 0.0  }),
    makeCandidate({ contentId: 'c2', score: 90,  relationshipScore: 0.75 }),
    makeCandidate({ contentId: 'c3', score: 50,  relationshipScore: 0.50 }),
  ];

  const pool = makeMockPool();
  const result = await rankCandidates(candidates, 'user-uuid-001', pool);

  expect(result.length).toBe(3);
  for (let i = 0; i < result.length - 1; i++) {
    expect(result[i].final_score).toBeGreaterThanOrEqual(result[i + 1].final_score);
  }
});

// ---------------------------------------------------------------------------
// Test 10 — A5.7: every result has ranking_version: "1.0.0"
// ---------------------------------------------------------------------------
test('A5.7: every ranked result has ranking_version set to "1.0.0"', async () => {
  const candidates = [
    makeCandidate({ contentId: 'c1' }),
    makeCandidate({ contentId: 'c2', itemId: 'item-uuid-002' }),
  ];

  const pool = makeMockPool();
  const result = await rankCandidates(candidates, 'user-uuid-001', pool);

  result.forEach(r => {
    expect(r.ranking_version).toBe(RANKING_VERSION);
    expect(r.ranking_version).toBe('1.0.0');
  });
});

// ---------------------------------------------------------------------------
// Test 11 — Signal Registry extensibility: all signals produce a breakdown entry
// ---------------------------------------------------------------------------
test('score_breakdown contains an entry for every signal in SIGNAL_REGISTRY', () => {
  const candidate = makeCandidate();
  const ctx = makeCtx();

  const { breakdown } = computeFinalScore(candidate, ctx);
  const registryNames = _SIGNAL_REGISTRY.map(s => s.name);

  registryNames.forEach(name => {
    expect(breakdown).toHaveProperty(name);
    expect(typeof breakdown[name]).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// Test 12 — A10.1: Deterministic validation: same inputs run 5 times must produce identical ranked output
// ---------------------------------------------------------------------------
test('A10.1 Deterministic validation: same inputs run 5 times must produce identical ranked output', async () => {
  const candidates = [
    makeCandidate({ contentId: 'post-1', score: 80, relationshipScore: 0.75 }),
    makeCandidate({ contentId: 'post-2', score: 30, relationshipScore: 0.25 }),
    makeCandidate({ contentId: 'post-3', score: 95, relationshipScore: 0.50 }),
    makeCandidate({ contentId: 'post-4', score: 10, relationshipScore: 0.00 }),
    makeCandidate({ contentId: 'post-5', score: 60, relationshipScore: 0.75 }),
  ];

  const pool = makeMockPool();
  const userId = 'user-uuid-999';

  // Run the ranking pipeline 5 times
  const runs = [];
  for (let i = 0; i < 5; i++) {
    const ranked = await rankCandidates(candidates, userId, pool);
    // Map to simple JSON representation to verify order and values
    runs.push(ranked.map(r => ({
      item_id: r.item_id,
      final_score: r.final_score,
      slot_type: r.slot_type,
    })));
  }

  // Assert all 5 runs are exactly deep-equal to the first run
  const firstRunStr = JSON.stringify(runs[0]);
  for (let i = 1; i < 5; i++) {
    expect(JSON.stringify(runs[i])).toBe(firstRunStr);
  }
});

// ---------------------------------------------------------------------------
// Test 13 — A10.2: Verify ranking formula weights match ranking-features.md
// ---------------------------------------------------------------------------
test('A10.2: SIGNAL_REGISTRY weights exactly match contracts/ranking-features.md', () => {
  const expectedWeights = {
    recency: 0.25,
    engagement: 0.30,
    relationship: 0.25,
    intent_match: 0.20,
    spam_penalty: 0.50,
    diversity_penalty: 0.15,
  };

  _SIGNAL_REGISTRY.forEach(signal => {
    expect(signal.weight).toBe(expectedWeights[signal.name]);
  });
});

// ---------------------------------------------------------------------------
// Test 14 — A10.2: Verify spam penalty rules (spam_flag, report_count, is_hidden)
// ---------------------------------------------------------------------------
test('computeSpamPenalty: triggers penalty for spam_flag = true', () => {
  const candidateWithSpamFlag = makeCandidate({ spam_flag: true });
  expect(computeSpamPenalty(candidateWithSpamFlag)).toBe(1.0);
  
  const candidateWithSpamMeta = makeCandidate({ metadata: { spam_flag: true } });
  expect(computeSpamPenalty(candidateWithSpamMeta)).toBe(1.0);
});

test('computeSpamPenalty: triggers penalty for report_count > 3', () => {
  const candidateSpamReports = makeCandidate({ metadata: { report_count: 4 } });
  expect(computeSpamPenalty(candidateSpamReports)).toBe(1.0);
  
  const candidateSafeReports = makeCandidate({ metadata: { report_count: 2 } });
  expect(computeSpamPenalty(candidateSafeReports)).toBe(0.0);
});

test('computeSpamPenalty: triggers penalty for is_hidden = true', () => {
  const candidateHidden = makeCandidate({ is_hidden: true });
  expect(computeSpamPenalty(candidateHidden)).toBe(1.0);
  
  const candidateHiddenMeta = makeCandidate({ metadata: { is_hidden: true } });
  expect(computeSpamPenalty(candidateHiddenMeta)).toBe(1.0);
});

// ---------------------------------------------------------------------------
// Test 15 — A10.3: Stress test: rank 500 candidates in under 50ms
// ---------------------------------------------------------------------------
test('A10.3 Stress test: rank 500 candidates in under 50ms', async () => {
  const count = 500;
  const candidates = [];
  
  for (let i = 0; i < count; i++) {
    candidates.push(makeCandidate({
      itemId: `item-uuid-${i}`,
      contentId: `content-uuid-${i}`,
      score: Math.floor(Math.random() * 100),
      relationshipScore: Math.random(),
      createdAt: new Date(Date.now() - Math.floor(Math.random() * 100 * 3600 * 1000)).toISOString(),
      metadata: {
        like_count: Math.floor(Math.random() * 50),
        comment_count: Math.floor(Math.random() * 10),
        share_count: Math.floor(Math.random() * 5),
        report_count: Math.floor(Math.random() * 2),
      }
    }));
  }

  const pool = makeMockPool();
  const userId = 'user-uuid-benchmark';

  const { performance } = require('perf_hooks');
  const startTime = performance.now();
  
  const ranked = await rankCandidates(candidates, userId, pool);
  
  const endTime = performance.now();
  const duration = endTime - startTime;

  console.log(`[A10.3 Benchmark] Ranked 500 candidates in ${duration.toFixed(3)}ms`);

  expect(ranked.length).toBe(count);
  expect(duration).toBeLessThan(50); // SLA: Must complete in under 50ms
});

// ---------------------------------------------------------------------------
// Test 16 — A10.4: Ensure every ranked result includes ranking_version: "1.0.0"
// ---------------------------------------------------------------------------
test('A10.4 Ensure every ranked result includes ranking_version: "1.0.0"', async () => {
  const candidates = [
    makeCandidate({ contentId: 'c-org', isOpportunity: false }),
    makeCandidate({ contentId: 'c-opp', isOpportunity: true }),
  ];

  const pool = makeMockPool();
  const result = await rankCandidates(candidates, 'user-uuid-123', pool);

  expect(result.length).toBe(2);
  result.forEach(item => {
    expect(item).toHaveProperty('ranking_version');
    expect(item.ranking_version).toBe('1.0.0');
  });
});
