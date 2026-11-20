'use strict';

jest.mock('../../../core/db/pool', () => ({
  query: jest.fn(),
  connect: jest.fn(() => ({
    query: jest.fn(),
    release: jest.fn(),
  })),
  on: jest.fn(),
}));

jest.mock('../../../core/cache/redis', () => ({
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
  on: jest.fn(),
  quit: jest.fn(),
  status: 'ready',
}));

jest.mock('../../../core/db/redis', () => ({
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
  on: jest.fn(),
  quit: jest.fn(),
  status: 'ready',
}));

const pool = require('../../../core/db/pool');
const socialController = require('../social.controller');

describe('SCRUM-115 / SCRUM-1833: Offer Response Notification Organization Filter', () => {
  let req, res;

  beforeEach(() => {
    jest.clearAllMocks();
    req = {
      user: { sub: 'admin-user-uuid' },
      actor: { type: 'ORGANIZATION', orgId: 'company-uuid-1' },
      query: { companyId: 'company-uuid-1' },
      headers: {
        'x-actor-type': 'ORGANIZATION',
        'x-actor-id': 'company-uuid-1'
      }
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis()
    };
  });

  test('excludes candidate job_offer_accepted and job_offer_declined notifications from organization feed query', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await socialController.getNotifications(req, res);

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql] = pool.query.mock.calls[0];

    // SQL query must exclude candidate confirmation types from leaking via metadata->>'org_id'
    expect(sql).toContain("'job_offer_accepted'");
    expect(sql).toContain("'job_offer_declined'");
  });
});
