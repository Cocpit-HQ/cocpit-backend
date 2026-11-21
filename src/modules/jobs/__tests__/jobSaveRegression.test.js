const { saveJob, unsaveJob } = require('../job.controller');
const featureFlagsService = require('../../config/featureFlags.service');
const pool = require('../../../core/db/pool');

describe('SCRUM-8 / SCRUM-1956: Job Save & Unsave Regression Tests', () => {
  let mockReq;
  let mockRes;

  beforeEach(() => {
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('TC-01: saveJob succeeds when saved_jobs flag is undefined in memory (default to enabled)', async () => {
    // Clear in-memory flag so saved_jobs is undefined
    jest.spyOn(featureFlagsService, 'getFlags').mockReturnValue({});
    jest.spyOn(pool, 'query').mockResolvedValueOnce({ rowCount: 1 });

    mockReq = {
      user: { sub: 'user-uuid-123' },
      params: { id: 'job-uuid-456' },
    };

    await saveJob(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(201);
    expect(mockRes.json).toHaveBeenCalledWith({ message: 'Job saved successfully' });
  });

  test('TC-02: saveJob succeeds when saved_jobs flag is explicitly true', async () => {
    jest.spyOn(featureFlagsService, 'getFlags').mockReturnValue({ saved_jobs: true });
    jest.spyOn(pool, 'query').mockResolvedValueOnce({ rowCount: 1 });

    mockReq = {
      user: { sub: 'user-uuid-123' },
      params: { id: 'job-uuid-456' },
    };

    await saveJob(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(201);
    expect(mockRes.json).toHaveBeenCalledWith({ message: 'Job saved successfully' });
  });

  test('TC-03: saveJob blocks with 403 ONLY when saved_jobs flag is explicitly false', async () => {
    jest.spyOn(featureFlagsService, 'getFlags').mockReturnValue({ saved_jobs: false });

    mockReq = {
      user: { sub: 'user-uuid-123' },
      params: { id: 'job-uuid-456' },
    };

    await saveJob(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(403);
    expect(mockRes.json).toHaveBeenCalledWith({
      message: 'Job saving is currently disabled by administrators.',
    });
  });

  test('TC-04: unsaveJob deletes job save and returns 200', async () => {
    jest.spyOn(pool, 'query').mockResolvedValueOnce({ rowCount: 1 });

    mockReq = {
      user: { sub: 'user-uuid-123' },
      params: { id: 'job-uuid-456' },
    };

    await unsaveJob(mockReq, mockRes);

    expect(mockRes.json).toHaveBeenCalledWith({ message: 'Job removed from saved list' });
  });
});
