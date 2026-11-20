'use strict';

const { logOrgActivity, logAudit } = require('../../../core/infrastructure/audit.service');

describe('SCRUM-1104 / SCRUM-1832: Team Job Audit Logs Regression Tests', () => {

  describe('1. Audit Service & logOrgActivity Helper', () => {
    test('TC-01: logOrgActivity inserts into audit_logs and notifies org socket room', async () => {
      const mockClient = {
        query: jest.fn().mockResolvedValue({ rowCount: 1, rows: [] })
      };

      const socketService = require('../../../core/infrastructure/socket.service');
      const notifyOrgSpy = jest.spyOn(socketService, 'notifyOrg').mockImplementation(() => {});

      await logOrgActivity(mockClient, {
        orgId: 'org-uuid-1',
        userId: 'user-uuid-1',
        action: 'CREATE_JOB',
        metadata: {
          targetType: 'job',
          targetId: 'job-uuid-1',
          targetName: 'DevOps Engineer',
          jobId: 'job-uuid-1',
          jobTitle: 'DevOps Engineer',
          linkUrl: '/jobs/job-uuid-1'
        },
        req: {
          actor: {
            roleName: 'Recruiter',
            roleId: 'role-uuid-recruiter'
          }
        }
      });

      expect(mockClient.query).toHaveBeenCalled();
      const insertCall = mockClient.query.mock.calls.find(call => 
        typeof call[0] === 'string' && call[0].includes('INSERT INTO audit_logs')
      );
      expect(insertCall).toBeDefined();

      const [sql, params] = insertCall;
      expect(params[0]).toBe('ORGANIZATION'); // entity_type
      expect(params[1]).toBe('org-uuid-1');    // entity_id
      expect(params[2]).toBe('user-uuid-1');   // actor_id
      expect(params[3]).toBe('Recruiter');     // actor_role
      expect(params[4]).toBe('CREATE_JOB');    // action
      expect(params[5]).toMatchObject({
        targetType: 'job',
        targetId: 'job-uuid-1',
        targetName: 'DevOps Engineer',
        jobId: 'job-uuid-1',
        jobTitle: 'DevOps Engineer',
        linkUrl: '/jobs/job-uuid-1',
        roleId: 'role-uuid-recruiter',
        roleName: 'Recruiter'
      });

      expect(notifyOrgSpy).toHaveBeenCalledWith('org-uuid-1', 'activity_updated', expect.objectContaining({
        action: 'CREATE_JOB',
        targetType: 'job'
      }));

      notifyOrgSpy.mockRestore();
    });

    test('TC-02: logOrgActivity ignores personal operations (no orgId)', async () => {
      const mockClient = {
        query: jest.fn()
      };

      await logOrgActivity(mockClient, {
        orgId: null,
        userId: 'user-uuid-1',
        action: 'CREATE_JOB',
        metadata: {}
      });

      expect(mockClient.query).not.toHaveBeenCalled();
    });
  });

  describe('2. Source Code Contract Verifications', () => {
    const fs = require('fs');
    const path = require('path');

    test('TC-03: job.controller.js imports logOrgActivity and logs CREATE_JOB, CLOSE_JOB, DELETE_JOB', () => {
      const source = fs.readFileSync(path.resolve(__dirname, '../job.controller.js'), 'utf8');

      expect(source).toContain('logOrgActivity');
      expect(source).toContain("action: 'CREATE_JOB'");
      expect(source).toContain("action: 'CLOSE_JOB'");
      expect(source).toContain("action: 'DELETE_JOB'");
    });

    test('TC-04: application.controller.js logs SHORTLIST_APPLICATION and DECLINE_APPLICATION', () => {
      const source = fs.readFileSync(
        path.resolve(__dirname, '../applications/application.controller.js'),
        'utf8'
      );

      expect(source).toContain('logOrgActivity');
      expect(source).toContain("action = isShortlist ? 'SHORTLIST_APPLICATION' : 'DECLINE_APPLICATION'");
    });

    test('TC-05: offer.controller.js logs SEND_OFFER for org jobs', () => {
      const source = fs.readFileSync(path.resolve(__dirname, '../offer.controller.js'), 'utf8');

      expect(source).toContain('logOrgActivity');
      expect(source).toContain("action: 'SEND_OFFER'");
      expect(source).toContain('targetOrgId');
    });

    test('TC-06: organization.jobs.controller.js standardizes to CREATE_JOB, CLOSE_JOB, and DELETE_JOB', () => {
      const source = fs.readFileSync(
        path.resolve(__dirname, '../../organization/organization.jobs.controller.js'),
        'utf8'
      );

      expect(source).toContain('logOrgActivity');
      expect(source).toContain("action: 'CREATE_JOB'");
      expect(source).toContain("const auditAction = isDeleteAction ? 'DELETE_JOB' : isCloseAction ? 'CLOSE_JOB' : isSubmittingForReview ? 'CREATE_JOB' : 'UPDATE_JOB'");
    });

    test('TC-07: organization.teams.controller.js resolves jobTitle and handles job keyword search', () => {
      const source = fs.readFileSync(
        path.resolve(__dirname, '../../organization/organization.teams.controller.js'),
        'utf8'
      );

      expect(source).toContain("al.metadata->>'jobTitle'");
      expect(source).toContain("al.action IN ('CREATE_JOB', 'CLOSE_JOB', 'DELETE_JOB', 'SEND_OFFER', 'SHORTLIST_APPLICATION', 'DECLINE_APPLICATION'");
    });
  });
});
