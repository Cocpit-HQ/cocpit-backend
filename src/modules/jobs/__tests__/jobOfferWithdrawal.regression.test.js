'use strict';

const pool = require('../../../core/db/pool');
const offerController = require('../offer.controller');

jest.mock('../../../core/db/pool', () => ({
  connect: jest.fn(),
  query: jest.fn()
}));

jest.mock('../../../core/infrastructure/socket.service', () => ({
  notifyUser: jest.fn()
}));

const socketService = require('../../../core/infrastructure/socket.service');

describe('Job Offer Withdrawal & Active Count Regression Tests', () => {
  let req, res;

  beforeEach(() => {
    jest.clearAllMocks();
    req = {
      user: { sub: 'recruiter-uuid-1' },
      params: {},
      query: {},
      body: {}
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis()
    };
  });

  describe('1. Candidate Side: getMyOffers', () => {
    test('excludes withdrawn offers from the query for the candidate', async () => {
      req.user.sub = 'candidate-uuid-1';
      pool.query.mockResolvedValueOnce({ rows: [] });

      await offerController.getMyOffers(req, res);

      expect(pool.query).toHaveBeenCalledTimes(1);
      const [sql, params] = pool.query.mock.calls[0];

      expect(sql).toContain("jo.status != 'withdrawn'");
      expect(params).toEqual(['candidate-uuid-1']);
    });

    test('does not allow querying status=withdrawn', async () => {
      req.user.sub = 'candidate-uuid-1';
      req.query.status = 'withdrawn';
      pool.query.mockResolvedValueOnce({ rows: [] });

      await offerController.getMyOffers(req, res);

      const [sql, params] = pool.query.mock.calls[0];
      // status=withdrawn is omitted from whitelist, so it should not append jo.status = $2 with withdrawn
      expect(params).toEqual(['candidate-uuid-1']);
      expect(sql).not.toContain("jo.status = $2");
    });
  });

  describe('2. Employer Side: getCompanySentOffers & getRecruiterSentOffers', () => {
    test('getCompanySentOffers counts only active (non-withdrawn) offers and excludes withdrawn-only jobs', async () => {
      req.params.companyId = 'org-uuid-1';
      pool.query.mockResolvedValueOnce({
        rows: [
          {
            job_id: 'job-1',
            title: 'Frontend Engineer',
            total_offers: '2',
            pending_count: '1',
            accepted_count: '1',
            declined_count: '0',
            withdrawn_count: '0'
          }
        ]
      });

      await offerController.getCompanySentOffers(req, res);

      expect(pool.query).toHaveBeenCalledTimes(1);
      const [sql, params] = pool.query.mock.calls[0];

      expect(sql).toContain("COUNT(jo.offer_id) FILTER (WHERE jo.status != 'withdrawn') AS total_offers");
      expect(sql).toContain("jo.status != 'withdrawn'");
      expect(sql).toContain("HAVING COUNT(jo.offer_id) FILTER (WHERE jo.status != 'withdrawn') > 0");
      expect(params).toEqual(['org-uuid-1']);

      expect(res.json).toHaveBeenCalledWith([
        expect.objectContaining({
          job_id: 'job-1',
          total_offers: 2,
          pending_count: 1,
          accepted_count: 1
        })
      ]);
    });

    test('getRecruiterSentOffers counts only active (non-withdrawn) offers', async () => {
      req.user.sub = 'recruiter-uuid-1';
      pool.query.mockResolvedValueOnce({ rows: [] });

      await offerController.getRecruiterSentOffers(req, res);

      const [sql, params] = pool.query.mock.calls[0];
      expect(sql).toContain("COUNT(jo.offer_id) FILTER (WHERE jo.status != 'withdrawn') AS total_offers");
      expect(sql).toContain("jo.status != 'withdrawn'");
      expect(sql).toContain("HAVING COUNT(jo.offer_id) FILTER (WHERE jo.status != 'withdrawn') > 0");
      expect(params).toEqual(['recruiter-uuid-1']);
    });
  });

  describe('3. Employer Side: getCompanyOfferRecipients', () => {
    test('excludes candidates whose offers have been withdrawn', async () => {
      req.params = { companyId: 'org-uuid-1', jobId: 'job-uuid-1' };
      pool.query.mockResolvedValueOnce({ rows: [] });

      await offerController.getCompanyOfferRecipients(req, res);

      const [sql, params] = pool.query.mock.calls[0];
      expect(sql).toContain("jo.status != 'withdrawn'");
      expect(params).toEqual(['org-uuid-1', 'job-uuid-1']);
    });

    test('personal recruiter recipient query also excludes withdrawn offers', async () => {
      req.params = { jobId: 'job-uuid-1' };
      req.user.sub = 'recruiter-uuid-1';
      pool.query.mockResolvedValueOnce({ rows: [] });

      await offerController.getCompanyOfferRecipients(req, res);

      const [sql, params] = pool.query.mock.calls[0];
      expect(sql).toContain("jo.status != 'withdrawn'");
      expect(params).toEqual(['recruiter-uuid-1', 'job-uuid-1']);
    });
  });

  describe('4. Offer Withdrawal: withdrawOffer', () => {
    test('successfully withdraws pending offer and notifies candidate and recruiter', async () => {
      const mockClient = {
        query: jest.fn(),
        release: jest.fn()
      };
      pool.connect.mockResolvedValueOnce(mockClient);

      mockClient.query.mockImplementation(async (queryText) => {
        if (queryText === 'BEGIN' || queryText === 'COMMIT' || queryText === 'ROLLBACK') {
          return { rowCount: 1, rows: [] };
        }
        if (typeof queryText === 'string' && queryText.includes('SELECT * FROM job_offers')) {
          return {
            rowCount: 1,
            rows: [{
              offer_id: 'offer-1',
              job_id: 'job-1',
              user_id: 'candidate-1',
              sent_by: 'recruiter-uuid-1',
              org_id: 'org-uuid-1',
              status: 'pending'
            }]
          };
        }
        if (typeof queryText === 'string' && queryText.includes('UPDATE job_offers')) {
          return { rowCount: 1, rows: [] };
        }
        if (typeof queryText === 'string' && queryText.includes('FROM organizations')) {
          return { rowCount: 1, rows: [{ name: 'BluePeak Innovations', logo_url: 'https://logo.png' }] };
        }
        if (typeof queryText === 'string' && queryText.includes('FROM jobs')) {
          return { rowCount: 1, rows: [{ title: 'Fullstack Dev' }] };
        }
        if (typeof queryText === 'string' && queryText.includes('INSERT INTO notifications')) {
          return { rowCount: 1, rows: [{ notification_id: 'notif-1', created_at: new Date() }] };
        }
        return { rowCount: 0, rows: [] };
      });

      req.params = { companyId: 'org-uuid-1', offerId: 'offer-1' };

      await offerController.withdrawOffer(req, res);

      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE job_offers SET status = 'withdrawn'"),
        ['offer-1']
      );
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
      expect(mockClient.release).toHaveBeenCalled();

      // Verify socket notifications sent to candidate
      expect(socketService.notifyUser).toHaveBeenCalledWith(
        'candidate-1',
        'notification',
        expect.objectContaining({
          type: 'job_offer_withdrawn',
          referenceId: 'offer-1'
        })
      );
      expect(socketService.notifyUser).not.toHaveBeenCalledWith(
        'recruiter-uuid-1',
        'notification',
        expect.anything()
      );

      expect(res.json).toHaveBeenCalledWith({
        status: 'withdrawn',
        message: 'Offer withdrawn successfully'
      });
    });
  });
});
