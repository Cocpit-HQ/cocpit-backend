/* global jest */
const { describe, expect, test, beforeEach } = require('@jest/globals');
const mockQuery = jest.fn();
const mockGetJob = jest.fn();
const mockAddJob = jest.fn();
jest.mock('../core/db/pool', () => ({ query: mockQuery }));
jest.mock('../queues/media.queue', () => ({ mediaTranscodeQueue: { getJob: mockGetJob }, addTranscodeJob: mockAddJob }));
const { enqueueExistingImageVariants } = require('./enqueueExistingImageVariants');

describe('existing image responsive variant backfill', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.R2_PUBLIC_URL = 'https://cdn.example';
    process.env.REDIS_URL = 'redis://localhost:6379';
    mockQuery.mockResolvedValue({ rows: [
      { media_id: 'm1', post_id: 'p1', owner_id: 'u1', master_url: 'https://cdn.example/raw/posts/u1-1-photo.jpg' },
      { media_id: 'm2', post_id: 'p2', owner_id: 'u2', master_url: 'https://cdn.example/raw/posts/another-user-photo.jpg' },
    ] });
  });

  test('dry run never touches the queue and rejects non-owned object keys', async () => {
    await expect(enqueueExistingImageVariants()).resolves.toEqual({ scanned: 2, eligible: 1, queued: 0, skipped: 0, dryRun: true });
    expect(mockGetJob).not.toHaveBeenCalled();
    expect(mockAddJob).not.toHaveBeenCalled();
  });

  test('queues only eligible rows and leaves working display state untouched', async () => {
    mockGetJob.mockResolvedValue(null);
    const result = await enqueueExistingImageVariants({ apply: true });
    expect(result.queued).toBe(1);
    expect(mockAddJob).toHaveBeenCalledWith({ rawKey: 'raw/posts/u1-1-photo.jpg', rawMasterUrl: 'https://cdn.example/raw/posts/u1-1-photo.jpg',
      mediaType: 'image', postId: 'p1', ownerId: 'u1' });
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  test('skips an active job without duplicate work', async () => {
    mockGetJob.mockResolvedValue({ getState: jest.fn(async () => 'active') });
    const result = await enqueueExistingImageVariants({ apply: true });
    expect(result).toMatchObject({ queued: 0, skipped: 1 });
    expect(mockAddJob).not.toHaveBeenCalled();
  });

  test('rejects unsafe batch size', async () => {
    await expect(enqueueExistingImageVariants({ limit: 10001 })).rejects.toThrow('Limit must');
  });
});
