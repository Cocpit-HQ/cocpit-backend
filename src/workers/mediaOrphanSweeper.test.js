/* global jest */
const { describe, expect, test, beforeEach } = require('@jest/globals');
const mockClient = { query: jest.fn(), release: jest.fn() };
jest.mock('../core/db/pool', () => ({ connect: jest.fn(async () => mockClient) }));
jest.mock('../core/infrastructure/r2.client', () => ({
  listR2Objects: jest.fn(),
  deleteObjectsFromR2: jest.fn(),
}));
const { listR2Objects, deleteObjectsFromR2 } = require('../core/infrastructure/r2.client');
const { sweepOrphanedMedia } = require('./mediaOrphanSweeper');

describe('R2 orphan scanner', () => {
  const now = new Date('2026-10-28T12:00:00Z');
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.R2_PUBLIC_URL = 'https://cdn.example';
    mockClient.query.mockImplementation(async (sql) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
      if (sql.includes('FROM post_media')) return { rows: [{ master_url: 'https://cdn.example/raw/posts/keep.jpg', hdr_manifest_url: 'https://cdn.example/display/videos/keep/hdr/master.m3u8', variants: { avif: [{ width: 480, url: 'https://cdn.example/display/posts/keep-w480.avif' }] } }] };
      if (sql.includes('FROM users')) return { rows: [{ avatar_url: 'https://cdn.example/avatars/keep.jpg' }] };
      if (sql.includes('FROM job_applications')) return { rows: [{ resume_url: 'https://cdn.example/resumes/keep.pdf' }] };
      if (sql.includes('FROM project_media')) return { rows: [{ url: 'https://cdn.example/display/posts/project.jpg' }] };
      return { rows: [] };
    });
    listR2Objects.mockImplementation(async (prefix) => ({ Contents: [
      { Key: `${prefix}new.jpg`, LastModified: new Date('2026-10-28T11:00:00Z') },
      { Key: `${prefix}orphan.jpg`, LastModified: new Date('2026-10-20T11:00:00Z') },
      ...(prefix === 'raw/posts/' ? [{ Key: 'raw/posts/keep.jpg', LastModified: new Date('2026-10-20T11:00:00Z') }] : []),
      ...(prefix === 'display/posts/' ? [{ Key: 'display/posts/keep-w480.avif', LastModified: new Date('2026-10-20T11:00:00Z') }] : []),
      ...(prefix === 'display/posts/' ? [{ Key: 'display/posts/project.jpg', LastModified: new Date('2026-10-20T11:00:00Z') }] : []),
      ...(prefix === 'avatars/' ? [{ Key: 'avatars/keep.jpg', LastModified: new Date('2026-10-20T11:00:00Z') }] : []),
      ...(prefix === 'resumes/' ? [{ Key: 'resumes/keep.pdf', LastModified: new Date('2026-10-20T11:00:00Z') }] : []),
      ...(prefix === 'display/videos/' ? [{ Key: 'display/videos/keep/hdr/720p_00001.m4s', LastModified: new Date('2026-10-20T11:00:00Z') }] : []),
    ] }));
  });

  test('deletes only unreferenced objects older than the grace period', async () => {
    const result = await sweepOrphanedMedia({ now });
    expect(result.deleted).toBe(6);
    expect(deleteObjectsFromR2).toHaveBeenCalledWith([
      'raw/posts/orphan.jpg', 'display/posts/orphan.jpg', 'display/videos/orphan.jpg', 'avatars/orphan.jpg', 'covers/orphan.jpg', 'resumes/orphan.jpg',
    ]);
    expect(mockClient.release).toHaveBeenCalled();
  });

  test('never deletes when the reference query fails', async () => {
    mockClient.query.mockImplementationOnce(async () => ({ rows: [{ locked: true }] }))
      .mockRejectedValueOnce(new Error('database unavailable'));
    await expect(sweepOrphanedMedia({ now })).rejects.toThrow('database unavailable');
    expect(deleteObjectsFromR2).not.toHaveBeenCalled();
    expect(mockClient.release).toHaveBeenCalled();
  });

  test('dry run reports candidates without deleting', async () => {
    const result = await sweepOrphanedMedia({ now, dryRun: true });
    expect(result.candidates).toBe(6);
    expect(deleteObjectsFromR2).not.toHaveBeenCalled();
  });

  test('aborts on a truncated R2 listing without a continuation token', async () => {
    listR2Objects.mockResolvedValueOnce({ IsTruncated: true, Contents: [] });
    await expect(sweepOrphanedMedia({ now })).rejects.toThrow('continuation token');
    expect(deleteObjectsFromR2).not.toHaveBeenCalled();
  });
});
