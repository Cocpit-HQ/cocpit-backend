'use strict';

/**
 * Regression Test Suite for SCRUM-115 / SCRUM-1845:
 * Incorrect Owner Name Displayed in Offer Sent Note
 */

const pool = require('../../../core/db/pool');
const offerController = require('../offer.controller');
const jobController = require('../job.controller');
const fs = require('fs');
const path = require('path');

jest.mock('../../../core/db/pool', () => ({
  query: jest.fn(),
  connect: jest.fn()
}));

jest.mock('../../../core/infrastructure/socket.service', () => ({
  notifyUser: jest.fn(),
  notifyOrg: jest.fn()
}));

jest.mock('../../notification/notification.service', () => ({
  sendToUser: jest.fn().mockResolvedValue({})
}));

describe('SCRUM-115 / SCRUM-1845: Offer Sender Identity Regression Tests', () => {
  let req, res;

  beforeEach(() => {
    jest.clearAllMocks();
    req = {
      user: { sub: 'team-member-uuid' },
      params: {},
      query: {},
      body: {}
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };
  });

  describe('1. Backend Controller: getCompanyOfferRecipients', () => {
    test('TC-01: selects sent_by_name, sent_by_avatar, and sent_by_headline from jo.sent_by', async () => {
      req.params = { companyId: 'org-123', jobId: 'job-456' };

      const mockRows = [
        {
          offer_id: 'offer-1',
          org_id: 'org-123',
          sent_by: 'team-member-uuid',
          status: 'pending',
          message: 'Personal note from team recruiter',
          user_id: 'candidate-uuid',
          full_name: 'Candidate User',
          avatar_url: 'https://cdn.example.com/cand.jpg',
          headline: 'Senior Full Stack Engineer',
          candidate_company_name: 'Tech Inc',
          sent_by_name: 'Jane Smith',
          sent_by_headline: 'Talent Acquisition Partner',
          sent_by_avatar: 'https://cdn.example.com/jane.jpg'
        }
      ];

      pool.query.mockResolvedValueOnce({ rows: mockRows });

      await offerController.getCompanyOfferRecipients(req, res);

      expect(pool.query).toHaveBeenCalledTimes(1);
      const [sql, params] = pool.query.mock.calls[0];

      // Verifies SQL includes sender identity fields and joins on jo.sent_by
      expect(sql).toContain('sent_by_name');
      expect(sql).toContain('sent_by_avatar');
      expect(sql).toContain('sent_by_headline');
      expect(sql).toContain('jo.sent_by');
      expect(params).toEqual(['org-123', 'job-456']);

      expect(res.json).toHaveBeenCalledWith(mockRows);
      const recipient = res.json.mock.calls[0][0][0];
      expect(recipient.sent_by_name).toBe('Jane Smith');
      expect(recipient.sent_by_avatar).toBe('https://cdn.example.com/jane.jpg');
      expect(recipient.sent_by_headline).toBe('Talent Acquisition Partner');
    });

    test('TC-02: personal recruiter query also returns sender name, avatar, and headline', async () => {
      req.params = { jobId: 'job-456' };
      req.user.sub = 'recruiter-uuid';

      pool.query.mockResolvedValueOnce({ rows: [] });

      await offerController.getCompanyOfferRecipients(req, res);

      const [sql, params] = pool.query.mock.calls[0];
      expect(sql).toContain('sent_by_name');
      expect(sql).toContain('sent_by_avatar');
      expect(sql).toContain('sent_by_headline');
      expect(params).toEqual(['recruiter-uuid', 'job-456']);
    });
  });

  describe('2. Backend Controller: getOfferDetail & getMyOffers', () => {
    test('TC-03: getOfferDetail returns individual offer_sender_* details alongside company display metadata', async () => {
      req.params = { offerId: 'offer-1' };
      req.user.sub = 'candidate-uuid';

      const mockOffer = {
        offer_id: 'offer-1',
        job_id: 'job-456',
        org_id: 'org-123',
        company_display_name: 'Acme Corp',
        company_logo: 'https://cdn.example.com/acme-logo.jpg',
        sent_by_name: 'Acme Corp',
        offer_sender_name: 'Jane Smith',
        offer_sender_avatar: 'https://cdn.example.com/jane.jpg',
        offer_sender_headline: 'Talent Acquisition Partner'
      };

      pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [mockOffer] });

      await offerController.getOfferDetail(req, res);

      const [sql] = pool.query.mock.calls[0];
      expect(sql).toContain('offer_sender_name');
      expect(sql).toContain('offer_sender_avatar');
      expect(sql).toContain('offer_sender_headline');
      expect(res.json).toHaveBeenCalledWith(mockOffer);
    });

    test('TC-04: getMyOffers selects offer_sender_name, offer_sender_avatar, offer_sender_headline', async () => {
      req.user.sub = 'candidate-uuid';
      pool.query.mockResolvedValueOnce({ rows: [] });

      await offerController.getMyOffers(req, res);

      const [sql] = pool.query.mock.calls[0];
      expect(sql).toContain('offer_sender_name');
      expect(sql).toContain('offer_sender_avatar');
      expect(sql).toContain('offer_sender_headline');
    });
  });

  describe('3. Backend Controller: getJobById Contract Check', () => {
    test('TC-05: getJobById prioritizes u_sender.full_name over company/owner for offer_sender_name', async () => {
      const source = fs.readFileSync(path.resolve(__dirname, '../job.controller.js'), 'utf8');

      // Ensures u_sender is prioritized before falling back to company/owner
      expect(source).toContain('COALESCE(u_sender.full_name, CASE WHEN j.org_id IS NOT NULL');
      expect(source).toContain('COALESCE(u_sender.avatar_url, CASE WHEN j.org_id IS NOT NULL');
      expect(source).toContain('COALESCE(u_sender.headline, CASE WHEN j.org_id IS NOT NULL');
    });
  });

  describe('4. Frontend Contract Validations', () => {
    test('TC-06: OfferDetailsScreen does not override sentByAvatar with activeProfile org logo and uses isCompany={false}', () => {
      const screenPath = path.resolve(
        __dirname,
        '../../../../../cocpit-frontend/src/features/jobs/components/my-listings/OfferDetailsScreen.tsx'
      );
      const source = fs.readFileSync(screenPath, 'utf8');

      // Check that avatar fallback to activeProfile is removed
      expect(source).not.toContain('(item.org_id && activeProfile && activeProfile.id === item.org_id ? (activeProfile as any)?.avatar_url : undefined)');
      expect(source).toContain('sentByAvatar: item.sent_by_avatar || item.sent_by_avatar_url || undefined');

      // Check that Avatar in note sender uses isCompany={false}
      expect(source).toContain('isCompany={false}');
      expect(source).not.toContain('isCompany={Boolean(cand.orgId)}');
    });

    test('TC-07: OfferCard uses individual sender info when available', () => {
      const cardPath = path.resolve(
        __dirname,
        '../../../../../cocpit-frontend/src/features/jobs/components/cards/OfferCard.tsx'
      );
      const source = fs.readFileSync(cardPath, 'utf8');

      expect(source).toContain('noteSenderName = rawOffer.offer_sender_name || rawOffer.sent_by_name');
      expect(source).toContain('noteAvatar = rawOffer.offer_sender_avatar || rawOffer.sent_by_avatar');
      expect(source).toContain('noteSenderTitle = rawOffer.offer_sender_headline || rawOffer.sent_by_headline');
    });
  });
});
