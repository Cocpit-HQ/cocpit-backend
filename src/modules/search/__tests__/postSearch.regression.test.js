'use strict';

const { searchPosts } = require('../queries/postSearch.query');

describe('Post Search Regression Tests: Hashtag & Posted By Filters', () => {
  let mockClient;

  beforeEach(() => {
    mockClient = {
      query: jest.fn(),
      release: jest.fn(),
    };
  });

  describe('Hashtags filter', () => {
    test('filters by hashtag array and generates parameterized clause', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [] });

      await searchPosts(mockClient, {
        searchTerm: 'tech',
        viewerId: '00000000-0000-0000-0000-000000000001',
        queryParams: {
          hashtag: ['#AI', 'reactjs'],
        },
      });

      expect(mockClient.query).toHaveBeenCalledTimes(1);
      const [sql, params] = mockClient.query.mock.calls[0];

      expect(sql).toContain('post_hashtags ph');
      expect(sql).toContain('LOWER(h.tag) = ANY(');
      // The tags should be cleaned (lower-cased and '#' stripped)
      expect(params).toContainEqual(['ai', 'reactjs']);
    });

    test('handles pipe-delimited or comma-delimited hashtag string', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [] });

      await searchPosts(mockClient, {
        searchTerm: 'hiring',
        viewerId: '00000000-0000-0000-0000-000000000001',
        queryParams: {
          hashtag: '#Career|#Jobs,Opportunities',
        },
      });

      const [sql, params] = mockClient.query.mock.calls[0];
      expect(sql).toContain('post_hashtags ph');
      expect(params).toContainEqual(['career', 'jobs', 'opportunities']);
    });
  });

  describe('Posted By filter', () => {
    test('filters by connections using viewerId and strictly excludes organization posts', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [] });

      await searchPosts(mockClient, {
        searchTerm: 'news',
        viewerId: '00000000-0000-0000-0000-000000000001',
        queryParams: {
          posted_by: 'connections',
        },
      });

      const [sql, params] = mockClient.query.mock.calls[0];
      expect(sql).toContain('p.author_org_id IS NULL');
      expect(sql).toContain('c.user_id = $2::uuid AND c.connected_user_id = p.author_id');
      expect(sql).toContain('followers f1');
      expect(params[1]).toBe('00000000-0000-0000-0000-000000000001');
    });

    test('filters by followers using viewerId and orgActorId', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [] });

      await searchPosts(mockClient, {
        searchTerm: 'news',
        viewerId: '00000000-0000-0000-0000-000000000001',
        orgActorId: '00000000-0000-0000-0000-000000000002',
        queryParams: {
          posted_by: 'followers',
        },
      });

      const [sql, params] = mockClient.query.mock.calls[0];
      expect(sql).toContain('f.follower_id = p.author_id AND f.following_id = $2::uuid');
      expect(sql).toContain('ofol.user_id = p.author_id AND ofol.org_id = $3::uuid');
      expect(params[1]).toBe('00000000-0000-0000-0000-000000000001');
      expect(params[2]).toBe('00000000-0000-0000-0000-000000000002');
    });

    test('filters by others excluding connections and followers', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [] });

      await searchPosts(mockClient, {
        searchTerm: 'updates',
        viewerId: '00000000-0000-0000-0000-000000000001',
        queryParams: {
          posted_by: 'others',
        },
      });

      const [sql] = mockClient.query.mock.calls[0];
      expect(sql).toContain('NOT EXISTS');
      expect(sql).toContain('connections c');
      expect(sql).toContain('followers f');
    });

    test('supports multi-select posted_by (connections + followers) joined by OR', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [] });

      await searchPosts(mockClient, {
        searchTerm: 'updates',
        viewerId: '00000000-0000-0000-0000-000000000001',
        queryParams: {
          posted_by: ['connections', 'followers'],
        },
      });

      const [sql] = mockClient.query.mock.calls[0];
      expect(sql).toContain('connections c');
      expect(sql).toContain('followers f');
      expect(sql).toMatch(/connections c[\s\S]*OR[\s\S]*followers f/);
    });

    test('supports comma-delimited multi-select posted_by string', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [] });

      await searchPosts(mockClient, {
        searchTerm: 'updates',
        viewerId: '00000000-0000-0000-0000-000000000001',
        queryParams: {
          posted_by: 'connections,followers',
        },
      });

      const [sql] = mockClient.query.mock.calls[0];
      expect(sql).toContain('connections c');
      expect(sql).toContain('followers f');
    });
  });

  describe('Content Type filter (multi-select)', () => {
    test('supports multi-select content_type (image + video) joined by OR', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [] });

      await searchPosts(mockClient, {
        searchTerm: 'media',
        viewerId: '00000000-0000-0000-0000-000000000001',
        queryParams: {
          content_type: ['image', 'video'],
        },
      });

      const [sql] = mockClient.query.mock.calls[0];
      expect(sql).toContain("media_type = 'image'");
      expect(sql).toContain("media_type = 'video'");
      expect(sql).toMatch(/media_type = 'image'[\s\S]*OR[\s\S]*media_type = 'video'/);
    });

    test('supports comma-delimited content_type string', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [] });

      await searchPosts(mockClient, {
        searchTerm: 'media',
        viewerId: '00000000-0000-0000-0000-000000000001',
        queryParams: {
          content_type: 'text,poll',
        },
      });

      const [sql] = mockClient.query.mock.calls[0];
      expect(sql).toContain("post_polls pp");
      expect(sql).toMatch(/post_type::text IN \('text', 'normal'\)[\s\S]*OR[\s\S]*post_polls pp/);
    });
  });

  describe('Combined Filters & Pagination', () => {
    test('combines date_posted, content_type, hashtag, and posted_by filters cleanly', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [] });

      await searchPosts(mockClient, {
        searchTerm: 'announcement',
        viewerId: '00000000-0000-0000-0000-000000000001',
        queryParams: {
          date_posted: 'past_week',
          content_type: 'image',
          hashtag: ['launch'],
          posted_by: 'connections',
        },
      });

      const [sql, params] = mockClient.query.mock.calls[0];
      expect(sql).toContain("INTERVAL '7 days'");
      expect(sql).toContain("media_type = 'image'");
      expect(sql).toContain('post_hashtags ph');
      expect(sql).toContain('connections c');
      expect(params).toContainEqual(['launch']);
    });
  });
});

