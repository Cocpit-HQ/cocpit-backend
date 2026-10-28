/* global jest, describe, test, expect */
// Importing the real pool starts a health check and schema updates. These room
// tests only need the handler's in-memory socket behavior.
jest.mock('../core/db/pool', () => ({ query: jest.fn() }));
const notificationHandler = require('./notification.handler');

describe('notification handler actor context rooms', () => {
  test('joins the org room when switching to an organization actor', () => {
    const joined = [];
    const left = [];
    const socket = {
      id: 'socket-1',
      join: (room) => joined.push(room),
      leave: (room) => left.push(room),
    };

    notificationHandler.applyActorContextToRooms(socket, 'ORGANIZATION', 'org-123');

    expect(joined).toContain('org_org-123');
    expect(left).not.toContain('org_org-123');
  });

  test('leaves the previous org room when switching away from an organization actor', () => {
    const joined = [];
    const left = [];
    const socket = {
      id: 'socket-2',
      join: (room) => joined.push(room),
      leave: (room) => left.push(room),
    };

    notificationHandler.applyActorContextToRooms(socket, 'ORGANIZATION', 'org-123');
    notificationHandler.applyActorContextToRooms(socket, 'USER', 'user-456');

    expect(left).toContain('org_org-123');
    expect(joined.filter((room) => room === 'org_org-123')).toHaveLength(1);
  });
});
