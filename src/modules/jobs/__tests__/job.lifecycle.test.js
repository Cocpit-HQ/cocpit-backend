const request = require('supertest');
const express = require('express');
const pool = require('../../../core/db/pool');

// ─── Mock: Auth Middlewares ───────────────────────────────────────────────────
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

// ─── Mock: DB Pool ────────────────────────────────────────────────────────────
jest.mock('../../../core/db/pool', () => ({
  connect: jest.fn(),
  query: jest.fn()
}));

// ─── Mock: Redis ──────────────────────────────────────────────────────────────
jest.mock('../../../core/cache/redis', () => ({
  get: jest.fn().mockResolvedValue(null),   // Cache miss by default
  setEx: jest.fn().mockResolvedValue('OK'),
}));

// ─── Mock: Gemini SDK ─────────────────────────────────────────────────────────
jest.mock('@google/genai', () => ({
  GoogleGenAI: jest.fn().mockImplementation(() => ({
    models: {
      generateContent: jest.fn(),
    },
  })),
}));

// ─── Mock: AI Service ─────────────────────────────────────────────────────────
// We test the controller in isolation — ai.service.js has its own unit tests.
jest.mock('../../../services/ai.service', () => ({
  generateJobDescription: jest.fn(),
  resetCircuitBreaker: jest.fn(),
}));

// ─── Mock: Rate Limiter ───────────────────────────────────────────────────────
// In tests the rate limiter must be a no-op — otherwise shared in-memory state
// causes 429s after the first few requests inside the same process.
jest.mock('../../../core/middlewares/rateLimiter.middleware', () => ({
  createAIRateLimiter: () => (req, res, next) => next(),
  createAutosaveRateLimiter: () => (req, res, next) => next(),
}));

const jobRoutes = require('../job.routes');
const aiService = require('../../../services/ai.service');
const redis = require('../../../core/cache/redis');

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

// =============================================================================
// AI Job Description Generator — POST /jobs/:id/generate
// =============================================================================

/** Shared mock for a valid Gemini-generated JD */
const MOCK_GENERATED_JD = {
  title: 'Software Engineer',
  summary: 'We are looking for a skilled Software Engineer to join our team.',
  description: 'As a Software Engineer you will design and build scalable systems.',
  responsibilities: ['Build APIs', 'Write unit tests'],
  requirements: ['3+ years Node.js', 'PostgreSQL experience'],
  preferred_skills: ['Experience with Redis', 'TypeScript knowledge'],
  employment_type: 'Full-time',
  experience_min: 3,
  experience_max: 6,
  education: "Bachelor's degree in Computer Science or equivalent",
  skills: ['Node.js', 'PostgreSQL', 'Redis'],
  benefits: ['Health insurance', 'Remote work'],
};

const mockDraftJob = (overrides = {}) => ({
  job_id: 'job-1',
  recruiter_id: 'test-user-123',
  org_id: null,
  company_name: 'Cocpit Corp',
  status: 'DRAFT',
  ...overrides,
});

