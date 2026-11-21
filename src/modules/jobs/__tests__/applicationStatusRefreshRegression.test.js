const applicationController = require('../applications/application.controller');
const jobController = require('../job.controller');
const pool = require('../../../core/db/pool');
const socketService = require('../../../services/socket.service');

describe('SCRUM-8 / SCRUM-1958: Candidate Application Status Real-Time Refresh Regression Tests', () => {
  let mockReq;
  let mockRes;

  beforeEach(() => {
    jest.restoreAllMocks();
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('updateApplicationStatus real-time socket events', () => {
    test('TC-01: emits job_application_updated socket event and notification when shortlisted', async () => {
      mockReq = {
        params: { id: 'app-uuid-101' },
        body: { status: 'Shortlisted' },
        user: { sub: 'recruiter-uuid-202' },
        actor: { type: 'USER' },
      };

      // Exact query sequence:
      // 1. getApplicationOwnership (SELECT j.org_id, j.recruiter_id)
      // 2. UPDATE job_applications
      // 3. INSERT INTO application_status_history
      // 4. appDetailsRes (SELECT ja.applicant_id, j.title...)
      // 5. recruiterRes (SELECT full_name, avatar_url...)
      // 6. INSERT INTO notifications
      jest
        .spyOn(pool, 'query')
        .mockResolvedValueOnce({
          rows: [
            { application_id: 'app-uuid-101', org_id: null, recruiter_id: 'recruiter-uuid-202' },
          ],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rowCount: 1 }) // UPDATE job_applications
        .mockResolvedValueOnce({ rowCount: 1 }) // INSERT status history
        .mockResolvedValueOnce({
          rows: [
            {
              applicant_id: 'candidate-uuid-303',
              title: 'Frontend Engineer',
              job_id: 'job-uuid-404',
              company_name: 'Acme Corp',
              org_id: null,
              company_avatar: null,
              applicant_email: 'candidate@example.com',
            },
          ],
          rowCount: 1,
        }) // appDetailsRes
        .mockResolvedValueOnce({
          rows: [{ full_name: 'Recruiter Bob', avatar_url: null }],
          rowCount: 1,
        }) // recruiterRes
        .mockResolvedValueOnce({ rows: [{ notification_id: 'notif-uuid-505' }], rowCount: 1 }); // INSERT notifications

      const notifySpy = jest.spyOn(socketService, 'notifyUser').mockResolvedValue(true);

      await applicationController.updateApplicationStatus(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Status updated', status: 'Shortlisted' })
      );

      // Verify real-time socket event for immediate status and button refresh
      expect(notifySpy).toHaveBeenCalledWith(
        'candidate-uuid-303',
        'job_application_updated',
        expect.objectContaining({
          applicationId: 'app-uuid-101',
          jobId: 'job-uuid-404',
          status: 'Shortlisted',
        })
      );

      // Verify standard notification event
      expect(notifySpy).toHaveBeenCalledWith(
        'candidate-uuid-303',
        'notification',
        expect.objectContaining({
          type: 'application_shortlisted',
          referenceId: 'job-uuid-404',
        })
      );
    });
  });

  describe('getMyApplications status filtering', () => {
    test('TC-02: getMyApplications with status=applied isolates applied applications', async () => {
      mockReq = {
        user: { sub: 'candidate-uuid-303' },
        query: { status: 'applied' },
      };

      let executedQuery = '';
      jest.spyOn(pool, 'query').mockImplementationOnce(async (sql) => {
        executedQuery = sql;
        return { rows: [] };
      });

      await jobController.getMyApplications(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalledWith([]);
      expect(executedQuery).toContain("ja.current_status ILIKE 'applied'");
      expect(executedQuery).not.toContain("NOT ILIKE 'Offer%'");
    });

    test('TC-03: getMyApplications with status=shortlisted isolates shortlisted applications', async () => {
      mockReq = {
        user: { sub: 'candidate-uuid-303' },
        query: { status: 'shortlisted' },
      };

      let executedQuery = '';
      jest.spyOn(pool, 'query').mockImplementationOnce(async (sql) => {
        executedQuery = sql;
        return { rows: [] };
      });

      await jobController.getMyApplications(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalledWith([]);
      expect(executedQuery).toContain("ja.current_status ILIKE 'shortlisted'");
    });

    test('TC-04: getMyApplications with status=all does not restrict by current_status', async () => {
      mockReq = {
        user: { sub: 'candidate-uuid-303' },
        query: { status: 'all' },
      };

      let executedQuery = '';
      jest.spyOn(pool, 'query').mockImplementationOnce(async (sql) => {
        executedQuery = sql;
        return { rows: [] };
      });

      await jobController.getMyApplications(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalledWith([]);
      expect(executedQuery).not.toContain("ja.current_status ILIKE 'applied'");
      expect(executedQuery).not.toContain("ja.current_status ILIKE 'shortlisted'");
    });
  });
});
