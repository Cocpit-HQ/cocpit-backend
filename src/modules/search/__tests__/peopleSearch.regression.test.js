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

  describe('Org People Filters: Skills, Experience, Open to Work', () => {
    test('filters people by skills (single and array)', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [] });

      await searchPeople(mockClient, {
        searchTerm: 'john',
        viewerId: '00000000-0000-0000-0000-000000000001',
        queryParams: {
          skills: ['React', 'Node.js'],
        },
      });

      expect(mockClient.query).toHaveBeenCalledTimes(1);
      const [sql, params] = mockClient.query.mock.calls[0];

      expect(sql).toContain('user_skills us');
      expect(sql).toContain('s_tab.name ILIKE $');
      expect(params).toContain('%React%');
      expect(params).toContain('%Node.js%');
    });

    test('filters people by experience ranges', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [] });

      await searchPeople(mockClient, {
        searchTerm: 'john',
        viewerId: '00000000-0000-0000-0000-000000000001',
        queryParams: {
          experience: ['1-3', '5-8'],
        },
      });

      expect(mockClient.query).toHaveBeenCalledTimes(1);
      const [sql, params] = mockClient.query.mock.calls[0];

      expect(sql).toContain('FROM experiences exp');
      expect(sql).toContain('SUM(');
      expect(params).toContain(1);
      expect(params).toContain(3);
      expect(params).toContain(5);
      expect(params).toContain(8);
    });

    test('filters people by open_to preference (Open to Work)', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [] });

      await searchPeople(mockClient, {
        searchTerm: 'john',
        viewerId: '00000000-0000-0000-0000-000000000001',
        queryParams: {
          open_to: ['Full-time', 'Freelance'],
        },
      });

      expect(mockClient.query).toHaveBeenCalledTimes(1);
      const [sql, params] = mockClient.query.mock.calls[0];

      expect(sql).toContain('p.open_to');
      expect(sql).toContain('REPLACE(REPLACE(LOWER(COALESCE(p.open_to');
      expect(params).toContain('%full time%');
      expect(params).toContain('%freelance%');
    });

    test('filters people when open_to preference has space without hyphen (Full Time)', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [] });

      await searchPeople(mockClient, {
        searchTerm: 'john',
        viewerId: '00000000-0000-0000-0000-000000000001',
        queryParams: {
          open_to: 'Full Time',
        },
      });

      expect(mockClient.query).toHaveBeenCalledTimes(1);
      const [sql, params] = mockClient.query.mock.calls[0];

      expect(sql).toContain('p.open_to');
      expect(sql).toContain('REPLACE(REPLACE(LOWER(COALESCE(p.open_to');
      expect(params).toContain('%full time%');
    });

    test('filters people by pipe-delimited open_to preferences with mixed formats', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [] });

      await searchPeople(mockClient, {
        searchTerm: 'john',
        viewerId: '00000000-0000-0000-0000-000000000001',
        queryParams: {
          open_to: 'Full Time|Part-time',
        },
      });

      expect(mockClient.query).toHaveBeenCalledTimes(1);
      const [sql, params] = mockClient.query.mock.calls[0];

      expect(sql).toContain('p.open_to');
      expect(params).toContain('%full time%');
      expect(params).toContain('%part time%');
    });
  });
});