describe('POST /jobs/:id/generate — AI JD Generator', () => {
  let mockClient;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient = { query: jest.fn(), release: jest.fn() };
    pool.connect.mockResolvedValue(mockClient);
    redis.get.mockResolvedValue(null);
    redis.setEx.mockResolvedValue('OK');
    aiService.generateJobDescription.mockResolvedValue(MOCK_GENERATED_JD);
  });

  // ── Input Validation ────────────────────────────────────────────────────────

  it('TC-01: should return 400 when role is missing', async () => {
    const res = await request(app).post('/jobs/job-1/generate').send({});
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/role.*required/i);
  });

  it('TC-02: should return 400 when role is an empty string', async () => {
    mockClient.query.mockResolvedValue({ rowCount: 1, rows: [mockDraftJob()] });
    const res = await request(app).post('/jobs/job-1/generate').send({ role: '   ' });
    expect(res.statusCode).toBe(400);
  });

  it('TC-03: should return 400 when role exceeds 100 characters', async () => {
    const res = await request(app)
      .post('/jobs/job-1/generate')
      .send({ role: 'A'.repeat(101) });
    expect(res.statusCode).toBe(400);
    expect(res.body.field).toBe('role');
  });

  it('TC-04: should return 400 when role contains HTML tags', async () => {
    const res = await request(app)
      .post('/jobs/job-1/generate')
      .send({ role: '<script>alert(1)</script>' });
    expect(res.statusCode).toBe(400);
    expect(res.body.field).toBe('role');
  });

  // ── Job State & Ownership ───────────────────────────────────────────────────

  it('TC-05: should return 404 when job does not exist', async () => {
    mockClient.query.mockImplementation(async (sql) => {
      if (typeof sql === 'string' && sql.includes('SELECT job_id')) return { rowCount: 0, rows: [] };
      return {};
    });
    const res = await request(app).post('/jobs/job-999/generate').send({ role: 'Developer' });
    expect(res.statusCode).toBe(404);
  });

  it('TC-06: should return 400 when job status is ARCHIVED', async () => {
    mockClient.query.mockImplementation(async (sql) => {
      if (typeof sql === 'string' && sql.includes('SELECT job_id')) {
        return { rowCount: 1, rows: [mockDraftJob({ status: 'ARCHIVED' })] };
      }
      return {};
    });
    const res = await request(app).post('/jobs/job-1/generate').send({ role: 'Developer' });
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toContain('ARCHIVED');
  });

  it('TC-07: should return 403 when user does not own the job', async () => {
    mockClient.query.mockImplementation(async (sql) => {
      if (typeof sql === 'string' && sql.includes('SELECT job_id')) {
        return { rowCount: 1, rows: [mockDraftJob({ recruiter_id: 'other-user-999' })] };
      }
      return {};
    });
    const res = await request(app).post('/jobs/job-1/generate').send({ role: 'Developer' });
    expect(res.statusCode).toBe(403);
  });

  // ── Cache Hit ───────────────────────────────────────────────────────────────

  it('TC-08: should return cached result and NOT call Gemini on cache hit', async () => {
    mockClient.query.mockImplementation(async (sql) => {
      if (typeof sql === 'string' && sql.includes('SELECT job_id')) {
        return { rowCount: 1, rows: [mockDraftJob()] };
      }
      return {};
    });
    redis.get.mockResolvedValue(JSON.stringify(MOCK_GENERATED_JD));

    const res = await request(app).post('/jobs/job-1/generate').send({ role: 'Software Engineer' });

    expect(res.statusCode).toBe(200);
    expect(res.body.ai_metadata.cached).toBe(true);
    expect(aiService.generateJobDescription).not.toHaveBeenCalled();
  });

  // ── Successful End-to-End Generation ───────────────────────────────────────

  it('TC-09: should generate and persist JD successfully on cache miss', async () => {
    mockClient.query.mockImplementation(async (sql) => {
      if (typeof sql !== 'string') return {};
      if (sql.includes('SELECT job_id')) return { rowCount: 1, rows: [mockDraftJob()] };
      if (sql.includes('UPDATE jobs SET')) {
        return { rowCount: 1, rows: [{ job_id: 'job-1', title: 'Software Engineer', status: 'DRAFT' }] };
      }
      return { rowCount: 1, rows: [] };
    });

    const res = await request(app).post('/jobs/job-1/generate').send({ role: 'Software Engineer' });

    expect(res.statusCode).toBe(200);
    expect(res.body.message).toContain('generated successfully');
    expect(res.body.ai_metadata.cached).toBe(false);
    expect(aiService.generateJobDescription).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'Software Engineer' })
    );
  });

  it('TC-10: should write provenance=AI record to job_versions', async () => {
    mockClient.query.mockImplementation(async (sql) => {
      if (typeof sql !== 'string') return {};
      if (sql.includes('SELECT job_id')) return { rowCount: 1, rows: [mockDraftJob()] };
      if (sql.includes('UPDATE jobs SET')) {
        return { rowCount: 1, rows: [{ job_id: 'job-1', title: 'Software Engineer' }] };
      }
      return { rowCount: 1, rows: [] };
    });

    await request(app).post('/jobs/job-1/generate').send({ role: 'Software Engineer' });

    const versionInsert = mockClient.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO job_versions')
    );
    expect(versionInsert).toBeDefined();
    expect(versionInsert[0]).toContain("'AI'");
    expect(versionInsert[0]).toContain('AI_GENERATE');
  });

  // ── AI Service Failures ────────────────────────────────────────────────────

  it('TC-11: should return 503 when circuit breaker is OPEN', async () => {
    mockClient.query.mockImplementation(async (sql) => {
      if (typeof sql === 'string' && sql.includes('SELECT job_id')) {
        return { rowCount: 1, rows: [mockDraftJob()] };
      }
      return {};
    });
    const err = Object.assign(new Error('Circuit OPEN'), { statusCode: 503 });
    aiService.generateJobDescription.mockRejectedValue(err);

    const res = await request(app).post('/jobs/job-1/generate').send({ role: 'Developer' });
    expect(res.statusCode).toBe(503);
  });

  it('TC-12: should return 503 when both primary and fallback models fail', async () => {
    mockClient.query.mockImplementation(async (sql) => {
      if (typeof sql === 'string' && sql.includes('SELECT job_id')) {
        return { rowCount: 1, rows: [mockDraftJob()] };
      }
      return {};
    });
    const err = Object.assign(new Error('Both models failed'), { statusCode: 503 });
    aiService.generateJobDescription.mockRejectedValue(err);

    const res = await request(app).post('/jobs/job-1/generate').send({ role: 'Developer' });
    expect(res.statusCode).toBe(503);
  });

  // ── Validation Pipeline ────────────────────────────────────────────────────

  it('TC-13: should return 422 when AI output fails schema validation (missing fields)', async () => {
    mockClient.query.mockImplementation(async (sql) => {
      if (typeof sql === 'string' && sql.includes('SELECT job_id')) {
        return { rowCount: 1, rows: [mockDraftJob()] };
      }
      return {};
    });
    // Malformed: missing most required fields
    aiService.generateJobDescription.mockResolvedValue({ title: 'Incomplete' });

    const res = await request(app).post('/jobs/job-1/generate').send({ role: 'Developer' });
    expect(res.statusCode).toBe(422);
  });

  it('TC-14: should return 422 when experience_min > experience_max', async () => {
    mockClient.query.mockImplementation(async (sql) => {
      if (typeof sql === 'string' && sql.includes('SELECT job_id')) {
        return { rowCount: 1, rows: [mockDraftJob()] };
      }
      return {};
    });
    aiService.generateJobDescription.mockResolvedValue({
      ...MOCK_GENERATED_JD,
      experience_min: 10,
      experience_max: 2, // Invalid: min > max
    });

    const res = await request(app).post('/jobs/job-1/generate').send({ role: 'Developer' });
    expect(res.statusCode).toBe(422);
    expect(res.body.field).toBe('experience_max');
  });
});
