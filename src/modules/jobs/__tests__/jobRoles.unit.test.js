'use strict';

const pool = require('../../../core/db/pool');
const { getJobRoles, getInstitutes } = require('../job.controller');

jest.mock('../../../core/db/pool', () => ({
  query: jest.fn(),
}));

describe('Job Roles Master API Unit Tests', () => {
  let req;
  let res;

  beforeEach(() => {
    jest.clearAllMocks();
    req = {
      query: {},
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
  });

  test('returns paginated items, nextCursor, and hasMore when results exceed limit', async () => {
    req.query = { limit: '2' };
    const mockRows = [
      { role_name: 'Backend Developer', category: 'Engineering' },
      { role_name: 'Data Scientist', category: 'Data' },
      { role_name: 'DevOps Engineer', category: 'Engineering' }, // extra (pageSize + 1)
    ];
    pool.query.mockResolvedValueOnce({ rows: mockRows });

    await getJobRoles(req, res);

    const [sql, values] = pool.query.mock.calls[0];
    expect(sql).toContain('FROM job_roles_master');
    expect(sql).toContain('ORDER BY role_name ASC LIMIT $1');
    expect(values).toEqual([3]);

    expect(res.json).toHaveBeenCalledWith({
      items: ['Backend Developer', 'Data Scientist'],
      nextCursor: 'Data Scientist',
      hasMore: true,
    });
  });

  test('filters by search term (q) and handles cursor pagination correctly', async () => {
    req.query = { q: 'Eng', cursor: 'Backend Developer', limit: '10' };
    pool.query.mockResolvedValueOnce({
      rows: [
        { role_name: 'DevOps Engineer', category: 'Engineering' },
      ],
    });

    await getJobRoles(req, res);

    const [sql, values] = pool.query.mock.calls[0];
    expect(sql).toContain('role_name ILIKE $1');
    expect(sql).toContain('role_name > $2');
    expect(sql).toContain('LIMIT $3');
    expect(values).toEqual(['%Eng%', 'Backend Developer', 11]);

    expect(res.json).toHaveBeenCalledWith({
      items: ['DevOps Engineer'],
      nextCursor: null,
      hasMore: false,
    });
  });

  test('handles database query error gracefully with 500 status', async () => {
    pool.query.mockRejectedValueOnce(new Error('DB failure'));

    await getJobRoles(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Internal server error' });
  });
});

describe('Institutes Master / Autocomplete API Unit Tests', () => {
  let req;
  let res;

  beforeEach(() => {
    jest.clearAllMocks();
    req = {
      query: {},
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
  });

  test('queries organizations and educations without referencing nonexistent o.type column', async () => {
    req.query = { limit: '2' };
    const mockRows = [
      { name: 'Harvard University' },
      { name: 'MIT' },
      { name: 'Stanford University' },
    ];
    pool.query.mockResolvedValueOnce({ rows: mockRows });

    await getInstitutes(req, res);

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, values] = pool.query.mock.calls[0];

    expect(sql).toContain("o.entity_type = 'INSTITUTION'");
    expect(sql).not.toContain('o.type');
    expect(sql).toContain('FROM educations ed');
    expect(values).toEqual([3]);

    expect(res.json).toHaveBeenCalledWith({
      items: ['Harvard University', 'MIT'],
      nextCursor: 'MIT',
      hasMore: true,
    });
  });

  test('filters by search term (q) and handles cursor pagination correctly', async () => {
    req.query = { q: 'Stan', cursor: 'MIT', limit: '10' };
    pool.query.mockResolvedValueOnce({
      rows: [{ name: 'Stanford University' }],
    });

    await getInstitutes(req, res);

    const [sql, values] = pool.query.mock.calls[0];
    expect(sql).toContain('name ILIKE $1');
    expect(sql).toContain('name > $2');
    expect(sql).toContain('LIMIT $3');
    expect(values).toEqual(['%Stan%', 'MIT', 11]);

    expect(res.json).toHaveBeenCalledWith({
      items: ['Stanford University'],
      nextCursor: null,
      hasMore: false,
    });
  });

  test('handles database errors gracefully with 500 status', async () => {
    pool.query.mockRejectedValueOnce(new Error('DB failure'));

    await getInstitutes(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Internal server error' });
  });
});

