'use strict';

const { searchPeople } = require('../queries/peopleSearch.query');

describe('People Search Regression Tests: Industry & Institute Filters', () => {
  let mockClient;

  beforeEach(() => {
    mockClient = {
      query: jest.fn(),
      release: jest.fn(),
    };
  });

  describe('Industry Type filter', () => {
    test('filters people by industry array', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [] });

      await searchPeople(mockClient, {
        searchTerm: 'alex',
        viewerId: '00000000-0000-0000-0000-000000000001',
        queryParams: {
          industry: ['Technology', 'Financial Services'],
        },
      });

      expect(mockClient.query).toHaveBeenCalledTimes(1);
      const [sql, params] = mockClient.query.mock.calls[0];

      expect(sql).toContain('p.working_industry ILIKE');
      expect(sql).toContain('org.industry ILIKE');
      expect(params).toContain('%Technology%');
      expect(params).toContain('%Financial Services%');
    });

    test('filters people by pipe-delimited industry string', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [] });

      await searchPeople(mockClient, {
        searchTerm: 'alex',
        viewerId: '00000000-0000-0000-0000-000000000001',
        queryParams: {
          industry: 'Healthcare|Education',
        },
      });

      const [sql, params] = mockClient.query.mock.calls[0];
      expect(sql).toContain('p.working_industry ILIKE');
      expect(params).toContain('%Healthcare%');
      expect(params).toContain('%Education%');
    });
  });

  describe('Institute filter', () => {
    test('filters people by institute / school array', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [] });

      await searchPeople(mockClient, {
        searchTerm: 'john',
        viewerId: '00000000-0000-0000-0000-000000000001',
        queryParams: {
          institute: ['Stanford University', 'MIT'],
        },
      });

      const [sql, params] = mockClient.query.mock.calls[0];
      expect(sql).toContain('FROM educations ed');
      expect(sql).toContain('ed.school_name ILIKE');
      expect(sql).toContain('org.name ILIKE');
      expect(params).toContain('%Stanford University%');
      expect(params).toContain('%MIT%');
    });

    test('filters people by school param fallback', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [] });

      await searchPeople(mockClient, {
        searchTerm: 'john',
        viewerId: '00000000-0000-0000-0000-000000000001',
        queryParams: {
          school: 'Harvard University',
        },
      });

      const [sql, params] = mockClient.query.mock.calls[0];
      expect(sql).toContain('FROM educations ed');
      expect(params).toContain('%Harvard University%');
    });
  });

  describe('Combined Filters', () => {
    test('combines role, company, industry, and institute filters cleanly', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [] });

      await searchPeople(mockClient, {
        searchTerm: 'sarah',
        viewerId: '00000000-0000-0000-0000-000000000001',
        queryParams: {
          role: ['Software Engineer'],
          company: ['Google'],
          industry: ['Internet'],
          institute: ['UC Berkeley'],
        },
      });

      const [sql, params] = mockClient.query.mock.calls[0];
      expect(sql).toContain('exp.title ILIKE');
      expect(sql).toContain('exp.company_name ILIKE');
      expect(sql).toContain('p.working_industry ILIKE');
      expect(sql).toContain('ed.school_name ILIKE');
      expect(params).toContain('%Software Engineer%');
      expect(params).toContain('%Google%');
      expect(params).toContain('%Internet%');
      expect(params).toContain('%UC Berkeley%');
    });
  });
});

