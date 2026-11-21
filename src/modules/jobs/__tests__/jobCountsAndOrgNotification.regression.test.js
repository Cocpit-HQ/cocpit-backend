'use strict';

const pool = require('../../../core/db/pool');
const rbac = require('../../../core/utils/rbac');
const organizationJobsController = require('../../organization/organization.jobs.controller');
const jobController = require('../job.controller');
const socialController = require('../../social/social.controller');

jest.mock('../../../core/db/pool', () => ({
  connect: jest.fn(),
  query: jest.fn(),
}));

jest.mock('../../../core/infrastructure/socket.service', () => ({
  notifyUser: jest.fn(),
  notifyOrg: jest.fn(),
}));

jest.mock('../../../core/utils/rbac', () => ({
  checkOrgPermission: jest.fn(),
}));

describe('Regression Tests: Job Counts Across Tabs & Org Notification Avatar', () => {
  let req, res;

  beforeEach(() => {
    jest.clearAllMocks();
    pool.query.mockReset();
    rbac.checkOrgPermission.mockReset();
    req = {
      user: { sub: 'user-uuid-1' },
      headers: {},
      params: {},
      query: {},
      body: {},
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
  });

  describe('Bug 1: SCRUM-1799 - Organization Job Counts Query', () => {
    test('counts query separates ACTIVE approved jobs from jobs UNDER_REVIEW and includes all statuses', async () => {
      req.params.orgId = 'org-uuid-1';
      req.query.scope = 'internal';

      rbac.checkOrgPermission.mockResolvedValue(true);

      // 1. resolveOrg mock
      pool.query
        .mockResolvedValueOnce({
          rows: [{ org_id: 'org-uuid-1', verification_status: 'VERIFIED' }],
          rowCount: 1,
        })
        // 2. memberCheck mock
        .mockResolvedValueOnce({
          rows: [{ 1: 1 }],
          rowCount: 1,
        })
        // 3. query (jobs) mock
        .mockResolvedValueOnce({
          rows: [],
        })
        // 4. countsQuery mock
        .mockResolvedValueOnce({
          rows: [
            {
              all: 10,
              active: 5,
              closed: 2,
              draft: 1,
              inReview: 2,
              rejected: 0,
            },
          ],
        });

      await organizationJobsController.getOrganizationJobs(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      const jsonResponse = res.json.mock.calls[0][0];

      // Verify counts structure
      expect(jsonResponse.counts).toEqual({
        all: 10,
        active: 5,
        closed: 2,
        draft: 1,
        inReview: 2,
        rejected: 0,
      });

      // Inspect SQL for counts query
      const countsCall = pool.query.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('AS "inReview"')
      );
      expect(countsCall).toBeDefined();
      const countsSql = countsCall[0];

      // Ensure active filter requires moderation_status approved or null
      expect(countsSql).toContain(
        "WHERE j.status = 'ACTIVE' AND (j.moderation_status IS NULL OR j.moderation_status = 'APPROVED')"
      );
      // Ensure inReview filter includes both status and moderation_status
      expect(countsSql).toContain(
        "j.status IN ('IN REVIEW', 'UNDER_REVIEW') OR j.moderation_status = 'UNDER_REVIEW'"
      );
      // Ensure rejected is counted
      expect(countsSql).toContain('AS "rejected"');
    });

    test('recruiter getMyJobs counts query also separates ACTIVE from UNDER_REVIEW', async () => {
      pool.query
        // 1. query (jobs) mock
        .mockResolvedValueOnce({ rows: [] })
        // 2. countsQuery mock
        .mockResolvedValueOnce({
          rows: [
            {
              all: 3,
              active: 1,
              closed: 1,
              draft: 0,
              inReview: 1,
              rejected: 0,
            },
          ],
        });

      await jobController.getMyJobs(req, res);

      const jsonResponse = res.json.mock.calls[0][0];
      expect(jsonResponse.counts).toEqual({
        all: 3,
        active: 1,
        closed: 1,
        draft: 0,
        inReview: 1,
        rejected: 0,
      });

      const countsCall = pool.query.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('AS "inReview"')
      );
      expect(countsCall).toBeDefined();
      expect(countsCall[0]).toContain(
        "WHERE j.status = 'ACTIVE' AND (j.moderation_status IS NULL OR j.moderation_status = 'APPROVED')"
      );
    });
  });

  describe('Bug 2: SCRUM-1843 - Notification Avatar Resolution for ORG_ONBOARDED', () => {
    test('getNotifications query properly resolves ORG_ONBOARDED to org logo rather than creator user avatar', async () => {
      req.user.sub = 'target-user-uuid-1';
      req.query = {};

      pool.query.mockResolvedValueOnce({
        rows: [
          {
            notification_id: 'notif-1',
            type: 'ORG_ONBOARDED',
            actor_name: 'Infinity',
            actor_avatar: 'https://example.com/infinity-logo.png',
            actor_slug: 'infinity',
            is_company_actor: true,
            text: 'Your organisation, Infinity, is now registered with its verified account on Cocpit.',
          },
        ],
      });

      await socialController.getNotifications(req, res);

      const notifs = res.json.mock.calls[0][0];
      expect(notifs).toHaveLength(1);
      expect(notifs[0].type).toBe('ORG_ONBOARDED');
      expect(notifs[0].actor_name).toBe('Infinity');
      expect(notifs[0].actor_avatar).toBe('https://example.com/infinity-logo.png');
      expect(notifs[0].is_company_actor).toBe(true);

      // Verify the generated SQL query contains the specific CASE statement for ORG_ONBOARDED
      const sqlCall = pool.query.mock.calls[0];
      const sql = sqlCall[0];

      expect(sql).toContain("WHEN n.type = 'ORG_ONBOARDED' THEN");
      expect(sql).toContain(
        "COALESCE(NULLIF(n.metadata->>'org_logo', ''), NULLIF(n.metadata->>'orgLogo', ''), NULLIF(n.metadata->>'actor_avatar', ''), c.logo_url, NULL)"
      );
    });
  });
});
