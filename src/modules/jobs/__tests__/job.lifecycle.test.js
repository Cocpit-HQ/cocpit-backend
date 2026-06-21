const request = require('supertest');
const express = require('express');
const pool = require('../../../core/db/pool');

// Mock Middlewares before importing routes
jest.mock('../../../core/middlewares/auth.middleware', () => ({
  requireAuth: (req, res, next) => {
    req.user = { sub: 'test-user-123' };
    next();
  },
  optionalAuth: (req, res, next) => next()
}));

jest.mock('../../../core/middlewares/organization.auth.middleware', () => ({
  requireOrgPermission: () => (req, res, next) => next(),
  requireCompanyPermission: () => (req, res, next) => next()
}));

jest.mock('../../../core/middlewares/upload.middleware', () => ({
  uploadApplicationFiles: (req, res, next) => next(),
  uploadTaskSubmission: (req, res, next) => next()
}));

// Mock DB Pool
jest.mock('../../../core/db/pool', () => ({
  connect: jest.fn(),
  query: jest.fn()
}));

const jobRoutes = require('../job.routes');

const app = express();
app.use(express.json());
app.use('/jobs', jobRoutes);

describe('Job Lifecycle & AI Actions', () => {
  let mockClient;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient = {
      query: jest.fn(),
      release: jest.fn()
    };
    pool.connect.mockResolvedValue(mockClient);
    pool.query.mockResolvedValue({ rowCount: 1, rows: [{}] });
  });

  describe('POST /jobs/:id/pause', () => {
    it('should pause an ACTIVE job', async () => {
      // Mock SELECT returning an ACTIVE job
      mockClient.query.mockImplementation(async (queryText) => {
        if (queryText.includes('SELECT * FROM jobs')) {
          return { rowCount: 1, rows: [{ job_id: 'job-1', recruiter_id: 'test-user-123', status: 'ACTIVE' }] };
        }
        if (queryText.includes('UPDATE jobs SET status')) {
          return { rowCount: 1, rows: [{ job_id: 'job-1', status: 'PAUSED' }] };
        }
        return { rowCount: 1, rows: [] };
      });

      const res = await request(app).post('/jobs/job-1/pause');
      expect(res.statusCode).toBe(200);
      expect(res.body.message).toBe('Job pause successfully'); // the controller outputs Job pause successfully or Job paused successfully based on string
    });

    it('should prevent pausing an ARCHIVED job', async () => {
      // Mock SELECT returning an ARCHIVED job
      mockClient.query.mockImplementation(async (queryText) => {
        if (queryText.includes('SELECT * FROM jobs')) {
          return { rowCount: 1, rows: [{ job_id: 'job-1', recruiter_id: 'test-user-123', status: 'ARCHIVED' }] };
        }
        return { rowCount: 1, rows: [] };
      });

      const res = await request(app).post('/jobs/job-1/pause');
      expect(res.statusCode).toBe(400);
      expect(res.body.message).toContain('Cannot PAUSE job from status: ARCHIVED');
    });
  });

  describe('POST /jobs/:id/ai/actions', () => {
    it('should successfully apply AI action and record provenance', async () => {
      mockClient.query.mockImplementation(async (queryText) => {
        if (queryText.includes('SELECT * FROM jobs')) {
          return { rowCount: 1, rows: [{ job_id: 'job-1', recruiter_id: 'test-user-123', status: 'DRAFT' }] };
        }
        if (queryText.includes('UPDATE jobs SET')) {
          return { rowCount: 1, rows: [{ job_id: 'job-1', description: 'AI generated desc' }] };
        }
        return { rowCount: 1, rows: [] };
      });

      const res = await request(app)
        .post('/jobs/job-1/ai/actions')
        .send({
          action: 'generate_description',
          updates: { description: 'AI generated desc' }
        });

      expect(res.statusCode).toBe(200);
      expect(res.body.message).toBe('AI action applied successfully');
      
      // Verify job_versions insertion contains 'AI' provenance
      const versionInsertCall = mockClient.query.mock.calls.find(call => 
        call[0].includes('INSERT INTO job_versions')
      );
      expect(versionInsertCall).toBeDefined();
      expect(versionInsertCall[0]).toContain("'AI'");
      expect(versionInsertCall[1]).toContain('generate_description');
    });

    it('should fail if action or updates are missing', async () => {
      const res = await request(app)
        .post('/jobs/job-1/ai/actions')
        .send({ action: 'generate_description' }); // missing updates

      expect(res.statusCode).toBe(400);
      expect(res.body.message).toBe('action and updates are required');
    });
  });
});
