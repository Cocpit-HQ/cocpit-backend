'use strict';

const { searchHashtags, encodeHashtagCursor, decodeHashtagCursor } = require('../queries/hashtagSearch.query');

describe('Hashtag Search Regression Tests: Multi-mode sorting and Recently Added behavior', () => {
  let mockClient;

  beforeEach(() => {
    mockClient = {
      query: jest.fn(),
      release: jest.fn(),
    };
  });

  describe('Recently Added Sort', () => {
    test('uses effective_recent_at (COALESCE of last_used_at and created_at) in candidate CTE and ORDER BY', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [] });

      await searchHashtags(mockClient, {
        searchTerm: 'new',
        queryParams: { sort_by: 'recently_added' },
      });

      expect(mockClient.query).toHaveBeenCalledTimes(1);
      const [sql, params] = mockClient.query.mock.calls[0];

      // CTE defines effective_recent_at
      expect(sql).toContain('COALESCE(h.last_used_at, h.created_at) AS effective_recent_at');
      // ORDER BY uses effective_recent_at DESC NULLS LAST
      expect(sql).toContain('ORDER BY sort_rank ASC, effective_recent_at DESC NULLS LAST, h.hashtag_id DESC');
      // Check query parameters
      expect(params[0]).toBe('%new%');
      expect(params[1]).toBe('new%');
      expect(params[2]).toBe(26); // default limit 25 + 1
    });

    test('generates keyset cursor condition with effective_recent_at when cursor is supplied', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [] });

      const fakeCursor = encodeHashtagCursor({
        sort_rank: 0,
        effective_recent_at: '2026-11-06T10:00:00.000Z',
        last_used_at: '2026-11-06T10:00:00.000Z',
        tag: 'new',
        id: '11111111-2222-3333-4444-555555555555',
      }, 'recently_added');

      await searchHashtags(mockClient, {
        searchTerm: 'new',
        cursor: fakeCursor,
        queryParams: { sort_by: 'recently_added' },
      });

      expect(mockClient.query).toHaveBeenCalledTimes(1);
      const [sql, params] = mockClient.query.mock.calls[0];

      expect(sql).toContain('effective_recent_at < $');
      expect(params).toContainEqual(new Date('2026-11-06T10:00:00.000Z'));
      expect(params).toContain('11111111-2222-3333-4444-555555555555');
    });
  });

  describe('Other Sort Modes', () => {
    test('defaults to most_popular when no sort_by is specified', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [] });

      await searchHashtags(mockClient, {
        searchTerm: 'tech',
      });

      const [sql] = mockClient.query.mock.calls[0];
      expect(sql).toContain('ORDER BY sort_rank ASC, COALESCE(h.posts_count, 0) DESC, COALESCE(h.usage_count, 0) DESC');
    });

    test('trending sort orders by sort_rank ASC, trending_score DESC', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [] });

      await searchHashtags(mockClient, {
        searchTerm: 'tech',
        queryParams: { sort_by: 'trending' },
      });

      const [sql] = mockClient.query.mock.calls[0];
      expect(sql).toContain('trending_score DESC');
    });

    test('most_used sort orders by sort_rank ASC, usage_count DESC', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [] });

      await searchHashtags(mockClient, {
        searchTerm: 'tech',
        queryParams: { sort_by: 'most_used' },
      });

      const [sql] = mockClient.query.mock.calls[0];
      expect(sql).toContain('COALESCE(h.usage_count, 0) DESC');
    });
  });

  describe('Cursor encoding and decoding', () => {
    test('encodeHashtagCursor and decodeHashtagCursor roundtrips correctly', () => {
      const item = {
        sort_rank: 0,
        effective_recent_at: '2026-11-06T12:00:00.000Z',
        last_used_at: '2026-11-06T12:00:00.000Z',
        tag: 'explore',
        id: '99999999-8888-7777-6666-555555555555',
      };

      const encoded = encodeHashtagCursor(item, 'recently_added');
      expect(typeof encoded).toBe('string');

      const decoded = decodeHashtagCursor(encoded);
      expect(decoded.r).toBe(0);
      expect(decoded.id).toBe('99999999-8888-7777-6666-555555555555');
      expect(decoded.v).toBe('2026-11-06T12:00:00.000Z');
    });
  });
});

