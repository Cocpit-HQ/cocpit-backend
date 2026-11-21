'use strict';

jest.mock('../profile.repository', () => ({
  updateIdentity: jest.fn(),
  ensureProfileId: jest.fn(),
}));

const profileRepo = require('../profile.repository');
const profileController = require('../profile.controller');

describe('Profile Controller - updateIdentity Regression Tests', () => {
  let mockReq;
  let mockRes;

  beforeEach(() => {
    jest.clearAllMocks();
    mockReq = {
      user: { sub: '00000000-0000-0000-0000-000000000001' },
      body: {},
    };
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
  });

  test('accepts "Full Time" (space, no hyphen) and canonicalizes to "Full-time"', async () => {
    mockReq.body = {
      open_to: 'Full Time',
      availability: null,
    };

    profileRepo.updateIdentity.mockResolvedValueOnce({
      profile_id: 'pid-1',
      open_to: 'Full-time',
      availability: null,
      work_preference: null,
    });

    await profileController.updateIdentity(mockReq, mockRes);

    expect(profileRepo.updateIdentity).toHaveBeenCalledWith(
      '00000000-0000-0000-0000-000000000001',
      expect.objectContaining({
        open_to: 'Full-time',
        availability: null,
      })
    );
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Professional identity updated successfully',
      })
    );
  });

  test('accepts "Full-time" (hyphenated) and saves "Full-time" with empty availability', async () => {
    mockReq.body = {
      open_to: 'Full-time',
      availability: '',
    };

    profileRepo.updateIdentity.mockResolvedValueOnce({
      profile_id: 'pid-1',
      open_to: 'Full-time',
      availability: null,
      work_preference: null,
    });

    await profileController.updateIdentity(mockReq, mockRes);

    expect(profileRepo.updateIdentity).toHaveBeenCalledWith(
      '00000000-0000-0000-0000-000000000001',
      expect.objectContaining({
        open_to: 'Full-time',
        availability: null,
      })
    );
  });

  test('accepts numeric ID 1 for looking_for and resolves to "Full-time"', async () => {
    mockReq.body = {
      open_to: 1,
      availability: undefined,
    };

    profileRepo.updateIdentity.mockResolvedValueOnce({
      profile_id: 'pid-1',
      open_to: 'Full-time',
      availability: null,
      work_preference: null,
    });

    await profileController.updateIdentity(mockReq, mockRes);

    expect(profileRepo.updateIdentity).toHaveBeenCalledWith(
      '00000000-0000-0000-0000-000000000001',
      expect.objectContaining({
        open_to: 'Full-time',
        availability: null,
      })
    );
  });

  test('rejects truly invalid open_to values with 400', async () => {
    mockReq.body = {
      open_to: 'Astronaut',
    };

    await profileController.updateIdentity(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith({ message: 'Invalid open_to value' });
    expect(profileRepo.updateIdentity).not.toHaveBeenCalled();
  });
});
