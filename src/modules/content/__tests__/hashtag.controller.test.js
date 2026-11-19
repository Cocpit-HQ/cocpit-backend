'use strict';

jest.mock('../../../core/db/pool', () => ({
  query: jest.fn(),
}));

jest.mock('../../../core/db/redis', () => ({
  isOpen: false,
  zRevRangeWithScores: jest.fn(),
  set: jest.fn(),
  expire: jest.fn(),
}));

const pool = require('../../../core/db/pool');
const { getHashtagPosts } = require('../hashtag.controller');

describe('Hashtag Controller: getHashtagPosts (SCRUM-1830 Regression Tests)', () => {
  let req;
  let res;

  beforeEach(() => {
    jest.clearAllMocks();

    req = {
      params: { tag: 'tech' },
      query: {},
      user: { sub: 'user-123' },
      actor: null,
    };

    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
  });

  test('returns 400 if hashtag is missing or invalid', async () => {
    req.params.tag = '';
    await getHashtagPosts(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: 'Invalid hashtag' });

    jest.clearAllMocks();
    req.params.tag = 'a'; // length < 2
    await getHashtagPosts(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('executes count query and feed query using matching lower(h.tag) and public feed filters', async () => {
    // 1st query: tagCountQuery -> returns tag metadata
    pool.query.mockResolvedValueOnce({
      rows: [{ tag: 'tech', usage_count: 1 }],
    });

    // 2nd query: feed hydration query -> returns posts
    pool.query.mockResolvedValueOnce({
      rows: [{ post_id: 'post-1', content: 'Hello #tech' }],
    });

    await getHashtagPosts(req, res);

    expect(pool.query).toHaveBeenCalledTimes(2);

    const [countSql, countParams] = pool.query.mock.calls[0];
    const [feedSql, feedParams] = pool.query.mock.calls[1];

    // Count query checks
    expect(countSql).toContain('COUNT(DISTINCT p.post_id)::int as usage_count');
    expect(countSql).toContain('lower(h.tag) = $2');
    expect(countParams).toEqual(['user-123', 'tech']);

    // Feed query checks
    expect(feedSql).toContain('lower(h.tag) = $3');
    expect(feedParams).toEqual(['user-123', null, 'tech', 10]);

    // Response checks
    expect(res.json).toHaveBeenCalledWith({
      posts: [{ post_id: 'post-1', content: 'Hello #tech' }],
      nextCursor: { cursorPostId: 'post-1' },
      hashtag: { tag: 'tech', usage_count: 1 },
    });
  });

  test('passes active organization actor to both count and feed queries when acting as Business', async () => {
    req.actor = { type: 'ORGANIZATION', orgId: 'org-456' };

    pool.query.mockResolvedValueOnce({
      rows: [{ tag: 'tech', usage_count: 2 }],
    });
    pool.query.mockResolvedValueOnce({
      rows: [
        { post_id: 'post-1', content: 'Post 1' },
        { post_id: 'post-2', content: 'Post 2' },
      ],
    });

    await getHashtagPosts(req, res);

    expect(pool.query).toHaveBeenCalledTimes(2);

    const [countSql, countParams] = pool.query.mock.calls[0];
    const [, feedParams] = pool.query.mock.calls[1];

    expect(countSql).toContain('lower(h.tag) = $3');
    expect(countParams[0]).toBe('user-123');
    expect(countParams[1]).toBe('org-456');
    expect(countParams[2]).toBe('tech');

    expect(feedParams[0]).toBe('user-123');
    expect(feedParams[1]).toBe('org-456');
    expect(feedParams[2]).toBe('tech');
  });

  test('handles zero posts gracefully with usage_count 0', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ tag: 'tech', usage_count: 0 }],
    });
    pool.query.mockResolvedValueOnce({
      rows: [],
    });

    await getHashtagPosts(req, res);

    expect(res.json).toHaveBeenCalledWith({
      posts: [],
      nextCursor: null,
      hashtag: { tag: 'tech', usage_count: 0 },
    });
  });
});
