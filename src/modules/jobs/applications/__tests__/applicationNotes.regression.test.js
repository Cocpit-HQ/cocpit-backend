'use strict';

jest.mock('../../../../core/db/pool', () => ({
  query: jest.fn(),
}));

const pool = require('../../../../core/db/pool');
const { getApplicationDetail, upsertNote } = require('../application.queries');

describe('Application Notes (Self Note) Sharing Regression Tests [SCRUM-8, SCRUM-1831]', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getApplicationDetail - shared team note retrieval', () => {
    test('retrieves the latest note for the application regardless of author (not locked to requesting recruiter)', async () => {
      const mockAppId = '00000000-0000-0000-0000-000000000001';
      const mockRecruiterAId = '00000000-0000-0000-0000-00000000000a';

      pool.query.mockResolvedValueOnce({
        rows: [
          {
            applicationId: mockAppId,
            applicantId: 'cand-1',
            name: 'Jane Candidate',
            selfNote: 'Note updated by Team Member B',
          },
        ],
      });

      const detail = await getApplicationDetail(mockAppId, mockRecruiterAId);

      expect(pool.query).toHaveBeenCalledTimes(1);
      const [sql, params] = pool.query.mock.calls[0];

      // Verifies SQL no longer filters by an.author_id = $2
      expect(sql).not.toContain('an.author_id = $2');
      expect(sql).toContain('LEFT JOIN LATERAL');
      expect(sql).toContain('FROM application_notes');
      expect(sql).toContain('ORDER BY updated_at DESC');
      expect(params).toEqual([mockAppId]);

      expect(detail.selfNote).toBe('Note updated by Team Member B');
    });

    test('returns selfNote as null if no note exists for the application', async () => {
      const mockAppId = '00000000-0000-0000-0000-000000000002';
      const mockRecruiterId = '00000000-0000-0000-0000-00000000000b';

      pool.query.mockResolvedValueOnce({
        rows: [
          {
            applicationId: mockAppId,
            applicantId: 'cand-2',
            name: 'John Candidate',
            selfNote: null,
          },
        ],
      });

      const detail = await getApplicationDetail(mockAppId, mockRecruiterId);
      expect(detail.selfNote).toBeNull();
    });
  });

  describe('upsertNote - shared note update', () => {
    test('inserts a new note row when no note exists for the application', async () => {
      const mockAppId = '00000000-0000-0000-0000-000000000001';
      const mockMemberAId = '00000000-0000-0000-0000-00000000000a';

      // 1. SELECT check -> no existing note
      pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
      // 2. INSERT fresh note
      pool.query.mockResolvedValueOnce({
        rows: [
          {
            noteId: 'note-uuid-1',
            body: 'First note by Team Member A',
            updatedAt: new Date(),
          },
        ],
      });

      const note = await upsertNote(mockAppId, mockMemberAId, 'First note by Team Member A');

      expect(pool.query).toHaveBeenCalledTimes(2);

      const [insertSql, insertParams] = pool.query.mock.calls[1];
      expect(insertSql).toContain('INSERT INTO application_notes');
      expect(insertParams).toEqual([mockAppId, mockMemberAId, 'First note by Team Member A']);
      expect(note.body).toBe('First note by Team Member A');
    });

    test('updates existing application note when Team Member B updates note authored by Team Member A', async () => {
      const mockAppId = '00000000-0000-0000-0000-000000000001';
      const mockMemberBId = '00000000-0000-0000-0000-00000000000b';

      // 1. SELECT check -> existing note found (previously created by Member A)
      pool.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ note_id: 'note-uuid-1' }],
      });
      // 2. DELETE duplicate cleanup
      pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
      // 3. UPDATE note
      pool.query.mockResolvedValueOnce({
        rows: [
          {
            noteId: 'note-uuid-1',
            body: 'Note updated by Team Member B',
            updatedAt: new Date(),
          },
        ],
      });

      const note = await upsertNote(mockAppId, mockMemberBId, 'Note updated by Team Member B');

      expect(pool.query).toHaveBeenCalledTimes(3);

      // Verify DELETE cleanup was executed for non-primary rows
      const [deleteSql, deleteParams] = pool.query.mock.calls[1];
      expect(deleteSql).toContain('DELETE FROM application_notes');
      expect(deleteParams).toEqual([mockAppId, 'note-uuid-1']);

      // Verify UPDATE was executed on existing note
      const [updateSql, updateParams] = pool.query.mock.calls[2];
      expect(updateSql).toContain('UPDATE application_notes');
      expect(updateSql).toContain('SET body = $1, author_id = $2, updated_at = now()');
      expect(updateParams).toEqual(['Note updated by Team Member B', mockMemberBId, 'note-uuid-1']);

      expect(note.body).toBe('Note updated by Team Member B');
    });
  });
});
