/* global jest */
const { describe, expect, test, beforeEach } = require('@jest/globals');
const mockClient = { query: jest.fn(), release: jest.fn() };
jest.mock('../../core/db/pool', () => ({ connect: jest.fn(async () => mockClient) }));
const profileRepo = require('./profile.repository');

describe('profile media replacement transactions', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns the previous avatar URL after committing the new one', async () => {
    mockClient.query.mockImplementation(async (sql) => sql.includes('SELECT avatar_url')
      ? { rows: [{ avatar_url: 'https://cdn.example/avatars/old.jpg' }] } : { rows: [] });
    const old = await profileRepo.updateAvatarUrl('user-id', 'https://cdn.example/avatars/new.jpg');
    expect(old).toBe('https://cdn.example/avatars/old.jpg');
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    expect(mockClient.release).toHaveBeenCalled();
  });

  test('replaces a resume atomically and returns the old URL for cleanup', async () => {
    mockClient.query.mockImplementation(async (sql) => {
      if (sql.includes('DELETE FROM user_resumes')) return { rows: [{ file_url: 'https://cdn.example/resumes/old.pdf' }] };
      if (sql.includes('INSERT INTO user_resumes')) return { rows: [{ file_url: 'https://cdn.example/resumes/new.pdf' }] };
      return { rows: [] };
    });
    const result = await profileRepo.replaceResume('user-id', {
      originalname: 'new.pdf', path: 'https://cdn.example/resumes/new.pdf', mimetype: 'application/pdf', size: 50,
    });
    expect(result.previousUrls).toEqual(['https://cdn.example/resumes/old.pdf']);
    expect(result.resume.file_url).toBe('https://cdn.example/resumes/new.pdf');
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
  });

  test('rolls back if inserting the replacement resume fails', async () => {
    mockClient.query.mockImplementation(async (sql) => {
      if (sql.includes('INSERT INTO user_resumes')) throw new Error('insert failed');
      return { rows: [] };
    });
    await expect(profileRepo.replaceResume('user-id', { originalname: 'new.pdf', path: 'new', mimetype: 'application/pdf', size: 50 }))
      .rejects.toThrow('insert failed');
    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    expect(mockClient.release).toHaveBeenCalled();
  });
});
