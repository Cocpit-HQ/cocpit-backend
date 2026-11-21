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

describe('SCRUM-120 / SCRUM-1855: User-Side Job Application Notifications Filtered from Business Side', () => {
  let req, res;

  beforeEach(() => {
    jest.clearAllMocks();
    req = {
      user: { sub: 'business-admin-uuid-1' },
      actor: { type: 'ORGANIZATION', orgId: 'company-uuid-101' },
      query: { companyId: 'company-uuid-101' },
      headers: {
        'x-actor-type': 'ORGANIZATION',
        'x-actor-id': 'company-uuid-101',
      },
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
  });

  test('TC-01: excludes candidate application status notifications from organization query', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await socialController.getNotifications(req, res);

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql] = pool.query.mock.calls[0];

    // Ensure candidate application status notification types are blacklisted from org query
    expect(sql).toContain("'application_submitted'");
    expect(sql).toContain("'application_under_review'");
    expect(sql).toContain("'application_shortlisted'");
    expect(sql).toContain("'application_rejected'");
    expect(sql).toContain("'application_declined'");
    expect(sql).toContain("'job_offer'");
    expect(sql).toContain("'offer_expiring'");
    expect(sql).toContain("'job_alert'");
  });

  test('TC-02: excludes candidate offer actions from leaking into business feed', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await socialController.getNotifications(req, res);

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql] = pool.query.mock.calls[0];

    expect(sql).toContain("'job_offer_withdrawn'");
    expect(sql).toContain("'job_offer_received'");
    expect(sql).toContain("'job_offer_accepted'");
    expect(sql).toContain("'job_offer_declined'");
  });

  test('TC-03: candidate personal query retrieves user notifications without org blacklist', async () => {
    const userReq = {
      user: { sub: 'candidate-uuid-202' },
      actor: { type: 'USER' },
      query: {},
      headers: {},
    };

    pool.query.mockResolvedValueOnce({
      rows: [
        {
          notification_id: 'notif-cand-1',
          user_id: 'candidate-uuid-202',
          type: 'application_shortlisted',
          text: '"Acme Corp" has shortlisted your application for the role "Frontend Developer"',
        },
      ],
    });

    await socialController.getNotifications(userReq, res);

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];

    expect(sql).toContain('n.user_id = $1');
    expect(sql).toContain('n.recipient_org_id IS NULL');
    expect(params[0]).toBe('candidate-uuid-202');
    expect(res.json).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'application_shortlisted',
          user_id: 'candidate-uuid-202',
        }),
      ])
    );
  });
});
